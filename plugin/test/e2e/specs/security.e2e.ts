import { browser, expect } from "@wdio/globals";
import { describe, it, before, after } from "mocha";
import { obsidianPage } from "wdio-obsidian-service";
import { promises as fs } from "node:fs";
import * as path from "node:path";
import { mcpInitialize, mcpCallTool, type McpSession } from "../mcp-client";

// Stage 7 (symlink / path-traversal) driven against the REAL plugin MCP server
// inside wdio-Obsidian — the bridge layer's Docker-free tier. Symlinks resolve
// on the host filesystem where the plugin runs, so no container is needed: we
// create symlink fixtures in the ephemeral vault with node fs, then call the
// real vault_read / vault_create tools over loopback and assert the realpath
// guard (`isVaultPathSafe` / `validateNewVaultPath`) holds over the wire.
//
// Covers the denial cases 7.1-7.3 (the security-critical guarantees). The 7.4
// allow-path is unit-only — see the note in `before` and mcp-symlink.test.ts.
//
// This is the e2e replacement for the T7 section of the (removed) host script
// container/test-scripts/security-checks.sh. The realpath logic itself is
// unit-tested in mcp-symlink.test.ts; this layer adds real-filesystem
// resolution through the live MCP server.

const SEC_MCP_PORT = 39081; // distinct from the 28080 default and the bridge spec's 39080
const SEC_MCP_TOKEN = "security-e2e-token";
const WRITE_DIR = "agent-workspace"; // DEFAULT_SETTINGS.vaultWriteDir

/** Enable the plugin's MCP server at a fixed port/token (read + writeScoped are always on). */
async function startMcp(): Promise<void> {
	await browser.executeObsidian(
		async ({ app }, { port, token }) => {
			const plugin = (
				app as unknown as {
					plugins: {
						plugins: Record<
							string,
							{
								settings: Record<string, unknown>;
								restartMcpIfRunning: () => Promise<void>;
							}
						>;
					};
				}
			).plugins.plugins["obsidian-agent-sandbox"];
			const s = plugin.settings;
			s.mcpEnabled = true;
			s.mcpPort = port;
			s.mcpToken = token;
			s.mcpBindAddress = "127.0.0.1";
			await plugin.restartMcpIfRunning();
		},
		{ port: SEC_MCP_PORT, token: SEC_MCP_TOKEN },
	);
}

/** Absolute on-disk path of the open vault (FileSystemAdapter under wdio). */
function vaultBasePath(): Promise<string> {
	return browser.executeObsidian(({ app }) => {
		const adapter = app.vault.adapter as unknown as { getBasePath?: () => string };
		return adapter.getBasePath?.() ?? "";
	});
}

describe("Bridge: Stage 7 symlink / path-traversal (real MCP server)", function () {
	let session: McpSession;
	let base: string;

	before(async function () {
		await obsidianPage.resetVault();
		await startMcp();
		base = await vaultBasePath();
		expect(base).not.toBe("");

		const wd = path.join(base, WRITE_DIR);
		await fs.mkdir(path.join(wd, "innocent"), { recursive: true });

		// 7.1: symlink escaping the vault → an absolute host file with known content.
		await fs.symlink("/etc/hosts", path.join(wd, "evil.md"));
		// 7.2: symlink to a directory outside the vault.
		await fs.symlink("/tmp", path.join(wd, "escape"));
		// 7.3: nested symlink to an outside directory.
		await fs.symlink("/tmp", path.join(wd, "innocent", "inner"));
		// 7.4 (the allow-path: a symlink resolving back inside the vault must NOT
		// be over-blocked) is covered as a unit test — mcp-symlink.test.ts "allows
		// a file whose realpath stays inside the base". It can't be exercised here:
		// vault_list/vault_read resolve via Obsidian's metadata index, which never
		// indexes a symlinked file/folder created after load, so the call fails with
		// "Folder not found" before the realpath guard is even reached — an indexing
		// artifact, not a security result. The denial cases (7.1-7.3) reach the guard
		// because resolveFile/validateNewVaultPath realpath on disk.

		session = await mcpInitialize(SEC_MCP_PORT, SEC_MCP_TOKEN);
		expect(session.sessionId).not.toBe("");
	});

	after(async function () {
		// Ephemeral vault is recreated per spec, but tidy up the fixtures anyway.
		if (!base) return;
		await fs.rm(path.join(base, WRITE_DIR), { recursive: true, force: true });
	});

	// 7.1: reading a symlink that escapes the vault is denied and leaks nothing.
	it("7.1 denies reading an escaping symlink and never leaks host content", async function () {
		const res = await mcpCallTool(session, "vault_read", { path: `${WRITE_DIR}/evil.md` });
		expect(res.isError).toBe(true);
		// /etc/hosts always contains the loopback mapping; it must not appear.
		expect(res.text).not.toContain("127.0.0.1");
		expect(res.text).not.toContain("localhost");
	});

	// 7.2: creating into a symlinked directory that points outside the vault is denied.
	it("7.2 denies creating into a symlinked-out directory", async function () {
		const res = await mcpCallTool(session, "vault_create", {
			path: `${WRITE_DIR}/escape/note.md`,
			content: "hi",
		});
		expect(res.isError).toBe(true);
		expect(res.text).toContain("resolves outside the vault");
	});

	// 7.3: the realpath check resolves through multi-level symlinks.
	it("7.3 denies reading through a nested escaping symlink", async function () {
		const res = await mcpCallTool(session, "vault_read", {
			path: `${WRITE_DIR}/innocent/inner/x.md`,
		});
		expect(res.isError).toBe(true);
	});
});
