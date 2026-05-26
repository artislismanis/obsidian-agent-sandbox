#!/usr/bin/env node
"use strict";
// Stdio→HTTP proxy for the Obsidian MCP server.
//
// Presents as a stdio MCP server to Claude Code. When the Obsidian plugin's
// HTTP server is reachable it proxies all requests through; when it is not
// (Obsidian closed, plugin disabled, not yet started) it responds as an empty
// MCP server so other stdio servers such as memory are unaffected.
//
// Connectivity is re-probed before every request, with a 30-second positive
// cache. The proxy recovers automatically once Obsidian becomes reachable
// for *new* `tools/list` queries — but Claude Code caches an empty tools list
// from the first response, so an existing Claude session that started with
// Obsidian unreachable will not see the tools appear without a `/mcp restart
// obsidian` (or full restart). Start Obsidian before `claude` if you want
// vault tools available for the whole session.
//
// Concurrency: requests dispatch as they arrive on stdin so a slow tool call
// doesn't block subsequent calls. Writes back to stdout are serialised
// through a single queue so JSON-RPC frames never interleave.

const http = require("http");
const net = require("net");
const readline = require("readline");

// Guard parseInt against non-numeric env values. Without the finite-check, a
// typo like OAS_MCP_PORT=foo collapses to NaN and flows into
// net.createConnection({port: NaN}) / http.request({timeout: NaN}) — opaque
// failure or a silently disabled timeout.
function envInt(name, fallback) {
	const raw = process.env[name];
	if (raw === undefined || raw === "") return fallback;
	const n = parseInt(raw, 10);
	return Number.isFinite(n) && n >= 0 ? n : fallback;
}

const PORT = envInt("OAS_MCP_PORT", 28080);
const TOKEN = process.env.OAS_MCP_TOKEN || "";
const HOST = "host.docker.internal";
// Socket inactivity timeout. The plugin sends SSE keepalive comments every
// 5 s during reviewed-write modal waits, so this default is safe. Raise it
// (e.g. OAS_MCP_TIMEOUT_MS=60000) only if keepalives are disabled or the
// server is under extreme load.
const HTTP_TIMEOUT_MS = envInt("OAS_MCP_TIMEOUT_MS", 15000);
const DEBUG = process.env.OAS_MCP_DEBUG === "1";

// Cache: re-probe at most once every PROBE_TTL_MS when available,
// immediately when unavailable (so recovery is fast).
const PROBE_TTL_MS = 30_000;
let lastProbeTime = 0;
let lastProbeResult = false;

let sessionId = null;

// Promise that resolves once the in-flight `initialize` request has produced
// a sessionId. Claude Code emits `initialize` followed immediately by
// `notifications/initialized` on consecutive stdin lines, and handleMessage
// runs without awaiting, so without this gate the notification's httpPost
// would fire with sessionId still null — losing the Mcp-Session-Id header
// the upstream server uses for routing. Held only until the first
// initialize resolves.
let pendingInitialize = null;

// Last `initialize` message received from Claude Code. Used to replay the
// handshake transparently when the server restarts and invalidates the
// session (HTTP 404 / code -32001).
let cachedInitializeMsg = null;

// Promise that resolves once an in-flight session-recovery replay has
// completed. Concurrent requests that detect a stale session await this
// instead of triggering independent replays.
let pendingRecovery = null;

function probePort() {
	return new Promise((resolve) => {
		const s = net.createConnection({ host: HOST, port: PORT });
		s.setTimeout(2000);
		s.on("connect", () => {
			s.destroy();
			resolve(true);
		});
		s.on("error", () => resolve(false));
		s.on("timeout", () => {
			s.destroy();
			resolve(false);
		});
	});
}

async function isAvailable() {
	// No bearer token configured → server would reject every request with a
	// 401 anyway. Surface as "unavailable" so callers fall through to the
	// empty-server stub path instead of seeing confusing auth errors. This
	// is the normal state when MCP is disabled in the plugin settings.
	if (!TOKEN) return false;
	const now = Date.now();
	// Skip re-probe if last result was positive and within TTL
	if (lastProbeResult && now - lastProbeTime < PROBE_TTL_MS) {
		return true;
	}
	lastProbeResult = await probePort();
	lastProbeTime = now;
	return lastProbeResult;
}

// Serialise stdout writes so JSON-RPC frames from concurrent in-flight
// requests don't interleave. process.stdout.write returning false (kernel
// pipe buffer full) is rare for small JSON frames but handled defensively.
const writeQueue = [];
let writing = false;
function writeFrame(obj) {
	writeQueue.push(JSON.stringify(obj) + "\n");
	drainWrite();
}
function drainWrite() {
	if (writing) return;
	const next = writeQueue.shift();
	if (next === undefined) return;
	writing = true;
	// process.stdout.write fires its callback on flush regardless of whether
	// the synchronous return was true (kernel buffer accepted) or false
	// (queued; will emit 'drain' later). Relying solely on the callback
	// avoids double-firing under backpressure.
	process.stdout.write(next, () => {
		writing = false;
		drainWrite();
	});
}

function httpPost(message) {
	return new Promise((resolve, reject) => {
		const payload = JSON.stringify(message);
		const headers = {
			"Content-Type": "application/json",
			Authorization: `Bearer ${TOKEN}`,
			Accept: "application/json, text/event-stream",
			"Content-Length": Buffer.byteLength(payload),
		};
		if (sessionId) headers["Mcp-Session-Id"] = sessionId;

		const req = http.request(
			{ hostname: HOST, port: PORT, path: "/mcp", method: "POST", headers, timeout: HTTP_TIMEOUT_MS },
			(res) => {
				// Adopt the session id only on success. Two concurrent requests
				// can each receive an mcp-session-id header; without this guard a
				// late 4xx/5xx response with a stale id could overwrite the live
				// session id and break subsequent routing.
				const sid = res.headers["mcp-session-id"];
				if (sid && res.statusCode && res.statusCode < 300) sessionId = sid;

				const ct = res.headers["content-type"] || "";
				let buf = "";
				const messages = [];

				// SSE events are terminated by a blank line ("\n\n"). An event
				// can have multiple `data:` lines that must be concatenated with
				// "\n" into a single payload before parsing.
				const flushEvent = (event) => {
					const dataLines = event
						.split("\n")
						.filter((l) => l.startsWith("data:"))
						.map((l) => (l.startsWith("data: ") ? l.slice(6) : l.slice(5)));
					if (dataLines.length === 0) return;
					const text = dataLines.join("\n").trim();
					if (text) try { messages.push(JSON.parse(text)); } catch {}
				};

				res.on("data", (chunk) => {
					buf += chunk.toString();
					if (!ct.includes("text/event-stream")) return;
					let sep;
					while ((sep = buf.indexOf("\n\n")) !== -1) {
						flushEvent(buf.slice(0, sep));
						buf = buf.slice(sep + 2);
					}
				});

				res.on("end", () => {
					// Reject on non-2xx so callers get a clean error frame back
					// to Claude instead of an indefinite hang.
					const status = res.statusCode || 0;
					if (status < 200 || status >= 300) {
						// A stale-session 404 (-32001) means the server restarted
						// but is still reachable — don't flip the probe to false.
						const isStale = status === 404 && /Session expired/i.test(buf);
						if (!isStale) lastProbeResult = false;
						const err = new Error(
							`Obsidian MCP returned HTTP ${status} (${(buf || "").slice(0, 200) || "no body"})`,
						);
						err.status = status;
						err.body = buf;
						reject(err);
						return;
					}
					if (ct.includes("text/event-stream")) {
						if (buf) flushEvent(buf);
						resolve(messages);
					} else {
						try { resolve([JSON.parse(buf)]); } catch {
							reject(new Error("Obsidian MCP returned a non-JSON body on a 2xx response."));
						}
					}
				});

				res.on("error", (err) => {
					// Mark as unavailable so next request re-probes
					lastProbeResult = false;
					reject(err);
				});
			},
		);
		req.on("error", (err) => {
			lastProbeResult = false;
			reject(err);
		});
		req.on("timeout", () => {
			req.destroy();
			lastProbeResult = false;
			reject(
				new Error(
					`Obsidian MCP handler did not respond within ${HTTP_TIMEOUT_MS}ms — check Obsidian's developer console for plugin errors.`,
				),
			);
		});
		req.write(payload);
		req.end();
	});
}

function unavailableResult(id, method) {
	let result;
	if (method === "initialize") {
		result = {
			protocolVersion: "2025-03-26",
			capabilities: {},
			serverInfo: { name: "obsidian-unavailable", version: "0.0.0" },
		};
	} else if (method === "tools/list") {
		result = { tools: [] };
	} else if (method === "resources/list") {
		result = { resources: [] };
	} else if (method === "prompts/list") {
		result = { prompts: [] };
	} else {
		result = {};
	}
	return { jsonrpc: "2.0", id, result };
}

async function handleMessage(msg) {
	// Set pendingInitialize SYNCHRONOUSLY before any await so a notification
	// arriving on the very next stdin tick can't observe `pendingInitialize ===
	// null` while the initialize handler is still in `await isAvailable()`.
	// We resolve in finally so failed initializes still unblock waiters.
	let initializeResolve;
	if (msg.method === "initialize") {
		cachedInitializeMsg = msg;
		pendingInitialize = new Promise((resolve) => {
			initializeResolve = resolve;
		});
	}

	const available = await isAvailable();

	// Notifications have no id and need no response. The MCP spec requires
	// `notifications/initialized` after `initialize`, so we still forward
	// them upstream (fire-and-forget) when the server is reachable —
	// dropping them would prevent the upstream session from leaving init.
	if (msg.id === undefined) {
		if (available) {
			// If an `initialize` is in flight, hold the notification until it
			// resolves so sessionId is set before we POST.
			const pending = pendingInitialize;
			if (pending) {
				pending.then(() => httpPost(msg).catch(() => undefined));
			} else {
				httpPost(msg).catch(() => undefined);
			}
		}
		return;
	}

	if (!available) {
		writeFrame(unavailableResult(msg.id, msg.method));
		// Release waiters even on the unavailable path so notifications waiting
		// on init don't queue forever.
		if (initializeResolve) {
			pendingInitialize = null;
			initializeResolve();
		}
		return;
	}

	// If a session-recovery replay is in progress, wait for it before sending —
	// sessionId is null during replay and would cause the server to allocate an
	// unwanted new session for this request.
	if (pendingRecovery) await pendingRecovery;

	const t0 = Date.now();
	try {
		const responses = await httpPost(msg);
		if (DEBUG) {
			const label =
				msg.method === "tools/call" ? `tools/call ${msg.params?.name ?? "?"}` : msg.method;
			process.stderr.write(
				`obsidian-mcp-proxy: id=${msg.id} ${label} ${Date.now() - t0}ms\n`,
			);
		}
		for (const r of responses) writeFrame(r);
	} catch (err) {
		const isStale = err.status === 404 && /Session expired/i.test(err.body || "");

		if (isStale && cachedInitializeMsg) {
			try {
				// Only one concurrent recovery — peers that also hit 404 await
				// the same promise rather than each replaying initialize.
				if (!pendingRecovery) {
					const recoveryStart = Date.now();
					pendingRecovery = (async () => {
						try {
							sessionId = null;
							await httpPost(cachedInitializeMsg);
							// Fire-and-forget: the MCP SDK doesn't gate tool calls on this
							// notification (server treats it as informational), so we don't
							// need to await it before retrying the original request.
							httpPost({ jsonrpc: "2.0", method: "notifications/initialized", params: {} }).catch(
								() => {},
							);
							process.stderr.write(
								`obsidian-mcp-proxy: session expired, replaying initialize (${Date.now() - recoveryStart}ms)\n`,
							);
						} finally {
							pendingRecovery = null;
						}
					})();
				}
				await pendingRecovery;
				// Retry the original request once with the new session.
				const retryResponses = await httpPost(msg);
				if (DEBUG) {
					const label =
						msg.method === "tools/call" ? `tools/call ${msg.params?.name ?? "?"}` : msg.method;
					process.stderr.write(
						`obsidian-mcp-proxy: id=${msg.id} ${label} ${Date.now() - t0}ms (after recovery)\n`,
					);
				}
				for (const r of retryResponses) writeFrame(r);
			} catch (retryErr) {
				process.stderr.write(
					`obsidian-mcp-proxy: id=${msg.id} ${msg.method} failed after recovery: ${retryErr.message}\n`,
				);
				writeFrame({
					jsonrpc: "2.0",
					id: msg.id,
					error: { code: -32603, message: retryErr.message || "Obsidian MCP server unavailable" },
				});
			}
			return;
		}

		process.stderr.write(
			`obsidian-mcp-proxy: id=${msg.id} ${msg.method} failed after ${Date.now() - t0}ms: ${err.message}\n`,
		);
		writeFrame({
			jsonrpc: "2.0",
			id: msg.id,
			error: { code: -32603, message: err.message || "Obsidian MCP server unavailable" },
		});
	} finally {
		if (initializeResolve) {
			// Release any notifications waiting on the initialize. Clear the
			// module-level pending pointer too so subsequent notifications skip
			// the wait. Done in finally so an error path still unblocks waiters.
			pendingInitialize = null;
			initializeResolve();
		}
	}
}

function main() {
	const rl = readline.createInterface({ input: process.stdin, terminal: false });

	// Drain in-flight handlers on shutdown so mid-flight tool calls aren't
	// dropped when Claude Code closes stdin. Drain budget is
	// HTTP_TIMEOUT_MS + 1s so every outstanding request gets a chance to
	// finish before exit.
	const inFlight = new Set();
	const SHUTDOWN_DRAIN_MS = HTTP_TIMEOUT_MS + 1000;

	// Dispatch messages without awaiting so a slow tool call doesn't block
	// other in-flight requests. handleMessage drives writes through the
	// serialised writeFrame queue so JSON-RPC frames never interleave.
	rl.on("line", (line) => {
		const trimmed = line.trim();
		if (!trimmed) return;
		let msg;
		try { msg = JSON.parse(trimmed); } catch { return; }
		const p = handleMessage(msg).catch((err) => {
			process.stderr.write(`obsidian-mcp-proxy: handler error: ${err.message}\n`);
			// handleMessage's inner try/catch normally produces an error
			// frame. This fallback covers the rare path where it throws
			// before reaching that catch (e.g. a malformed `msg` that
			// passed JSON.parse but tripped a property access) — without
			// it, Claude would hang waiting for a response that never
			// comes until the request times out.
			if (msg && typeof msg === "object" && msg.id !== undefined) {
				try {
					writeFrame({
						jsonrpc: "2.0",
						id: msg.id,
						error: { code: -32603, message: err.message || "Internal proxy error" },
					});
				} catch {
					/* writeFrame should not throw; ignore if it does */
				}
			}
		});
		inFlight.add(p);
		p.finally(() => inFlight.delete(p));
	});

	rl.on("close", () => {
		// stdin EOF — drain in-flight handlers with a bounded budget so we
		// don't abandon pending HTTP requests mid-flight (response would never
		// reach Claude; upstream may still mutate vault state).
		const deadline = Promise.race([
			Promise.allSettled(Array.from(inFlight)),
			new Promise((resolve) => setTimeout(resolve, SHUTDOWN_DRAIN_MS)),
		]);
		deadline.then(() => process.exit(0));
	});
}

try {
	main();
} catch (err) {
	process.stderr.write(`obsidian-mcp-proxy fatal: ${err.message}\n`);
	process.exit(1);
}
