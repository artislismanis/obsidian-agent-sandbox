# MCP session recovery after server restart

**Status:** proposed  
**Affects:** `workspace/.claude/scripts/obsidian-mcp-proxy.js`, `plugin/src/mcp-server.ts`

---

## Problem

After the user changes a restart-required MCP setting — such as Vault write mode — every vault tool call returns a JSON-RPC error until the container is restarted:

```
Bad Request: Server not initialized
```

Toggling MCP off and back on via plugin settings triggers the same failure. The only reliable recovery today is a full container restart, which kills the proxy process and resets its state.

### Root cause

When `Plugin.restartMcpIfRunning()` (`plugin/src/main.ts:743`) fires, it calls `stop()` then `start()`. The `start()` call allocates a fresh `ObsidianMcpServer` instance with an empty `transports` Map (`plugin/src/mcp-server.ts:344`). All previously established session ids are gone.

The proxy (`workspace/.claude/scripts/obsidian-mcp-proxy.js:49`) holds `sessionId` as a module-level variable. It is set once during the initial `initialize` handshake and never cleared. On every subsequent request the proxy attaches the stale `Mcp-Session-Id` header.

When `handlePost` in `mcp-server.ts:892–901` receives that header it looks the id up in `this.transports`. The lookup fails. Rather than signalling an error, the current code falls through to create a brand-new transport — then passes the incoming request (a `tools/call`, not `initialize`) to that transport. The MCP SDK rejects it with `HTTP 400 {"code":-32000,"message":"Bad Request: Server not initialized"}` because no `initialize` has been received on this transport.

The proxy catches the 400, emits the error frame to Claude Code, and marks `lastProbeResult = false`. On the next request it re-probes the port: TCP is still open, so `isAvailable()` returns `true`, and the cycle repeats indefinitely with the same stale id.

---

## Proposed changes

### Server side — `plugin/src/mcp-server.ts`

At the branch in `handlePost` where `sessionId && !this.transports.has(sessionId)` is true, respond with `HTTP 404` and an explicit JSON-RPC error instead of falling through to create a new transport:

```typescript
if (sessionId && !this.transports.has(sessionId)) {
  res.writeHead(404, { "Content-Type": "application/json" });
  res.end(
    JSON.stringify({ jsonrpc: "2.0", id: null, error: { code: -32001, message: "Session expired — re-initialize" } })
  );
  return;
}
```

Using `404` instead of letting the SDK generate a `400` makes the condition explicit and machine-detectable. The error code `-32001` is chosen to be distinguishable from the generic `-32000` the SDK emits for unrelated bad-request conditions. The "no session id header" path (a fresh client connecting for the first time) is unaffected.

### Proxy side — `workspace/.claude/scripts/obsidian-mcp-proxy.js`

Two additions:

**1. Cache the `initialize` payload.**  
Add a module-level `cachedInitializeMsg` variable. The first time `handleMessage` sees a request with `method === "initialize"`, store a reference to `msg` before forwarding it. This is the payload Claude Code sent at startup and is sufficient to replay the handshake.

```js
let cachedInitializeMsg = null;

// inside handleMessage, before the httpPost call:
if (msg.method === "initialize") cachedInitializeMsg = msg;
```

**2. Detect stale sessions and replay `initialize`.**  
In `httpPost`'s error path, detect a stale-session response: `status === 400 || status === 404` and the body matches `/not initialized|Session expired|Invalid session/i`. On detection:

1. Null `sessionId` so the retry sends no stale header.
2. Guard against concurrent recoveries with a module-level `pendingRecovery` Promise — same pattern as the existing `pendingInitialize` gate.
3. POST `cachedInitializeMsg` via `httpPost`. Capture the new session id from the response headers (the existing success-path assignment in `httpPost` handles this automatically).
4. Fire-and-forget `notifications/initialized` to complete the MCP handshake, matching the existing behaviour in `handleMessage`.
5. Retry the original request once.
6. Emit a stderr log line on recovery:

```
obsidian-mcp-proxy: session expired, replaying initialize (42ms)
```

The retry is limited to one attempt. If the replay itself fails (e.g. the server is still restarting), the original error is propagated to Claude Code normally.

---

## Tests

### Unit test — `plugin/src/__tests__/mcp-server.test.ts`

POST a `tools/call` request with a fabricated, unknown `Mcp-Session-Id` header to a running `ObsidianMcpServer`. Assert the response is `HTTP 404` with a JSON-RPC body containing `code: -32001`.

### Integration test — `plugin/test/integration/`

1. Start the MCP server and complete an `initialize` handshake; capture the session id.
2. Stop and restart the server (simulating `restartMcpIfRunning`).
3. POST `tools/call` with the captured (now stale) session id.
4. Assert the response is `HTTP 404` with `code: -32001`.

### Proxy integration test — `plugin/test/integration/` or a standalone Node test

Simulate the full recovery flow against a mock HTTP server:

1. Mock server returns `HTTP 404 / -32001` on the first `tools/call`.
2. Mock server accepts `initialize` and returns a new session id.
3. Mock server succeeds on the retried `tools/call`.
4. Assert that after the sequence, `sessionId` in the proxy reflects the new id and the tool call response reaches the caller.

---

## Manual verification steps

1. Container running, MCP enabled, Vault write mode set to `none`.
2. Inside the container: `claude -p "List vault files"` — confirm success.
3. In Obsidian plugin settings: change Vault write mode to `full`. Click **Later** on any restart modal to avoid a full container restart; `restartMcpIfRunning()` fires from `settings.ts:704` and restarts only the MCP server.
4. In the same `claude` session (without restarting the container): `claude -p "List vault files again"` — must succeed.

Before this fix step 4 returns the verbatim `Bad Request: Server not initialized` error. After the fix the proxy detects the stale session, replays `initialize`, and the retry succeeds transparently.

---

## Sequencing

This is PR-2 in a three-PR sequence targeting docs and bug-fix coverage for the MCP capability layer:

- **PR-1** — test-plan doc refactor (prerequisite: sets up the test structure this proposal's tests slot into)
- **PR-2** — this proposal (landing this unblocks clean re-runs of the capability test)
- **PR-3** — per-tool bug triage (`mcp-tools.ts` edge cases surfaced during capability testing)
