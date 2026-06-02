import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import { spawn } from "node:child_process";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { resolve } from "node:path";
import {
	isDockerAvailable,
	isImageBuilt,
	containerExec,
	httpPost,
	httpGet,
	httpPostFull,
	parseJsonOrSse,
	mcpInitialize,
	mcpRequest,
	MCP_PORT,
	MCP_TOKEN,
	type McpSession,
} from "./helpers";

// Mock the symbols imported by code-under-test. FileSystemAdapter is the
// load-bearing one: obsidian-internals.ts does `adapter instanceof
// FileSystemAdapter` to decide whether to read basePath, and without the
// export every write-path tool throws on import. prepareFuzzySearch is used
// by vault_suggest_links; both `prepare*` returns no-match-iterator stubs.
vi.mock("obsidian", () => ({
	prepareSimpleSearch: () => () => null,
	prepareFuzzySearch: () => () => null,
	FileSystemAdapter: class {},
}));

const SKIP = !isDockerAvailable() || !isImageBuilt();

// Container lifecycle is managed by globalSetup.ts.
describe.skipIf(SKIP)("MCP server integration with container", () => {
	it("container can resolve host.docker.internal to an IPv4 address", () => {
		// Reachability of the host's MCP port is environment-dependent and
		// out of scope here; only name resolution is asserted.
		const ip = containerExec(
			`getent hosts host.docker.internal | awk '{print $1; exit}'`,
		).trim();
		expect(ip).toMatch(/^\d+\.\d+\.\d+\.\d+$/);
	});

	it("MCP token env var matches expected value inside container", () => {
		const token = containerExec("echo $OAS_MCP_TOKEN");
		expect(token).toBe(MCP_TOKEN);
	});

	it(".mcp.json is present in workspace", () => {
		const output = containerExec("cat /workspace/.mcp.json");
		const config = JSON.parse(output);
		expect(config.mcpServers).toHaveProperty("memory");
		expect(config.mcpServers).toHaveProperty("obsidian");
	});

	it("obsidian MCP config uses stdio proxy script", () => {
		const output = containerExec("cat /workspace/.mcp.json");
		const config = JSON.parse(output);
		const obsidian = config.mcpServers.obsidian;
		expect(obsidian.command).toBe("node");
		expect(obsidian.args[0]).toContain("obsidian-mcp-proxy.js");
	});

	it("memory MCP server binary is available", () => {
		const output = containerExec("which mcp-server-memory");
		expect(output).toContain("mcp-server-memory");
	});
});

describe.skipIf(SKIP)("MCP HTTP server (standalone, no Obsidian)", () => {
	// These tests start a real MCP HTTP server with a mocked App.
	// They verify the full HTTP stack works end-to-end without Obsidian.

	let stopServer: () => Promise<void>;

	beforeAll(async () => {
		const { ObsidianMcpServer } = await import("../../src/mcp-server");

		const mockApp = {
			vault: {
				getFiles: () => [],
				getMarkdownFiles: () => [],
				getFileByPath: () => null,
				read: async () => "",
				cachedRead: async () => "",
				create: async () => {},
				modify: async () => {},
				append: async () => {},
				trash: async () => {},
				createFolder: async () => {},
			},
			metadataCache: {
				getFileCache: () => null,
				getFirstLinkpathDest: () => null,
				resolvedLinks: {},
				unresolvedLinks: {},
				// VaultCache (mcp-cache.ts) wires a `resolved` listener via on()
				// and unregisters via offref(): mock the trio so server.start
				// doesn't TypeError when constructing the cache.
				on: () => ({}),
				off: () => {},
				offref: () => {},
			},
			fileManager: {
				renameFile: async () => {},
				processFrontMatter: async () => {},
			},
			workspace: {
				getLeaf: () => ({ openFile: async () => {} }),
			},
		};

		const server = new ObsidianMcpServer(mockApp as never, {
			port: MCP_PORT,
			token: MCP_TOKEN,
			enabledTiers: new Set(["read", "writeScoped"]),
			getWriteDir: () => "agent-workspace",
			toolTimeoutMs: 10_000,
			reviewTimeoutMs: 180_000,
		});

		await server.start();
		stopServer = () => server.stop();
	});

	afterAll(async () => {
		if (stopServer) await stopServer();
	});

	it("rejects unauthenticated requests", async () => {
		const res = await httpPost(`http://127.0.0.1:${MCP_PORT}/mcp`, {});
		expect(res.status).toBe(401);
	});

	it("accepts authenticated requests", async () => {
		const res = await httpPost(
			`http://127.0.0.1:${MCP_PORT}/mcp`,
			{
				jsonrpc: "2.0",
				id: 1,
				method: "initialize",
				params: {
					protocolVersion: "2025-03-26",
					capabilities: {},
					clientInfo: { name: "integration-test", version: "1.0" },
				},
			},
			{ Authorization: `Bearer ${MCP_TOKEN}` },
		);
		expect(res.status).toBe(200);
		const body = parseJsonOrSse(res.body) as { result?: unknown };
		expect(body.result).toBeDefined();
	});

	it("rejects unauthenticated requests with 401", async () => {
		// Auth runs before path routing, so an unauthenticated wrong-path
		// request never reaches the 404 code path.
		const status = await httpGet(`http://127.0.0.1:${MCP_PORT}/wrong`);
		expect(status).toBe(401);
	});

	it("returns 404 for unknown path when authenticated", async () => {
		const status = await httpGet(`http://127.0.0.1:${MCP_PORT}/wrong`, {
			Authorization: `Bearer ${MCP_TOKEN}`,
		});
		expect(status).toBe(404);
	});

	it("returns 405 for GET /mcp without session id", async () => {
		// Authenticated GET on /mcp without a session is not a valid SSE
		// stream open; the server rejects it cleanly.
		const status = await httpGet(`http://127.0.0.1:${MCP_PORT}/mcp`, {
			Authorization: `Bearer ${MCP_TOKEN}`,
		});
		// Accept the 4xx range: the SDK has historically returned 400/405/404
		// for "GET without session" depending on the transport version.
		expect(status).toBeGreaterThanOrEqual(400);
		expect(status).toBeLessThan(500);
	});
});

// No skipIf(SKIP): this suite runs in-process with a mock App and does not
// need Docker, unlike the other integration suites in this file. It lives
// here only because it reuses helpers (httpPostFull, mcpInitialize, parseJsonOrSse).
describe("stale session after MCP server restart", () => {
	// This suite verifies that a session id captured before a server restart
	// is rejected with HTTP 404 / -32001 rather than letting it fall through
	// to an uninitialized transport (which produces an opaque 400 "Bad Request:
	// Server not initialized" from the MCP SDK).
	const STALE_PORT = MCP_PORT + 5;
	const STALE_TOKEN = "stale-session-test-token";

	it("returns 404 with -32001 for a session id that existed before a restart", async () => {
		const { ObsidianMcpServer } = await import("../../src/mcp-server");

		const mockApp = {
			vault: {
				getFiles: () => [],
				getMarkdownFiles: () => [],
				getFileByPath: () => null,
				read: async () => "",
				cachedRead: async () => "",
				create: async (path: string) => ({ path, basename: path, extension: "md" }),
				modify: async () => {},
				append: async () => {},
				trash: async () => {},
				createFolder: async () => {},
				adapter: {
					exists: async () => false,
					mkdir: async () => {},
					stat: async () => ({ size: 0 }),
					rename: async () => {},
					remove: async () => {},
					append: async () => {},
				},
			},
			metadataCache: {
				getFileCache: () => null,
				getFirstLinkpathDest: () => null,
				resolvedLinks: {},
				unresolvedLinks: {},
				on: () => ({}),
				off: () => {},
				offref: () => {},
			},
			fileManager: { renameFile: async () => {}, processFrontMatter: async () => {} },
			workspace: { getLeaf: () => ({ openFile: async () => {} }) },
		};

		const makeServer = () =>
			new ObsidianMcpServer(mockApp as never, {
				port: STALE_PORT,
				token: STALE_TOKEN,
				enabledTiers: new Set(["read"]),
				getWriteDir: () => "agent-workspace",
				toolTimeoutMs: 10_000,
				reviewTimeoutMs: 180_000,
			});

		// 1. Start the server and establish a session.
		const server1 = makeServer();
		await server1.start();
		const init = await mcpInitialize(STALE_PORT, STALE_TOKEN);
		const staleSessionId = init.sessionId;
		expect(staleSessionId).toBeTruthy();

		// 2. Restart the server: all previous sessions are gone.
		await server1.stop();
		const server2 = makeServer();
		await server2.start();

		try {
			// 3. POST a tools/call with the now-stale session id.
			const res = await httpPostFull(
				`http://127.0.0.1:${STALE_PORT}/mcp`,
				{
					jsonrpc: "2.0",
					id: 2,
					method: "tools/call",
					params: { name: "vault_list_files", arguments: {} },
				},
				{ Authorization: `Bearer ${STALE_TOKEN}`, "Mcp-Session-Id": staleSessionId },
			);

			// 4. Must be 404 with code -32001.
			expect(res.status).toBe(404);
			const body = parseJsonOrSse(res.body) as { error: { code: number; message: string } };
			expect(body.error.code).toBe(-32001);
			expect(body.error.message).toMatch(/Session expired/);
		} finally {
			await server2.stop();
		}
	});
});

// Ports for the additional test servers. Offset from MCP_PORT to avoid conflicts.
const TIER_PORT_BASE = MCP_PORT + 10; // 38090–38092

function makeMockApp() {
	return {
		vault: {
			getFiles: () => [],
			getMarkdownFiles: () => [],
			getFileByPath: () => null,
			getAbstractFileByPath: () => null,
			read: async () => "",
			cachedRead: async () => "",
			// vault_create's apply reads `created.path` to detect Templater
			// `tp.file.move` relocations after the create. Return a stub TFile-
			// shaped object so the post-validate doesn't TypeError under the
			// mock (real Obsidian returns the freshly created TFile here).
			create: async (path: string) => ({ path, basename: path, extension: "md" }),
			modify: async () => {},
			append: async () => {},
			trash: async () => {},
			createFolder: async () => {},
			// Audit-log file sink (mcp-server.ts createFileAuditSink) calls
			// adapter.mkdir/.stat/.append on every tool invocation. Mock the
			// shape (matches mcp-server.test.ts:66-73).
			adapter: {
				exists: async () => false,
				mkdir: async () => undefined,
				stat: async () => ({ size: 0, type: "folder" as const, ctime: 0, mtime: 0 }),
				rename: async () => undefined,
				remove: async () => undefined,
				append: async () => undefined,
			},
		},
		metadataCache: {
			getFileCache: () => null,
			getFirstLinkpathDest: () => null,
			resolvedLinks: {},
			unresolvedLinks: {},
			// VaultCache wires a `resolved` listener via on() and unregisters
			// via offref(): mock the trio so server.start doesn't TypeError.
			on: () => ({}),
			off: () => {},
			offref: () => {},
		},
		fileManager: {
			renameFile: async () => {},
			processFrontMatter: async () => {},
		},
		workspace: {
			getLeaf: () => ({ openFile: async () => {} }),
		},
	};
}

describe.skipIf(SKIP)("MCP tools/list and tier enforcement", () => {
	// Three servers: read+writeScoped (default), read-only, all tiers.
	const stops: Array<() => Promise<void>> = [];
	let defaultSession: McpSession;
	let readOnlySession: McpSession;
	let allTiersSession: McpSession;

	beforeAll(async () => {
		const { ObsidianMcpServer } = await import("../../src/mcp-server");
		const mockApp = makeMockApp();

		const configs: [number, string[]][] = [
			[TIER_PORT_BASE, ["read", "writeScoped"]],
			[TIER_PORT_BASE + 1, ["read"]],
			[TIER_PORT_BASE + 2, ["read", "writeScoped", "writeVault", "navigate", "manage"]],
		];

		for (const [port, tiers] of configs) {
			const s = new ObsidianMcpServer(mockApp as never, {
				port,
				token: MCP_TOKEN,
				enabledTiers: new Set(tiers),
				getWriteDir: () => "agent-workspace",
				toolTimeoutMs: 10_000,
				reviewTimeoutMs: 180_000,
			});
			await s.start();
			stops.push(() => s.stop());
		}

		[defaultSession, readOnlySession, allTiersSession] = await Promise.all([
			mcpInitialize(TIER_PORT_BASE, MCP_TOKEN),
			mcpInitialize(TIER_PORT_BASE + 1, MCP_TOKEN),
			mcpInitialize(TIER_PORT_BASE + 2, MCP_TOKEN),
		]);
	});

	afterAll(async () => {
		await Promise.all(stops.map((s) => s()));
	});

	it("read+writeScoped: read tools present", async () => {
		const res = (await mcpRequest(defaultSession, "tools/list")) as {
			result: { tools: { name: string }[] };
		};
		const names = res.result.tools.map((t) => t.name);
		expect(names).toContain("vault_search");
		expect(names).toContain("vault_list");
		expect(names).toContain("vault_read");
	});

	it("read+writeScoped: writeScoped tools present", async () => {
		const res = (await mcpRequest(defaultSession, "tools/list")) as {
			result: { tools: { name: string }[] };
		};
		const names = res.result.tools.map((t) => t.name);
		expect(names).toContain("vault_create");
		expect(names).toContain("vault_modify");
		expect(names).toContain("vault_append");
	});

	it("read+writeScoped: writeVault, navigate, manage tools absent", async () => {
		const res = (await mcpRequest(defaultSession, "tools/list")) as {
			result: { tools: { name: string }[] };
		};
		const names = res.result.tools.map((t) => t.name);
		expect(names).not.toContain("vault_create_anywhere");
		expect(names).not.toContain("vault_open");
		expect(names).not.toContain("vault_rename");
		expect(names).not.toContain("vault_delete");
	});

	// Structural assertions instead of magic counts: the count of tools at each
	// tier is a property of buildTools() registrations, not a contract worth
	// freezing into a number that rots on every tool addition. Compare the
	// observed (tier of every tool) set against the enabled tier set.

	async function listToolNames(session: McpSession): Promise<string[]> {
		const res = (await mcpRequest(session, "tools/list")) as {
			result: { tools: { name: string }[] };
		};
		return res.result.tools.map((t) => t.name);
	}

	it("read+writeScoped: only read + writeScoped + the always-on capabilities tool", async () => {
		const names = await listToolNames(defaultSession);
		// Capabilities tool is always present. Then read tools and writeScoped
		// tools, but no _anywhere/_reviewed suffixed tools, no navigate/manage.
		expect(names).toContain("mcp_capabilities");
		expect(names).toContain("vault_search");
		expect(names).toContain("vault_create");
		expect(names).not.toContain("vault_create_anywhere");
		expect(names).not.toContain("vault_create_reviewed");
		expect(names).not.toContain("vault_open");
		expect(names).not.toContain("vault_rename");
		expect(names).not.toContain("vault_delete");
	});

	it("read-only: read tools + capabilities, no write/navigate/manage", async () => {
		const names = await listToolNames(readOnlySession);
		expect(names).toContain("mcp_capabilities");
		expect(names).toContain("vault_search");
		expect(names).not.toContain("vault_create");
		expect(names).not.toContain("vault_open");
		expect(names).not.toContain("vault_rename");
	});

	it("all tiers: at least one representative from each tier present", async () => {
		const names = await listToolNames(allTiersSession);
		expect(names).toContain("vault_search"); // read
		expect(names).toContain("vault_create"); // writeScoped
		expect(names).toContain("vault_create_anywhere"); // writeVault
		expect(names).toContain("vault_open"); // navigate
		expect(names).toContain("vault_rename"); // manage
		expect(names).toContain("vault_batch_frontmatter"); // manage (batch)
	});
});

describe.skipIf(SKIP)("MCP tool invocation (HTTP end-to-end)", () => {
	let session: McpSession;
	let stopServer: () => Promise<void>;

	const INVOKE_PORT = MCP_PORT + 20; // 38100

	beforeAll(async () => {
		const { ObsidianMcpServer } = await import("../../src/mcp-server");
		const server = new ObsidianMcpServer(makeMockApp() as never, {
			port: INVOKE_PORT,
			token: MCP_TOKEN,
			enabledTiers: new Set(["read", "writeScoped"]),
			getWriteDir: () => "agent-workspace",
			toolTimeoutMs: 10_000,
			reviewTimeoutMs: 180_000,
		});
		await server.start();
		stopServer = () => server.stop();
		session = await mcpInitialize(INVOKE_PORT, MCP_TOKEN);
	});

	afterAll(async () => {
		if (stopServer) await stopServer();
	});

	it("vault_list returns (no files) for empty vault", async () => {
		const res = (await mcpRequest(session, "tools/call", {
			name: "vault_list",
			arguments: {},
		})) as { result: { content: { text: string }[] } };
		expect(res.result.content[0].text).toBe("(no files)");
	});

	it("vault_search returns no matches for empty vault", async () => {
		const res = (await mcpRequest(session, "tools/call", {
			name: "vault_search",
			arguments: { query: "anything" },
		})) as { result: { content: { text: string }[] } };
		expect(res.result.content[0].text).toBe("No matches found.");
	});

	it("vault_read returns error for missing file", async () => {
		const res = (await mcpRequest(session, "tools/call", {
			name: "vault_read",
			arguments: { path: "nonexistent.md" },
		})) as { result: { content: { text: string }[]; isError: boolean } };
		expect(res.result.isError).toBe(true);
		expect(res.result.content[0].text).toBe("File not found.");
	});

	it("vault_create rejects '..' segments up-front (first layer)", async () => {
		// Exercises the upfront path-shape guard: `../escape.md` is rejected
		// with the "may not contain a '..'" message before the write-dir
		// gate fires.
		const res = (await mcpRequest(session, "tools/call", {
			name: "vault_create",
			arguments: { path: "../escape.md", content: "evil" },
		})) as { result: { content: { text: string }[]; isError: boolean } };
		expect(res.result.isError).toBe(true);
		expect(res.result.content[0].text).toMatch(/may not contain a '\.\.'/i);
	});

	it("vault_create rejects writes outside the write dir (second layer)", async () => {
		// Use a non-traversal path that's still outside the write directory
		// so we exercise the write-dir gate specifically (the upfront check
		// passes: no `..` segment, no leading slash).
		const res = (await mcpRequest(session, "tools/call", {
			name: "vault_create",
			arguments: { path: "elsewhere/escape.md", content: "evil" },
		})) as { result: { content: { text: string }[]; isError: boolean } };
		expect(res.result.isError).toBe(true);
		expect(res.result.content[0].text).toMatch(/write directory/i);
	});

	it("vault_create succeeds for path inside write directory", async () => {
		const res = (await mcpRequest(session, "tools/call", {
			name: "vault_create",
			arguments: { path: "agent-workspace/test.md", content: "hello" },
		})) as { result: { content: { text: string }[]; isError?: boolean } };
		expect(res.result.isError).toBeFalsy();
		expect(res.result.content[0].text).toContain("Created");
	});

	it("calling a tool from a disabled tier fails", async () => {
		// navigate tier is not enabled; vault_open is not registered with the MCP SDK.
		// The SDK may return a JSON-RPC error envelope OR a result with isError; either is acceptable.
		const res = (await mcpRequest(session, "tools/call", {
			name: "vault_open",
			arguments: { path: "Welcome.md" },
		})) as {
			error?: unknown;
			result?: { isError?: boolean };
		};
		const failed = res.error != null || res.result?.isError === true;
		expect(failed).toBe(true);
	});
});

// ── Proxy SSE keepalive regression tests ──────────────────────────────────────
//
// These tests spawn obsidian-mcp-proxy.js as a subprocess and point it at a
// local fake HTTP server. No Docker or Obsidian required.
//
// They verify the core invariant: the proxy times out when an upstream server
// stays completely silent, but succeeds when the server emits SSE keepalive
// comments while working on a long response.

const PROXY_SCRIPT = resolve(__dirname, "../../../workspace/.claude/scripts/obsidian-mcp-proxy.js");
// Short timeout to keep tests fast. The keepalive test sends comments every 1 s
// (well under this limit) then delivers the response at 5 s.
const PROXY_TIMEOUT_MS = 3_000;

const INIT_MSG = JSON.stringify({
	jsonrpc: "2.0",
	id: 1,
	method: "initialize",
	params: {
		protocolVersion: "2025-03-26",
		capabilities: {},
		clientInfo: { name: "proxy-test", version: "1.0" },
	},
});

/**
 * Start a fake upstream MCP server, spawn the proxy subprocess pointing at it,
 * send one JSON-RPC initialize message on stdin, and return the first JSON
 * frame the proxy writes to stdout.
 */
function runProxyOnce(
	serverBehavior: (req: IncomingMessage, res: ServerResponse) => void,
): Promise<Record<string, unknown>> {
	return new Promise((resolveP, rejectP) => {
		let settled = false;
		function settle(val?: Record<string, unknown>, err?: Error) {
			if (settled) return;
			settled = true;
			try {
				proc.kill();
			} catch {
				// kill() throws if the process already exited; ignore
			}
			server.close();
			if (err) rejectP(err);
			else resolveP(val!);
		}

		const server = createServer(serverBehavior);
		server.on("error", (err) => settle(undefined, err));

		server.listen(0, "127.0.0.1", () => {
			const { port } = server.address() as AddressInfo;

			const proc = spawn("node", [PROXY_SCRIPT], {
				env: {
					...process.env,
					OAS_MCP_HOST: "127.0.0.1",
					OAS_MCP_PORT: String(port),
					OAS_MCP_TOKEN: "proxy-test-token",
					OAS_MCP_TIMEOUT_MS: String(PROXY_TIMEOUT_MS),
				},
				stdio: ["pipe", "pipe", "pipe"],
			});

			proc.on("error", (err) => settle(undefined, err));
			proc.stdin.write(INIT_MSG + "\n");

			// Collect stdout, resolve on first complete JSON line.
			let buf = "";
			proc.stdout.on("data", (chunk: Buffer) => {
				buf += chunk.toString();
				const lines = buf.split("\n");
				for (let i = 0; i < lines.length - 1; i++) {
					const line = lines[i].trim();
					if (!line) continue;
					try {
						settle(JSON.parse(line) as Record<string, unknown>);
						return;
					} catch {
						// line is not valid JSON yet; keep buffering
					}
				}
				buf = lines[lines.length - 1];
			});

			// Guard against the test hanging if the proxy never responds.
			setTimeout(
				() => settle(undefined, new Error("runProxyOnce: no response within budget")),
				PROXY_TIMEOUT_MS + 8_000,
			);
		});
	});
}

describe("proxy handshake race: batched-stdin regression", () => {
	// Simulates a stateful upstream MCP server: allocates a session on
	// initialize, rejects non-initialize POSTs that lack Mcp-Session-Id, and
	// serves a tools/call result once the session is established.
	function statefulServer(req: IncomingMessage, res: ServerResponse) {
		let body = "";
		req.on("data", (c: Buffer) => (body += c.toString()));
		req.on("end", () => {
			let parsed: Record<string, unknown>;
			try {
				parsed = JSON.parse(body) as Record<string, unknown>;
			} catch {
				res.writeHead(400);
				res.end("bad json");
				return;
			}

			const incomingSession = req.headers["mcp-session-id"] as string | undefined;

			if (parsed.method === "initialize") {
				const sid = "test-session-123";
				res.writeHead(200, {
					"Content-Type": "application/json",
					"Mcp-Session-Id": sid,
				});
				res.end(
					JSON.stringify({
						jsonrpc: "2.0",
						id: parsed.id ?? 1,
						result: {
							protocolVersion: "2025-03-26",
							capabilities: {},
							serverInfo: { name: "fake-obsidian", version: "0.0.0" },
						},
					}),
				);
				return;
			}

			// notifications/initialized: no response needed
			if (parsed.id === undefined) {
				res.writeHead(202);
				res.end();
				return;
			}

			// Any other request without a session id → reject (the server-side
			// check that the proxy race used to trigger).
			if (!incomingSession) {
				res.writeHead(400, { "Content-Type": "application/json" });
				res.end(
					JSON.stringify({
						jsonrpc: "2.0",
						id: parsed.id ?? null,
						error: {
							code: -32600,
							message: "Missing Mcp-Session-Id; call initialize first",
						},
					}),
				);
				return;
			}

			// Session present: serve tools/call result
			res.writeHead(200, { "Content-Type": "application/json" });
			res.end(
				JSON.stringify({
					jsonrpc: "2.0",
					id: parsed.id,
					result: { content: [{ type: "text", text: "OK" }] },
				}),
			);
		});
	}

	it(
		"tools/call returns result (not error) when piped back-to-back with initialize",
		async () => {
			// This is the exact sequence notify-status.sh uses: initialize,
			// notifications/initialized, and tools/call all piped without
			// waiting for any response. Before the fix the tools/call posted
			// with sessionId=null → 400 → -32600 error frame. After the fix
			// the proxy awaits pendingInitialize before posting tools/call.
			await new Promise<void>((resolveTest, rejectTest) => {
				let settled = false;
				function settle(err?: Error) {
					if (settled) return;
					settled = true;
					try {
						proc.kill();
					} catch {
						// kill() throws if the process already exited; ignore
					}
					server.close();
					if (err) rejectTest(err);
					else resolveTest();
				}

				const server = createServer(statefulServer);
				server.on("error", (e) => settle(e));

				server.listen(0, "127.0.0.1", () => {
					const { port } = server.address() as AddressInfo;

					const proc = spawn("node", [PROXY_SCRIPT], {
						env: {
							...process.env,
							OAS_MCP_HOST: "127.0.0.1",
							OAS_MCP_PORT: String(port),
							OAS_MCP_TOKEN: "proxy-test-token",
							OAS_MCP_TIMEOUT_MS: String(PROXY_TIMEOUT_MS),
						},
						stdio: ["pipe", "pipe", "pipe"],
					});

					proc.on("error", (e) => settle(e));

					const INIT = JSON.stringify({
						jsonrpc: "2.0",
						id: 1,
						method: "initialize",
						params: {
							protocolVersion: "2025-03-26",
							capabilities: {},
							clientInfo: { name: "race-test", version: "1.0" },
						},
					});
					const NOTIF = JSON.stringify({
						jsonrpc: "2.0",
						method: "notifications/initialized",
					});
					const CALL = JSON.stringify({
						jsonrpc: "2.0",
						id: 2,
						method: "tools/call",
						params: {
							name: "agent_status_set",
							arguments: { status: "awaiting_input" },
						},
					});

					// Write all three frames without waiting: the bug scenario
					proc.stdin.write(INIT + "\n");
					proc.stdin.write(NOTIF + "\n");
					proc.stdin.write(CALL + "\n");
					proc.stdin.end();

					// Collect output and find the frame with id:2
					let buf = "";
					proc.stdout.on("data", (chunk: Buffer) => {
						buf += chunk.toString();
						const lines = buf.split("\n");
						for (let i = 0; i < lines.length - 1; i++) {
							const line = lines[i].trim();
							if (!line) continue;
							let frame: Record<string, unknown>;
							try {
								frame = JSON.parse(line) as Record<string, unknown>;
							} catch {
								continue;
							}
							if (frame.id === 2) {
								try {
									expect(
										frame.error,
										"id:2 must be a result, not an error",
									).toBeUndefined();
									expect(frame.result).toBeDefined();
									settle();
								} catch (e) {
									settle(e instanceof Error ? e : new Error(String(e)));
								}
								return;
							}
						}
						buf = lines[lines.length - 1];
					});

					setTimeout(
						() => settle(new Error("proxy race test: no id:2 frame within budget")),
						PROXY_TIMEOUT_MS + 8_000,
					);
				});
			});
		},
		PROXY_TIMEOUT_MS + 10_000,
	);
});

describe("proxy SSE keepalive: timeout regression", () => {
	it(
		"times out with an error frame when the upstream server sends no data",
		async () => {
			// The fake server accepts the TCP connection but writes nothing:
			// simulating an Obsidian plugin that stalls before sending any response.
			// The proxy's socket inactivity timer should fire after PROXY_TIMEOUT_MS
			// and produce a JSON-RPC error on stdout.
			const silentServer = (req: IncomingMessage, _res: ServerResponse) => {
				req.resume(); // drain request body; don't send any response
			};

			const frame = await runProxyOnce(silentServer);

			expect(frame.error).toBeDefined();
			expect((frame.error as { code: number }).code).toBe(-32603);
			expect((frame.error as { message: string }).message).toMatch(/did not respond within/i);
		},
		PROXY_TIMEOUT_MS + 10_000,
	);

	it("succeeds when the upstream server sends SSE keepalive comments while working", async () => {
		// The fake server responds with text/event-stream and emits keepalive
		// comments every 1 s (< PROXY_TIMEOUT_MS = 3 s) to keep the socket
		// active, then delivers the real MCP response after 5 s. The proxy
		// should wait for the response and return a result frame, not an error.
		const KEEPALIVE_INTERVAL = 1_000;
		const RESPONSE_DELAY = 5_000;

		const keepaliveServer = (req: IncomingMessage, res: ServerResponse) => {
			req.resume();
			res.writeHead(200, { "Content-Type": "text/event-stream" });

			const iv = setInterval(() => {
				if (!res.destroyed) res.write(": keepalive\n\n");
			}, KEEPALIVE_INTERVAL);

			setTimeout(() => {
				clearInterval(iv);
				if (res.destroyed) return;
				const mcpResponse = {
					jsonrpc: "2.0",
					id: 1,
					result: {
						protocolVersion: "2025-03-26",
						capabilities: {},
						serverInfo: { name: "fake-obsidian", version: "0.0.0" },
					},
				};
				res.write(`data: ${JSON.stringify(mcpResponse)}\n\n`);
				res.end();
			}, RESPONSE_DELAY);
		};

		const frame = await runProxyOnce(keepaliveServer);

		expect(frame.error).toBeUndefined();
		expect(frame.result).toBeDefined();
		expect((frame.result as { serverInfo: { name: string } }).serverInfo.name).toBe(
			"fake-obsidian",
		);
	}, 15_000); // RESPONSE_DELAY (5 s) + proxy guard (8 s) + headroom
});
