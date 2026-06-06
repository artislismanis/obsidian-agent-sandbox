import { describe, it, expect } from "vitest";
import { execSync } from "child_process";
import { accessSync, constants, rmSync, statSync } from "fs";
import { join } from "path";
import {
	isDockerAvailable,
	isImageBuilt,
	containerExec,
	containerExecRoot,
	containerLogs,
	TTYD_PORT,
	VAULT_DIR,
} from "./helpers";

function execSyncTrim(cmd: string): string {
	return execSync(cmd, { stdio: "pipe" }).toString().trim();
}

const SKIP = !isDockerAvailable();
const SKIP_NO_IMAGE = SKIP || !isImageBuilt();

describe.skipIf(SKIP)("Container prerequisites", () => {
	it("Docker daemon is running", () => {
		expect(isDockerAvailable()).toBe(true);
	});

	it("oas-sandbox image is built", () => {
		expect(isImageBuilt()).toBe(true);
	});
});

// Container lifecycle is managed by globalSetup.ts; we just run tests against it.
describe.skipIf(SKIP_NO_IMAGE)("Container", () => {
	// ── lifecycle / health ──
	it("is running and healthy", () => {
		expect(containerExec("echo ok")).toBe("ok");
	});

	it("ttyd responds on configured port", async () => {
		const res = await fetch(`http://127.0.0.1:${TTYD_PORT}`);
		expect(res.status).toBe(200);
	});

	it("verify.sh passes", () => {
		const output = containerExec("verify.sh");
		expect(output).toContain("Tool versions");
		expect(output).not.toContain("not found");
	});

	it("logs have no critical errors", () => {
		const logs = containerLogs();
		expect(logs).not.toContain("FATAL");
		expect(logs).not.toContain("panic");
	});

	// ── vault mounts ──
	it("vault is mounted and readable", () => {
		expect(containerExec("cat /workspace/vault/Welcome.md")).toContain("Welcome");
	});

	it("vault write directory is writable", () => {
		containerExec("touch /workspace/vault/agent-workspace/_integration_test");
		containerExec("rm /workspace/vault/agent-workspace/_integration_test");
	});

	it("vault root is not writable", () => {
		expect(() => containerExec("touch /workspace/vault/_should_fail")).toThrow();
	});

	// QA plan 3.10: a file the container writes into the bind-mounted write dir
	// must land owned by the host user (or at least host-writable) so Obsidian
	// can edit it without permission errors. uid semantics only hold on a native
	// Linux bind mount (macOS Docker Desktop / WSL drvfs remap ownership), so
	// gate on Linux — matching the QA item's "P1 on Linux" scope.
	it.skipIf(process.platform !== "linux")(
		"files the container writes are owned/editable by the host user",
		() => {
			const rel = "agent-workspace/_owner_test.md";
			const hostPath = join(VAULT_DIR, rel);
			try {
				containerExec(`sh -c 'echo agent-write > /workspace/vault/${rel}'`);
				const st = statSync(hostPath);
				// The container's claude uid is built to match the host (CLAUDE_UID,
				// default 1000). Either the uid matches, or the file is host-writable
				// — both satisfy "Obsidian can edit it".
				const uidMatches = st.uid === process.getuid?.();
				let hostWritable = false;
				try {
					accessSync(hostPath, constants.W_OK);
					hostWritable = true;
				} catch {
					hostWritable = false;
				}
				expect(uidMatches || hostWritable).toBe(true);
			} finally {
				rmSync(hostPath, { force: true });
			}
		},
	);

	// ── workspace tier (Tier 1) ──
	it("workspace tier files are visible", () => {
		expect(containerExec("test -f /workspace/CLAUDE.md && echo ok")).toBe("ok");
		expect(containerExec("test -f /workspace/.mcp.json && echo ok")).toBe("ok");
		expect(containerExec("test -f /workspace/.claude/settings.json && echo ok")).toBe("ok");
	});

	it("container/ infra is NOT visible (mount isolation)", () => {
		expect(() => containerExec("ls /workspace/container")).toThrow();
	});

	// ── env vars ──
	it("MCP env vars are injected", () => {
		expect(containerExec("bash -c 'echo $OAS_MCP_TOKEN'")).toBe("integration-test-token");
		expect(containerExec("bash -c 'echo $OAS_MCP_PORT'")).toBe("38080");
	});

	// ── Claude Code ──
	it("claude CLI is installed", () => {
		expect(containerExec("claude --version")).toMatch(/\d+\.\d+/);
	});

	// ── sudo model ──
	it("sudo is narrow (apt-get/apt only)", () => {
		const output = containerExecRoot("sudo -l -U claude");
		expect(output).toContain("/usr/bin/apt-get");
		expect(output).toContain("/usr/bin/apt");
		expect(output).not.toContain("NOPASSWD");
	});

	it("OAS_SUDO_PASSWORD env var is unset after entrypoint drops privileges", () => {
		expect(containerExec("bash -c 'echo -n ${OAS_SUDO_PASSWORD:-UNSET}'")).toBe("UNSET");
	});

	// ── Docker resource naming ──
	it("container uses the expected test name", () => {
		const name = execSyncTrim("docker inspect --format '{{.Name}}' oas-test-sandbox");
		expect(name.replace("/", "")).toBe("oas-test-sandbox");
	});

	it("image is oas-sandbox:latest", () => {
		const image = execSyncTrim("docker inspect --format '{{.Config.Image}}' oas-test-sandbox");
		expect(image).toBe("oas-sandbox:latest");
	});

	it("named volumes use expected names", () => {
		const mounts = execSyncTrim(
			"docker inspect --format '{{range .Mounts}}{{.Name}} {{end}}' oas-test-sandbox",
		);
		// claude-config is an external volume: no compose project prefix
		expect(mounts).toContain("oas-test-claude-config");
		// shell-history and user-config are compose-managed: get the oas-test project prefix
		expect(mounts).toContain("oas-test_oas-test-shell-history");
		expect(mounts).toContain("oas-test_oas-test-user-config");
	});

	it("claude binary is a symlink to the versioned native binary", () => {
		// Native self-contained install: ~/.local/bin/claude → ~/.local/share/claude/versions/<ver>/claude
		// This makes `claude update` an atomic symlink swap without needing npm or root.
		const target = containerExec("readlink -f /home/claude/.local/bin/claude");
		expect(target).toMatch(/\.local\/share\/claude\/versions\//);
	});
});
