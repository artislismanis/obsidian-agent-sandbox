import { browser, expect, $, $$ } from "@wdio/globals";
import { describe, it, before } from "mocha";
import { obsidianPage } from "wdio-obsidian-service";
import { mcpInitialize, mcpCallTool, type McpSession } from "../mcp-client";

// Bridge layer — drives the REAL plugin's MCP server (running inside the
// wdio-launched Obsidian) over loopback HTTP and asserts the resulting UI via
// executeObsidian. No container needed for these: the MCP tools act on the
// Obsidian-open vault, and the wdio worker can reach the host-bound server.
//
// Settings don't persist in this harness (the service loads the plugin
// out-of-tree), so each run configures the MCP server at runtime via
// executeObsidian + restartMcpIfRunning, which re-reads settings on start.

const BRIDGE_MCP_PORT = 39080; // distinct from the 28080 default to avoid clashes
const BRIDGE_MCP_TOKEN = "bridge-e2e-token";

interface BridgeOpts {
	navigate?: boolean;
	manage?: boolean;
	vaultWrites?: "scoped" | "reviewed" | "full";
}

/** Configure and (re)start the plugin's MCP server in the running Obsidian. */
async function startBridgeMcp(opts: BridgeOpts = {}): Promise<void> {
	await browser.executeObsidian(
		async ({ app }, { port, token, navigate, manage, vaultWrites }) => {
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
			if (navigate !== undefined) s.mcpTierNavigate = navigate;
			if (manage !== undefined) s.mcpTierManage = manage;
			if (vaultWrites !== undefined) s.mcpVaultWrites = vaultWrites;
			await plugin.restartMcpIfRunning();
		},
		{
			port: BRIDGE_MCP_PORT,
			token: BRIDGE_MCP_TOKEN,
			navigate: opts.navigate,
			manage: opts.manage,
			vaultWrites: opts.vaultWrites,
		},
	);
}

function mcpServerRunning(): Promise<boolean> {
	return browser.executeObsidian(({ app }) => {
		const plugin = (
			app as unknown as {
				plugins: { plugins: Record<string, { mcpLifecycle?: { isRunning(): boolean } }> };
			}
		).plugins.plugins["obsidian-agent-sandbox"];
		return plugin.mcpLifecycle?.isRunning() ?? false;
	});
}

function activeFilePath(): Promise<string | null> {
	return browser.executeObsidian(({ app }) => app.workspace.getActiveFile()?.path ?? null);
}

describe("Bridge C0: MCP server runs inside wdio-Obsidian", function () {
	let session: McpSession;

	before(async function () {
		await obsidianPage.resetVault();
		await startBridgeMcp({ navigate: true });
	});

	// The gate for the whole bridge layer: if the plugin's MCP server can't
	// listen inside Electron, none of C1/C2 is reachable here.
	it("starts the plugin's MCP HTTP server", async function () {
		await browser.waitUntil(async () => await mcpServerRunning(), {
			timeout: 5000,
			timeoutMsg: "plugin MCP server did not start in wdio-Obsidian",
		});
	});

	it("accepts an authenticated initialize over loopback", async function () {
		session = await mcpInitialize(BRIDGE_MCP_PORT, BRIDGE_MCP_TOKEN);
		expect(session.sessionId).not.toBe("");
	});

	// QA plan 3.5: a navigate-tier tool call changes the active tab in Obsidian.
	it("drives a real UI effect: vault_open changes the active file", async function () {
		const result = await mcpCallTool(session, "vault_open", { path: "Notes.md" });
		expect(result.text).toContain("Opened Notes.md");

		await browser.waitUntil(async () => (await activeFilePath()) === "Notes.md", {
			timeout: 5000,
			timeoutMsg: "active file did not become Notes.md after vault_open",
		});
	});
});

// ── C1: review modals driven end-to-end (no container) ──────────────────────
// A reviewed-tier write blocks on the diff modal. We fire the tool call WITHOUT
// awaiting, drive the modal via wdio, then await the call to assert the outcome.

async function readFile(path: string): Promise<string | null> {
	return browser.executeObsidian(async ({ app }, p) => {
		const f = app.vault.getFileByPath(p);
		return f ? await app.vault.read(f) : null;
	}, path);
}

/** Wait until Obsidian's metadata cache has resolved >= `count` backlinks to `target`. */
async function waitForBacklinks(target: string, count: number): Promise<void> {
	await browser.waitUntil(
		async () => {
			const n = await browser.executeObsidian(({ app }, t) => {
				const resolved = (
					app.metadataCache as unknown as {
						resolvedLinks: Record<string, Record<string, number>>;
					}
				).resolvedLinks;
				return Object.keys(resolved).filter((src) => resolved[src]?.[t]).length;
			}, target);
			return n >= count;
		},
		{ timeout: 10000, timeoutMsg: `backlinks to ${target} did not resolve` },
	);
}

describe("Bridge C1: review modals (reviewed tier, no container)", function () {
	let session: McpSession;
	const FILE = "Notes.md";
	const BASE = "line1\nline2\nline3\nline4\nline5\n";

	before(async function () {
		await obsidianPage.resetVault({ [FILE]: BASE });
		await startBridgeMcp({ vaultWrites: "reviewed", manage: true });
		session = await mcpInitialize(BRIDGE_MCP_PORT, BRIDGE_MCP_TOKEN);
	});

	// QA plan 4.1: content diff modal renders +/- lines; Approve applies the change.
	it("4.1 content diff — Approve applies the edit", async function () {
		await obsidianPage.resetVault({ [FILE]: BASE });
		const next = "line1\nline2\nEDITED\nline4\nline5\n";
		const call = mcpCallTool(session, "vault_modify_reviewed", { path: FILE, content: next });

		const approve = $("button=Approve");
		await approve.waitForExist({ timeout: 10000 });
		await expect($("pre.sandbox-diff-pre")).toBeDisplayed();
		expect((await $$(".sandbox-diff-line-added").getElements()).length).toBeGreaterThan(0);
		expect((await $$(".sandbox-diff-line-removed").getElements()).length).toBeGreaterThan(0);
		await approve.click();

		const res = await call;
		expect(res.isError).toBe(false);
		expect(res.text).toContain("Modified Notes.md");
		expect(await readFile(FILE)).toBe(next);
	});

	// QA plan 4.1 + 4.5: Reject leaves the file untouched and tells the agent.
	it("4.5 content diff — Reject leaves the file untouched", async function () {
		await obsidianPage.resetVault({ [FILE]: BASE });
		const before = await readFile(FILE);
		const call = mcpCallTool(session, "vault_modify_reviewed", {
			path: FILE,
			content: "SHOULD NOT APPLY\n",
		});

		const reject = $("button=Reject");
		await reject.waitForExist({ timeout: 10000 });
		await reject.click();

		const res = await call;
		expect(res.isError).toBe(true);
		expect(res.text).toContain("rejected by user");
		expect(await readFile(FILE)).toBe(before);
	});

	// QA plan 4.2: frontmatter set shows a JSON diff modal; Approve writes the FM.
	it("4.2 frontmatter diff — Approve sets the property", async function () {
		await obsidianPage.resetVault({ [FILE]: BASE });
		const call = mcpCallTool(session, "vault_frontmatter_set_reviewed", {
			path: FILE,
			property: "tags",
			value: ["a", "b"],
		});

		const approve = $("button=Approve");
		await approve.waitForExist({ timeout: 10000 });
		await expect($(".modal-title")).toHaveText(expect.stringContaining("Set frontmatter"));
		await approve.click();

		const res = await call;
		expect(res.isError).toBe(false);
		const content = await readFile(FILE);
		expect(content).toContain("tags:");
		expect(content).toContain("- a");
		expect(content).toContain("- b");
	});

	// QA plan 4.3: rename modal lists the affected backlinks; Approve renames the
	// file and rewrites the links.
	// QA plan 4.3: the rename modal lists the backlinks that will be rewritten.
	// We assert the modal renders "Review: Rename file" with the exact affected
	// set, then Reject (leaving files untouched). The unique value of 4.3 is the
	// affected-links rendering — the actual apply, app.fileManager.renameFile,
	// does not settle under the headless wdio harness (vault.modify / frontmatter
	// applies return fine; only renameFile hangs here), so approving it would
	// stall. The apply path itself is exercised by the unit suite.
	it("4.3 rename — affected-links list lists the backlinks", async function () {
		await obsidianPage.resetVault({
			"old.md": "# Old\n",
			"linker1.md": "See [[old]]\n",
			"linker2.md": "Also [[old]]\n",
		});
		await waitForBacklinks("old.md", 2);

		const call = mcpCallTool(session, "vault_rename", { path: "old.md", name: "new" });
		const reject = $("button=Reject");
		await reject.waitForExist({ timeout: 10000 });
		await expect($(".modal-title")).toHaveText(expect.stringContaining("Rename file"));
		const affected = (await $$(".diff-review-affected-list li").getElements()).length;
		expect(affected).toBe(2);
		await reject.click();

		const res = await call;
		expect(res.isError).toBe(true);
		expect(res.text).toContain("rejected by user");
		expect(await readFile("old.md")).not.toBeNull();
		expect(await readFile("new.md")).toBeNull();
	});

	// QA plan 4.4: batch modal lists each match with a checkbox; unchecking one
	// excludes it from "Approve selected".
	it("4.4 batch review — uncheck one, approve the rest", async function () {
		await obsidianPage.resetVault({
			"batch/a.md": "# A\n",
			"batch/b.md": "# B\n",
			"batch/c.md": "# C\n",
		});
		const call = mcpCallTool(session, "vault_batch_frontmatter", {
			folder: "batch",
			property: "status",
			value: "review",
			dryRun: false,
		});

		await browser.waitUntil(
			async () => (await $$(".batch-review-row").getElements()).length === 3,
			{ timeout: 10000, timeoutMsg: "batch review modal did not list 3 rows" },
		);
		const rows = await $$(".batch-review-row").getElements();
		const skipped = await rows[0].$("span").getText();
		await rows[0].$("input[type='checkbox']").click(); // uncheck the first
		await $("button=Approve selected").click();

		const res = await call;
		expect(res.isError).toBe(false);
		for (const p of ["batch/a.md", "batch/b.md", "batch/c.md"]) {
			const content = (await readFile(p)) ?? "";
			if (p === skipped) expect(content).not.toContain("status: review");
			else expect(content).toContain("status: review");
		}
	});
});

function sandboxPillText(): Promise<string> {
	return browser.executeObsidian(() => {
		const items = Array.from(document.querySelectorAll(".status-bar-item"));
		return items.find((e) => e.textContent?.includes("Sandbox"))?.textContent ?? "";
	});
}

describe("Bridge C1: agent activity badge (agent tier, no container)", function () {
	let session: McpSession;

	before(async function () {
		await obsidianPage.resetVault();
		await startBridgeMcp({});
		session = await mcpInitialize(BRIDGE_MCP_PORT, BRIDGE_MCP_TOKEN);
	});

	// QA plan 3.11: an awaiting-input agent status adds the 🔔 badge to the
	// sandbox status-bar pill, and it clears when the session goes idle.
	it("3.11 agent_status_set awaiting_input toggles the status-bar bell", async function () {
		const BELL = "🔔";

		const res = await mcpCallTool(session, "agent_status_set", {
			status: "awaiting_input",
			sessionName: "work",
		});
		expect(res.isError).toBe(false);

		await browser.waitUntil(async () => (await sandboxPillText()).includes(BELL), {
			timeout: 5000,
			timeoutMsg: "status-bar bell did not appear after awaiting_input",
		});

		await mcpCallTool(session, "agent_status_set", { status: "idle", sessionName: "work" });
		await browser.waitUntil(async () => !(await sandboxPillText()).includes(BELL), {
			timeout: 5000,
			timeoutMsg: "status-bar bell did not clear after idle",
		});
	});
});
