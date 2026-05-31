import { createServer } from "http";
import type { Server, IncomingMessage, ServerResponse } from "http";
import type { App } from "obsidian";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { McpError } from "@modelcontextprotocol/sdk/types.js";
import { randomUUID, timingSafeEqual } from "crypto";
import type {
	PermissionTier,
	McpToolDef,
	McpToolResult,
	PathFilter,
	ReviewFn,
	ReviewBatchFn,
	AgentStatus,
	OnActivity,
} from "./mcp-tools";
import { buildTools } from "./mcp-tools";
import { VaultCache } from "./mcp-cache";
import { logger, errMsg } from "./logger";
import { ALWAYS_ON_TIERS, GATED_TIERS } from "./permission-tiers";
import { RateLimiter } from "./mcp-rate-limiter";
import { AuditLog, createFileAuditSink } from "./mcp-audit";
import type { AuditEntry } from "./mcp-audit";
export type { AuditEntry } from "./mcp-audit";
export { startSseKeepalive } from "./mcp-sse";
import { startSseKeepalive } from "./mcp-sse";
// eslint-disable-next-line @typescript-eslint/no-require-imports
const manifest = require("../manifest.json") as { version: string };

export interface ActivityEntry {
	status: AgentStatus;
	detail?: string;
	updatedAt: number;
}

const ACTIVITY_STALE_MS = 10 * 60_000;
// Cap the activity map so a buggy/malicious agent calling agent_status_set
// with random session names can't grow it unbounded. Map preserves insertion
// order — when at cap, drop the oldest entry to make room for the new one.
const MAX_ACTIVITY_ENTRIES = 200;

export interface McpServerHooks {
	/** Fired on writes when the reviewed tier is enabled — presents a diff modal. */
	review?: ReviewFn;
	/** Fired on batch writes (vault_batch_frontmatter) when review is enabled. */
	reviewBatch?: ReviewBatchFn;
	/** Called on every `agent_status_set` tool invocation. */
	onActivity?: OnActivity;
}

export interface McpServerConfig {
	port: number;
	/** IP to bind the HTTP server to. Defaults to "127.0.0.1" — host-only.
	 *  Set to the docker bridge gateway (or 0.0.0.0) to let the sandbox
	 *  container reach the host via host.docker.internal. */
	bindAddress?: string;
	token: string;
	enabledTiers: Set<PermissionTier>;
	getWriteDir: () => string;
	pathFilter?: PathFilter;
	hooks?: McpServerHooks;
	toolTimeoutMs: number;
	reviewTimeoutMs: number;
}

const SESSION_TIMEOUT_MS = 10 * 60_000;
const MAX_BODY_BYTES = 1024 * 1024;
const MAX_RESPONSE_BYTES = 512_000;
const MAX_RESPONSE_TOTAL_BYTES = 1024 * 1024;
const RATE_LIMIT_READ = 60;
const RATE_LIMIT_WRITE = 20;
const AUDIT_MAX_ENTRIES = 200;

// ── MCP server ───────────────────────────────────────

export class ObsidianMcpServer {
	private httpServer: Server | null = null;
	private transports = new Map<string, StreamableHTTPServerTransport>();
	// Track per-session McpServer SDK instances so .close() can run when the
	// transport drops. Otherwise every new session leaks an McpServer for
	// the life of the plugin — small per session, unbounded over time.
	private mcpServers = new Map<string, McpServer>();
	private sessionTimeouts = new Map<string, ReturnType<typeof setTimeout>>();
	private app: App;
	private config: McpServerConfig;
	private tools: McpToolDef[] = [];
	private startTime = 0;
	private rateLimiter = new RateLimiter(RATE_LIMIT_READ, RATE_LIMIT_WRITE);
	private auditLog = new AuditLog(AUDIT_MAX_ENTRIES);
	private cache: VaultCache | null = null;
	private activity = new Map<string, ActivityEntry>();
	// Saved listener reference so stop() can detach it explicitly. Otherwise
	// the listener's closure pins `this` (and the tools/audit/cache tree)
	// to the still-attached HTTP server until GC — across plugin
	// enable/disable cycles this leaks slowly.
	private clientErrorListener: ((err: Error) => void) | null = null;

	constructor(app: App, config: McpServerConfig) {
		this.app = app;
		this.config = config;
	}

	async start(): Promise<void> {
		if (this.httpServer) return;

		// Build everything locally first; only commit to instance state after
		// listen() succeeds, otherwise a port-bind failure leaves cache/sink/
		// tools wired up against a server that never started.
		const cache = new VaultCache(this.app.metadataCache);
		const hooks = this.config.hooks ?? {};
		const tools = buildTools({
			app: this.app,
			getWriteDir: this.config.getWriteDir,
			pathFilter: this.config.pathFilter,
			review: hooks.review,
			reviewBatch: hooks.reviewBatch,
			cache,
			onActivity: (update) => this.recordActivity(update),
			enabledTiers: this.config.enabledTiers,
		}).filter((t) => this.config.enabledTiers.has(t.tier));

		const httpServer = createServer((req, res) => {
			this.handleRequest(req, res).catch((err) => {
				logger.error("MCP", "Unhandled error in request handler", err);
				if (!res.headersSent) {
					res.writeHead(500, { "Content-Type": "application/json" });
					res.end(JSON.stringify({ error: "Internal server error" }));
				}
			});
		});

		const clientErrorListener = (err: Error): void => {
			logger.warn("MCP", "Client error", err.message);
		};
		httpServer.on("clientError", clientErrorListener);

		// Default 127.0.0.1 — host-only. Production uses the user-configured
		// value via plugin settings; users who need container-side access must
		// explicitly bind to the docker bridge gateway (or 0.0.0.0).
		const bind = this.config.bindAddress || "127.0.0.1";
		try {
			await new Promise<void>((resolve, reject) => {
				const onError = (err: Error) => {
					httpServer.removeListener("error", onError);
					reject(err);
				};
				httpServer.once("error", onError);
				httpServer.listen(this.config.port, bind, () => {
					httpServer.removeListener("error", onError);
					resolve();
				});
			});
		} catch (err) {
			cache.destroy();
			try {
				httpServer.close();
			} catch {
				/* ignore */
			}
			throw err;
		}

		// Listen succeeded — commit state.
		this.cache = cache;
		this.tools = tools;
		this.httpServer = httpServer;
		this.clientErrorListener = clientErrorListener;
		this.startTime = Date.now();
		this.auditLog.setSink(createFileAuditSink(this.app));

		logger.info(
			"MCP",
			`Started on ${bind}:${this.config.port} with ${this.tools.length} tools`,
		);
	}

	async stop(): Promise<void> {
		logger.info("MCP", "Stopping server...");
		for (const timeout of this.sessionTimeouts.values()) clearTimeout(timeout);
		this.sessionTimeouts.clear();

		// Snapshot before iterating: transport.close() fires onclose → cleanupSession,
		// which mutates this.transports while we're walking it.
		const closes = Array.from(this.transports.entries()).map(async ([sid, transport]) => {
			try {
				await transport.close?.();
			} catch (err) {
				logger.warn("MCP", `Error closing transport ${sid.slice(0, 8)}…`, err);
			}
		});
		await Promise.all(closes);
		this.transports.clear();

		// Explicitly close any per-session McpServer instances still in the
		// map. transport.close() is expected to fire onclose → cleanupSession,
		// removing the McpServer; but the SDK doesn't strictly guarantee the
		// ordering, and on some transports close() resolves before onclose,
		// leaving a stale map entry. Walk what's left and close it directly.
		const serverCloses = Array.from(this.mcpServers.entries()).map(async ([sid, server]) => {
			try {
				await server.close?.();
			} catch (err) {
				logger.warn("MCP", `Error closing McpServer ${sid.slice(0, 8)}…`, err);
			}
		});
		await Promise.all(serverCloses);
		this.mcpServers.clear();

		if (this.httpServer) {
			const server = this.httpServer;
			// Detach the saved clientError listener before close() so the
			// closure stops pinning `this` through the listener registry.
			if (this.clientErrorListener) {
				server.off("clientError", this.clientErrorListener);
				this.clientErrorListener = null;
			}
			// Force-close any active connections (incl. lingering SSE
			// keepalives) before close() resolves. Otherwise the 2s
			// Promise.race fallback lets the timer win on a busy server,
			// `this.httpServer = null` runs while the OS socket is still
			// bound, and the next start() hits EADDRINUSE — auto-disabling
			// `mcpEnabled` with "MCP turned itself off" and no actionable
			// error. closeAllConnections is Node ≥ 18.2.
			server.closeAllConnections?.();
			let closeTimer: ReturnType<typeof setTimeout> | undefined;
			await Promise.race([
				new Promise<void>((resolve) =>
					server.close(() => {
						if (closeTimer) clearTimeout(closeTimer);
						resolve();
					}),
				),
				new Promise<void>((resolve) => {
					closeTimer = setTimeout(resolve, 2000);
				}),
			]);
			this.httpServer = null;
		}

		this.cache?.destroy();
		this.cache = null;
		this.auditLog.setSink(null);
	}

	private resetSessionTimeout(sid: string): void {
		const existing = this.sessionTimeouts.get(sid);
		if (existing) clearTimeout(existing);
		this.sessionTimeouts.set(
			sid,
			setTimeout(() => {
				const transport = this.transports.get(sid);
				if (transport) void transport.close?.();
				this.transports.delete(sid);
				this.sessionTimeouts.delete(sid);
			}, SESSION_TIMEOUT_MS),
		);
	}

	private cleanupSession(sid: string): void {
		this.transports.delete(sid);
		const server = this.mcpServers.get(sid);
		if (server) {
			this.mcpServers.delete(sid);
			// Fire-and-forget; SDK close errors shouldn't block transport cleanup.
			void Promise.resolve(server.close?.()).catch((err) =>
				logger.debug("MCP", `McpServer close error for session ${sid.slice(0, 8)}…`, err),
			);
		}
		const timeout = this.sessionTimeouts.get(sid);
		if (timeout) clearTimeout(timeout);
		this.sessionTimeouts.delete(sid);
	}

	isRunning(): boolean {
		return this.httpServer !== null;
	}

	private recordActivity(update: {
		sessionName: string;
		status: AgentStatus;
		detail?: string;
	}): void {
		// LRU on update: delete-then-set so the entry moves to the tail in
		// insertion order. When over cap, drop the head (oldest) entry.
		if (this.activity.has(update.sessionName)) {
			this.activity.delete(update.sessionName);
		} else if (this.activity.size >= MAX_ACTIVITY_ENTRIES) {
			const oldest = this.activity.keys().next().value;
			if (oldest !== undefined) this.activity.delete(oldest);
		}
		this.activity.set(update.sessionName, {
			status: update.status,
			detail: update.detail,
			updatedAt: Date.now(),
		});
		try {
			this.config.hooks?.onActivity?.(update);
		} catch (err) {
			logger.warn("MCP", "onActivity hook threw", err);
		}
	}

	/**
	 * Returns the current activity map with stale `working` entries rolled to `idle`.
	 * Pure: derives the rolled view at read time without mutating internal storage.
	 */
	getActivity(): Map<string, ActivityEntry> {
		const now = Date.now();
		const result = new Map<string, ActivityEntry>();
		for (const [name, entry] of this.activity) {
			if (entry.status === "working" && now - entry.updatedAt > ACTIVITY_STALE_MS) {
				result.set(name, { ...entry, status: "idle" });
			} else {
				result.set(name, entry);
			}
		}
		return result;
	}

	getToolCount(): number {
		return this.tools.length;
	}

	getAuditEntries(): readonly AuditEntry[] {
		return this.auditLog.getEntries();
	}

	/**
	 * Decide whether a given Origin is allowed to receive the
	 * Authorization-bearing CORS response. ACAO is only echoed for trusted
	 * origins so a random intranet page can't ride the auth header to talk
	 * to the MCP listener via the browser.
	 *
	 * Trusted: missing/null Origin (curl, Obsidian's main process), loopback
	 * HTTP origins (any port), and `app://` origins (Obsidian's own MCP
	 * client uses Origin: app://obsidian.md).
	 */
	private isOriginAllowed(origin: string | undefined): boolean {
		// Missing Origin = non-browser (curl, Obsidian's main process) — trust it.
		// Literal "null" = browser-suppressed Origin (file://, data:, sandboxed
		// iframes, restrictive-Referrer-Policy cross-origin redirects); the bearer
		// token still protects the endpoint, but echoing ACAO for "null" lets
		// those contexts read responses, so reject up-front.
		if (!origin) return true;
		if (origin === "null") return false;
		if (origin.startsWith("app://")) return true;
		try {
			const u = new URL(origin);
			if (u.protocol !== "http:" && u.protocol !== "https:") return false;
			const host = u.hostname;
			// `new URL("http://[::1]/").hostname` returns "::1" (no brackets)
			// on every Node version — the bracketed literal was dead code.
			return host === "127.0.0.1" || host === "localhost" || host === "::1";
		} catch {
			return false;
		}
	}

	private async handleRequest(req: IncomingMessage, res: ServerResponse): Promise<void> {
		const origin = req.headers.origin;
		if (this.isOriginAllowed(origin)) {
			// Only echo ACAO when the request comes from a trusted origin.
			// Without an Origin header the browser won't enforce same-origin,
			// so emitting "*" / null is unnecessary — omit entirely.
			if (origin) {
				res.setHeader("Access-Control-Allow-Origin", origin);
				res.setHeader("Vary", "Origin");
			}
		}
		res.setHeader("Access-Control-Allow-Methods", "GET, POST, DELETE, OPTIONS");
		res.setHeader(
			"Access-Control-Allow-Headers",
			"Content-Type, Authorization, Mcp-Session-Id",
		);
		res.setHeader("Access-Control-Expose-Headers", "Mcp-Session-Id");

		if (req.method === "OPTIONS") {
			res.writeHead(204);
			res.end();
			return;
		}

		if (!this.checkAuth(req)) {
			// Strip control chars from req.url before logging — `url` is
			// attacker-controlled from the loopback, and unescaped CRLF would
			// let an attacker forge fake log lines in the developer console.
			// The audit log already JSON-stringifies entries (safe), but the
			// debug console path doesn't.
			// eslint-disable-next-line no-control-regex
			const safeUrl = (req.url ?? "").replace(/[\r\n\t\x00-\x1f\x7f]/g, "?");
			logger.debug("MCP", `Auth failed: ${req.method} ${safeUrl}`);
			res.writeHead(401, { "Content-Type": "application/json" });
			res.end(JSON.stringify({ error: "Unauthorized" }));
			return;
		}

		const url = new URL(req.url ?? "/", `http://localhost:${this.config.port}`);

		if (url.pathname === "/mcp/health") {
			this.handleHealth(res);
			return;
		}

		if (url.pathname === "/mcp/audit") {
			this.handleAudit(res);
			return;
		}

		if (url.pathname !== "/mcp") {
			res.writeHead(404);
			res.end("Not Found");
			return;
		}

		logger.debug("MCP", `${req.method} /mcp`);

		try {
			if (req.method === "POST") {
				// Reject non-JSON content types. The Bearer token is the primary
				// defense, but defense-in-depth: a CSRF-style cross-origin POST
				// from a browser can send Content-Type: text/plain without
				// triggering a preflight (simple-request semantics). The Origin
				// check above prevents the attacker reading the response, but
				// the side effects (audit-log entries, agent_status_set) still
				// execute. Reject text/plain bodies up-front so the server side
				// effects only happen for genuine JSON-RPC clients.
				const ct = req.headers["content-type"] ?? "";
				if (!/^application\/json(?:;|$)/i.test(ct)) {
					res.writeHead(415, { "Content-Type": "application/json" });
					res.end(
						JSON.stringify({
							error: "Unsupported Media Type — Content-Type must be application/json",
						}),
					);
					return;
				}
				await this.handlePost(req, res);
			} else if (req.method === "GET" || req.method === "DELETE") {
				await this.forwardToTransport(req, res);
			} else {
				res.writeHead(405);
				res.end("Method Not Allowed");
			}
		} catch (err) {
			logger.error("MCP", `Error handling ${req.method} /mcp`, err);
			if (!res.headersSent) {
				res.writeHead(500, { "Content-Type": "application/json" });
				res.end(JSON.stringify({ error: "Internal server error" }));
			}
		}
	}

	private handleHealth(res: ServerResponse): void {
		res.writeHead(200, { "Content-Type": "application/json" });
		res.end(
			JSON.stringify({
				status: "ok",
				tools: this.tools.length,
				uptimeMs: Date.now() - this.startTime,
			}),
		);
	}

	private handleAudit(res: ServerResponse): void {
		res.writeHead(200, { "Content-Type": "application/json" });
		res.end(JSON.stringify({ entries: this.auditLog.getEntries() }));
	}

	private checkAuth(req: IncomingMessage): boolean {
		const auth = req.headers.authorization;
		if (!auth) return false;
		const expected = `Bearer ${this.config.token}`;
		// timingSafeEqual requires equal-length BYTE buffers and throws RangeError
		// otherwise. Comparing string code-unit length is unsafe: a header with
		// non-ASCII multi-byte runes can match `expected.length` (39 code units)
		// while encoding to a different byte count, and timingSafeEqual then
		// throws synchronously into the request handler.
		// The length gate only leaks the *header* byte length, which is a known
		// constant (`Bearer ` + 32 hex chars = 39 bytes); no bits of the token
		// secret leak through it.
		const authBuf = Buffer.from(auth, "utf8");
		const expectedBuf = Buffer.from(expected, "utf8");
		if (authBuf.length !== expectedBuf.length) return false;
		return timingSafeEqual(authBuf, expectedBuf);
	}

	private async readBody(req: IncomingMessage): Promise<unknown> {
		return new Promise((resolve, reject) => {
			let chunks: Buffer[] = [];
			let size = 0;
			let settled = false;
			const settleResolve = (v: unknown) => {
				if (settled) return;
				settled = true;
				cleanup();
				resolve(v);
			};
			const settleReject = (err: Error) => {
				if (settled) return;
				settled = true;
				cleanup();
				reject(err);
			};
			const onData = (chunk: Buffer) => {
				if (settled) return;
				size += chunk.length;
				if (size > MAX_BODY_BYTES) {
					// Drop the buffered prefix and tear the request down. Remove
					// the listeners so end/error after destroy() can't fire the
					// handlers again or leak references via the closure.
					chunks = [];
					size = 0;
					settleReject(new Error("Request body too large"));
					try {
						req.destroy();
					} catch {
						/* already destroyed */
					}
				} else {
					chunks.push(chunk);
				}
			};
			const onEnd = () => {
				if (settled) return;
				try {
					settleResolve(JSON.parse(Buffer.concat(chunks).toString()));
				} catch {
					settleReject(new Error("Invalid JSON"));
				}
			};
			const onError = (err: Error) => settleReject(err);
			const cleanup = () => {
				req.removeListener("data", onData);
				req.removeListener("end", onEnd);
				req.removeListener("error", onError);
			};
			req.on("data", onData);
			req.on("end", onEnd);
			req.on("error", onError);
		});
	}

	private registerCapabilitiesTool(server: McpServer): void {
		server.registerTool(
			"mcp_capabilities",
			{
				title: "Report MCP capabilities",
				description:
					"Return the currently enabled permission tiers, the active write directory, per-tier tool counts, and rate-limit budgets. Call this at the start of a session (or after a permission error) to discover what you can do without trial-and-error.",
				inputSchema: {},
			},
			async () => {
				const enabled = Array.from(this.config.enabledTiers);
				const always = ALWAYS_ON_TIERS.filter((t) => this.config.enabledTiers.has(t));
				const escalations = GATED_TIERS.filter((g) =>
					this.config.enabledTiers.has(g.tier),
				).map((g) => g.tier);
				const toolsByTier: Record<string, string[]> = {};
				for (const t of this.tools) {
					(toolsByTier[t.tier] ??= []).push(t.name);
				}
				const body = {
					enabledTiers: enabled,
					alwaysOn: always,
					escalations,
					writeDir: this.config.getWriteDir(),
					toolsByTier,
					rateLimits: {
						defaultReadsPerMin: RATE_LIMIT_READ,
						defaultWritesPerMin: RATE_LIMIT_WRITE,
					},
				};
				return {
					content: [{ type: "text" as const, text: JSON.stringify(body, null, 2) }],
				};
			},
		);
	}

	/** Pick the timeout budget for a tool — review-modal tools get a longer window. */
	private selectTimeoutMs(tool: McpToolDef): number {
		const mayTriggerReview =
			tool.tier === "writeReviewed" ||
			(tool.tier === "manage" && this.config.enabledTiers.has("writeReviewed"));
		return mayTriggerReview ? this.config.reviewTimeoutMs : this.config.toolTimeoutMs;
	}

	/** Run a tool under the configured timeout and truncate oversize responses;
	 * throws on timeout so the caller can record it as a failure. */
	private async runToolWithLimits(
		tool: McpToolDef,
		args: Record<string, unknown>,
	): Promise<{ result: McpToolResult; success: boolean }> {
		const timeoutMs = this.selectTimeoutMs(tool);
		let timer: ReturnType<typeof setTimeout> | undefined;
		// Note: this setTimeout isn't routed through Plugin.registerInterval
		// because ObsidianMcpServer has no reference to the Plugin instance and
		// adding one for a per-tool-call timer (always cleared in finally) is
		// not worth the coupling. The .finally() clearTimeout below guarantees
		// the timer is released even if the tool throws.
		const timeout = new Promise<never>((_, reject) => {
			timer = setTimeout(
				() =>
					reject(
						new Error(
							tool.tier === "writeReviewed"
								? `Review timed out for '${tool.name}' — user did not respond within ${timeoutMs / 1000}s. The review modal may have been dismissed.`
								: `Tool '${tool.name}' did not respond within ${timeoutMs / 1000}s`,
						),
					),
				timeoutMs,
			);
		});
		// Attach a catch to the handler promise before racing so a late
		// rejection (after timeout won) doesn't surface as an unhandled
		// rejection. Timeouts can't truly cancel an in-flight handler —
		// apply() may complete after the "failed" result returned. Log the
		// late outcome so the audit trail isn't silent.
		const handlerPromise = tool.handler(args);
		handlerPromise.catch((err) => {
			logger.warn("MCP", `Late rejection from '${tool.name}' (after timeout/return)`, err);
		});
		const result = await Promise.race([handlerPromise, timeout]).finally(() => {
			if (timer) clearTimeout(timer);
		});
		// Truncate every text entry independently in the byte domain, then cap
		// the cumulative response at MAX_RESPONSE_TOTAL_BYTES so many sub-cap
		// entries can't still produce a multi-MB payload. String .slice() is
		// UTF-16 code units — a naive slice past a multi-byte boundary
		// over-budgets after re-encoding. Slice the encoded buffer and decode
		// with replacement-character fallback.
		const TRUNCATION_SUFFIX = "\n\n[truncated]";
		const TRUNCATION_BYTES = Buffer.byteLength(TRUNCATION_SUFFIX);
		if (Array.isArray(result.content)) {
			let cumulative = 0;
			for (const entry of result.content) {
				if (typeof entry?.text !== "string") continue;
				// Per-entry cap. Reserve TRUNCATION_BYTES inside the budget so
				// `subarray(0, MAX_RESPONSE_BYTES) + "[truncated]"` doesn't
				// exceed the documented cap by the marker's byte length.
				if (Buffer.byteLength(entry.text) > MAX_RESPONSE_BYTES) {
					const sliceBytes = Math.max(0, MAX_RESPONSE_BYTES - TRUNCATION_BYTES);
					const buf = Buffer.from(entry.text, "utf8").subarray(0, sliceBytes);
					entry.text = buf.toString("utf8") + TRUNCATION_SUFFIX;
				}
				// Cumulative cap. Same reservation: the post-truncation entry
				// must fit within `remaining` even after the marker is added.
				const entryBytes = Buffer.byteLength(entry.text);
				const remaining = MAX_RESPONSE_TOTAL_BYTES - cumulative;
				if (remaining <= 0) {
					entry.text = "[truncated]";
				} else if (entryBytes > remaining) {
					const sliceBytes = Math.max(0, remaining - TRUNCATION_BYTES);
					const buf = Buffer.from(entry.text, "utf8").subarray(0, sliceBytes);
					entry.text = buf.toString("utf8") + TRUNCATION_SUFFIX;
				}
				cumulative += Buffer.byteLength(entry.text);
			}
		}
		return { result, success: !result.isError };
	}

	private createMcpServer(): McpServer {
		// Read version from manifest.json (single source of truth synced by
		// version-bump.mjs) so MCP clients that surface server identity (e.g.
		// Inspector) match the plugin's actual version.
		const server = new McpServer({
			name: "obsidian-vault",
			version: manifest.version,
		});

		this.registerCapabilitiesTool(server);

		for (const tool of this.tools) {
			server.registerTool(tool.name, tool.config, async (args) => {
				if (!this.rateLimiter.check(tool.name, tool.tier)) {
					return {
						content: [
							{
								type: "text" as const,
								text: `Rate limit exceeded for ${tool.name}. Try again shortly.`,
							},
						],
						isError: true,
					};
				}

				const start = Date.now();
				let success = false;
				let result: McpToolResult;
				try {
					const out = await this.runToolWithLimits(tool, args as Record<string, unknown>);
					success = out.success;
					result = out.result;
				} catch (err: unknown) {
					if (err instanceof McpError) throw err;
					const msg = errMsg(err);
					logger.error("MCP", `Tool ${tool.name} threw`, err);
					result = {
						content: [{ type: "text" as const, text: `Error: ${msg}` }],
						isError: true,
					};
				}
				const duration = Date.now() - start;
				this.auditLog.record({
					timestamp: Date.now(),
					tool: tool.name,
					success,
					durationMs: duration,
				});
				logger.debug("MCP", `${tool.name} ${success ? "ok" : "err"} ${duration}ms`);
				return result;
			});
		}

		return server;
	}

	/** Resolve mcp-session-id header to a single string, ignoring multi-value forms. */
	private getSessionId(req: IncomingMessage): string | undefined {
		const raw = req.headers["mcp-session-id"];
		if (typeof raw === "string") return raw;
		return undefined;
	}

	private async handlePost(req: IncomingMessage, res: ServerResponse): Promise<void> {
		const body = await this.readBody(req);
		const sessionId = this.getSessionId(req);

		if (sessionId && this.transports.has(sessionId)) {
			this.resetSessionTimeout(sessionId);
			const transport = this.transports.get(sessionId)!;
			const stopKeepalive = startSseKeepalive(res);
			try {
				await transport.handleRequest(req, res, body);
			} finally {
				stopKeepalive();
			}
			return;
		}

		if (sessionId && !this.transports.has(sessionId)) {
			const requestId: unknown =
				body !== null && typeof body === "object"
					? ((body as { id?: unknown }).id ?? null)
					: null;
			res.writeHead(404, { "Content-Type": "application/json" });
			res.end(
				JSON.stringify({
					jsonrpc: "2.0",
					id: requestId,
					error: { code: -32001, message: "Session expired — re-initialize" },
				}),
			);
			return;
		}

		if (!sessionId) {
			const parsed =
				body !== null && typeof body === "object"
					? (body as { method?: string; id?: unknown })
					: null;
			if (parsed?.method !== "initialize") {
				res.writeHead(400, { "Content-Type": "application/json" });
				res.end(
					JSON.stringify({
						jsonrpc: "2.0",
						id: parsed?.id ?? null,
						error: {
							code: -32600,
							message: "Missing Mcp-Session-Id; call initialize first",
						},
					}),
				);
				return;
			}
		}

		const server = this.createMcpServer();
		const transport = new StreamableHTTPServerTransport({
			sessionIdGenerator: () => randomUUID(),
			onsessioninitialized: (sid: string) => {
				logger.info("MCP", `New session ${sid.slice(0, 8)}…`);
				this.transports.set(sid, transport);
				// Register the McpServer here, INSIDE onsessioninitialized,
				// rather than after handleRequest below. The previous order
				// had a narrow race: if the client disconnected between
				// onsessioninitialized firing and the post-handleRequest
				// `mcpServers.set`, the entry was never set — and
				// cleanupSession had already run via onclose, so the
				// McpServer was leaked permanently. Setting it inside the
				// initialization callback closes the window.
				this.mcpServers.set(sid, server);
				this.resetSessionTimeout(sid);
			},
		});

		transport.onclose = () => {
			const sid = transport.sessionId;
			if (sid) {
				logger.debug("MCP", `Session ${sid.slice(0, 8)}… closed`);
				this.cleanupSession(sid);
			}
			// No sid means init never completed (no onsessioninitialized) —
			// the transport entry was never added to this.transports, so
			// nothing to remove. Branch left explicit for readers.
		};

		try {
			await server.connect(transport);
			// onsessioninitialized fires from inside handleRequest and also
			// registers the server in this.mcpServers, so cleanupSession can
			// find it via the onclose chain. handleRequest must follow
			// connect so the SDK has its routing in place.
			await transport.handleRequest(req, res, body);
		} catch (err) {
			logger.error("MCP", "Failed to initialize MCP session", err);
			const sid = transport.sessionId;
			if (sid) {
				this.cleanupSession(sid);
			} else {
				// Init failed before onsessioninitialized fired, so neither the
				// transport nor the McpServer is tracked yet. Close both
				// directly to avoid leaking SDK resources / SSE keepalives.
				try {
					await transport.close?.();
				} catch (closeErr) {
					logger.debug(
						"MCP",
						"Error closing untracked transport after init failure",
						closeErr,
					);
				}
				try {
					await server.close?.();
				} catch (closeErr) {
					logger.debug(
						"MCP",
						"Error closing untracked McpServer after init failure",
						closeErr,
					);
				}
			}
			throw err;
		}
	}

	private async forwardToTransport(req: IncomingMessage, res: ServerResponse): Promise<void> {
		const sessionId = this.getSessionId(req);
		const transport = sessionId ? this.transports.get(sessionId) : undefined;
		if (!transport || !sessionId) {
			res.writeHead(400, { "Content-Type": "application/json" });
			res.end(JSON.stringify({ error: "Invalid or missing session ID" }));
			return;
		}
		// Treat any traffic on the session (POST/GET-SSE/DELETE) as activity so
		// long-running SSE consumers aren't reaped under the 10-minute idle timer.
		this.resetSessionTimeout(sessionId);
		await transport.handleRequest(req, res);
	}
}

export function generateToken(): string {
	return randomUUID().replace(/-/g, "");
}
