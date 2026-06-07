import { describe, it, expect } from "vitest";
import { spawn } from "node:child_process";
import { resolve } from "node:path";

// QA plan 3.12 — the obsidian-mcp-proxy emits exactly ONE diagnostic stderr line
// per unreachable burst (not one per request), the line carries no bearer token,
// and it names the resolved host/port + reason.
//
// This drives the proxy script directly (pure Node, no container): point it at a
// dead port with a token set, feed two JSON-RPC requests, and assert the stderr.
// Not gated on Docker — it never touches the container.

const PROXY = resolve(__dirname, "../../../workspace/.claude/scripts/obsidian-mcp-proxy.js");
const TOKEN = "secret-burst-token-3p12";

/** Run the proxy with a dead upstream, feed it requests, resolve its stderr. */
function runProxyAgainstDeadPort(requests: object[]): Promise<{ stderr: string; stdout: string }> {
	return new Promise((resolvePromise, reject) => {
		const child = spawn("node", [PROXY], {
			env: {
				...process.env,
				OAS_MCP_TOKEN: TOKEN,
				OAS_MCP_HOST: "127.0.0.1",
				// Almost certainly closed → ECONNREFUSED on probe.
				OAS_MCP_PORT: "59997",
			},
			stdio: ["pipe", "pipe", "pipe"],
		});
		let stderr = "";
		let stdout = "";
		child.stderr.on("data", (d) => (stderr += d.toString()));
		child.stdout.on("data", (d) => (stdout += d.toString()));
		child.on("error", reject);
		child.on("close", () => resolvePromise({ stderr, stdout }));

		for (const r of requests) child.stdin.write(JSON.stringify(r) + "\n");
		child.stdin.end(); // EOF → proxy drains and exits 0
	});
}

describe("obsidian-mcp-proxy diagnostics (QA 3.12)", () => {
	it("emits exactly one diagnostic per unreachable burst, with no token", async () => {
		const { stderr, stdout } = await runProxyAgainstDeadPort([
			{
				jsonrpc: "2.0",
				id: 1,
				method: "initialize",
				params: {
					protocolVersion: "2025-03-26",
					capabilities: {},
					clientInfo: { name: "t", version: "1" },
				},
			},
			{ jsonrpc: "2.0", id: 2, method: "tools/list", params: {} },
		]);

		const diagnostics = stderr
			.split("\n")
			.filter((l) => l.includes("[obsidian-mcp-proxy] unreachable"));

		// Burst suppression: two requests, exactly one diagnostic line.
		expect(diagnostics).toHaveLength(1);
		// Names the resolved host/port + a structured reason.
		expect(diagnostics[0]).toContain("host=127.0.0.1");
		expect(diagnostics[0]).toContain("port=59997");
		expect(diagnostics[0]).toContain("reason=ECONNREFUSED");
		// Security: the bearer token must never appear in diagnostics.
		expect(stderr).not.toContain(TOKEN);
		// Graceful degradation: the client still gets a (empty) tools list.
		expect(stdout).toContain('"tools":[]');
	});
});
