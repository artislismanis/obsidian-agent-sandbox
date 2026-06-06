import { browser, expect } from "@wdio/globals";
import { describe, it, before, after } from "mocha";
import { obsidianPage } from "wdio-obsidian-service";
import { execSync } from "child_process";
import { writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import {
	isDockerAvailable,
	isImageBuilt,
	containerUp,
	containerDown,
	waitForHealth,
	TTYD_PORT,
	MCP_PORT,
	MCP_TOKEN,
} from "../../integration/helpers";

// Bridge C2 — the host↔container MCP round-trip. The REAL plugin (in
// wdio-Obsidian) runs its MCP server bound to 0.0.0.0; a live `oas-test`
// container's curl/node reaches it via host.docker.internal:host-gateway. This
// is the one piece with no prior coverage (integration tests the host server
// over loopback with a mock app, and container DNS separately, but never the
// connection). Lives outside test/e2e/specs/ so the fast Docker-free e2e suite
// never imports Docker; run via `npm run test:e2e:bridge`.

const dockerReady = isDockerAvailable() && isImageBuilt();
const CONTAINER = "oas-test-sandbox";

/** Configure the host plugin's MCP server to be reachable from the container. */
async function configureHostMcp(token: string): Promise<void> {
	await browser.executeObsidian(
		async ({ app }, { port, tok }) => {
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
			s.mcpToken = tok;
			// 0.0.0.0 so the container can reach it via host.docker.internal;
			// 127.0.0.1 (the default) is host-only and unreachable from a container.
			s.mcpBindAddress = "0.0.0.0";
			await plugin.restartMcpIfRunning();
		},
		{ port: MCP_PORT, tok: token },
	);
}

/** POST an MCP initialize from inside the container; return HTTP status. */
function initStatusFromContainer(token: string): number {
	const body = JSON.stringify({
		jsonrpc: "2.0",
		id: 1,
		method: "initialize",
		params: {
			protocolVersion: "2025-03-26",
			capabilities: {},
			clientInfo: { name: "bridge-container", version: "1.0" },
		},
	});
	const out = execSync(
		`echo '${body}' | docker exec -i ${CONTAINER} curl -s -m 8 -o /dev/null -w '%{http_code}' ` +
			`-X POST -H 'Authorization: Bearer ${token}' -H 'Content-Type: application/json' ` +
			`-H 'Accept: application/json, text/event-stream' --data @- ` +
			`http://host.docker.internal:${MCP_PORT}/mcp`,
		{ encoding: "utf-8", timeout: 20000 },
	);
	return Number(out.trim());
}

(dockerReady ? describe : describe.skip)("Bridge C2: host↔container MCP round-trip", function () {
	before(async function () {
		this.timeout(180000);
		await obsidianPage.resetVault();
		containerUp();
		await waitForHealth(`http://127.0.0.1:${TTYD_PORT}/`, 60000);
		await configureHostMcp(MCP_TOKEN);
	});

	after(function () {
		this.timeout(60000);
		containerDown();
	});

	// QA plan 3.x: the container reaches the plugin's MCP server with the
	// correct token — the previously-unproven host↔container hop.
	it("accepts an authenticated initialize from the container (200)", function () {
		this.timeout(30000);
		expect(initStatusFromContainer(MCP_TOKEN)).toBe(200);
	});

	// QA plan 3.6: a wrong token is rejected at the server (not silently served).
	it("rejects a wrong token from the container (401)", function () {
		this.timeout(30000);
		expect(initStatusFromContainer("definitely-the-wrong-token")).toBe(401);
	});

	// Full round-trip: a tool call from the container runs against the HOST
	// plugin's open vault and returns real content (not the proxy's empty stub).
	it("runs a vault tool end-to-end from the container", async function () {
		this.timeout(30000);
		const probe = join(tmpdir(), "oas-bridge-probe.mjs");
		writeFileSync(
			probe,
			`
import http from "node:http";
const PORT = process.env.OAS_MCP_PORT, TOKEN = process.env.OAS_MCP_TOKEN, HOST = "host.docker.internal";
function post(body, sid) {
  return new Promise((res, rej) => {
    const data = JSON.stringify(body);
    const headers = { "Content-Type": "application/json", Accept: "application/json, text/event-stream", Authorization: "Bearer " + TOKEN };
    if (sid) headers["Mcp-Session-Id"] = sid;
    const req = http.request({ hostname: HOST, port: PORT, path: "/mcp", method: "POST", headers }, (r) => {
      let b = ""; r.on("data", (c) => (b += c)); r.on("end", () => res({ status: r.statusCode, sid: r.headers["mcp-session-id"], body: b }));
    });
    req.on("error", rej); req.write(data); req.end();
  });
}
const init = await post({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-03-26", capabilities: {}, clientInfo: { name: "probe", version: "1" } } });
const list = await post({ jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "vault_list", arguments: {} } }, init.sid);
console.log(JSON.stringify({ initStatus: init.status, listStatus: list.status, listBody: list.body }));
`,
		);
		execSync(`docker cp ${probe} ${CONTAINER}:/tmp/probe.mjs`, { timeout: 15000 });
		const out = execSync(
			`docker exec -e OAS_MCP_PORT=${MCP_PORT} -e OAS_MCP_TOKEN=${MCP_TOKEN} ${CONTAINER} node /tmp/probe.mjs`,
			{ encoding: "utf-8", timeout: 20000 },
		);
		const result = JSON.parse(out.trim()) as {
			initStatus: number;
			listStatus: number;
			listBody: string;
		};
		expect(result.initStatus).toBe(200);
		expect(result.listStatus).toBe(200);
		// vault_list runs against the HOST plugin's open vault (the wdio fixture),
		// proving the container's call reached the real plugin, not a stub.
		expect(result.listBody).toContain("Welcome.md");
	});
});
