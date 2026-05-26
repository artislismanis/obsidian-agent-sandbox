# MCP Tool Bug Fixes — Triage Proposal

## Overview

Three capability-test runs were conducted on 2026-05-26 against the Obsidian MCP server:

- **Cell A** (`mcp-capability-test-run-2026-05-26.md`) — baseline; `writeVault` and `writeReviewed` absent. All tiers except reviewed-write pass cleanly.
- **Cell B** (`mcp-capability-test-run-2026-05-26-review-write.md`) — `writeReviewed` present, `writeVault` absent. Most anomalies appear here.
- **Cell C** (`mcp-capability-test-run-2026-05-26-full-write.md`) — `writeVault` present, `writeReviewed` absent. Results closely mirror Cell A.

Eight findings are documented below. Several Cell B failures are consistent with degraded session state — the stale-session proxy bug being fixed in PR-2 (`docs/proposals/mcp-session-recovery.md`) is a plausible common cause. Each section notes whether the finding is believed to be independent of PR-2 or should be re-tested after it lands.

**Sequencing advice.** Land PR-2 first. Re-run a clean Cell B immediately after. Findings marked "re-test after PR-2" should be considered unconfirmed until that rerun; escalate to follow-up PRs only if they reproduce. The P0 and one of the P1 findings are not believed downstream of PR-2 and can be worked in parallel.

---

## P0 — S3.1: Reviewed-write timeout but write succeeds (data-safety)

**Evidence.** In Cell B, both invocations of `vault_create_reviewed` returned:

```
MCP error -32603: Obsidian MCP handler did not respond within 15000ms — check Obsidian's developer console for plugin errors.
```

However, `agent-workspace/mcp-test/reviewed.md` was found present in the vault afterwards. The client received a failure; the write committed anyway.

**Why this matters.** From the client's perspective the tool failed. A well-behaved agent may retry, creating a duplicate. The review guarantee ("user sees diff before write commits") is undermined if the response channel closes before the approval is returned — the user approved, the write happened, but the tool reported failure.

**Root cause hypothesis.** The diff-modal flow in `plugin/src/mcp-server.ts` (`runWrite` / `gateVaultWrite`) calls `op.review(...)`, which awaits `DiffReviewModal` resolution. If the user takes longer than `HTTP_TIMEOUT_MS` (15 s, set in `workspace/.claude/scripts/obsidian-mcp-proxy.js:40` as `envInt("OAS_MCP_TIMEOUT_MS", 15000)`) to approve, the proxy's HTTP timeout fires and closes the response channel. The plugin continues execution after `review()` resolves — `apply()` runs and the file is written — but the response it attempts to send finds no open channel. The write committed; the client got an error.

**Fix path options.**

Option A: Raise `mcpReviewTimeout` default above `OAS_MCP_TIMEOUT_MS`. Fragile — two independent timeouts must stay coordinated across config and environment variable, with no enforcement of the relationship.

Option B (recommended): Convert reviewed-write tool handlers to emit periodic SSE keepalive frames while the modal is awaiting approval. `StreamableHTTPServerTransport` already supports SSE streams; the current reviewed-write path uses a plain JSON response. Switching to a streaming response while the modal is open keeps the HTTP connection alive regardless of how long the user takes. The final frame carries the success/error result. This eliminates the two-timeout race entirely.

**Test addition.** Integration test: simulate a 20 s modal delay (stub `review` to resolve after 20 s); assert the client receives a success result, not a timeout; assert the file exists and was written exactly once.

**Blocked on:** not believed downstream of PR-2. Can be worked independently.

**Files to change:** `plugin/src/mcp-server.ts` (keepalive framing on reviewed-write handlers), `workspace/.claude/scripts/obsidian-mcp-proxy.js` (document or raise `OAS_MCP_TIMEOUT_MS` default).

---

## P1 — S5.5 and S8.4: Zod strict type rejection for boolean and number parameters

**Evidence.** Cell B:

- `vault_batch_frontmatter { dryRun: "false" }` → `MCP error -32602: Invalid input: expected boolean, received string`
- `vault_tasks_toggle { line: "5" }` → `MCP error -32602: Invalid input: expected number, received string`

Both passed in Cells A and C. The Cell B failures are consistent with degraded state, but the underlying issue is architectural and will resurface in any clean session: LLMs serialize tool arguments as JSON strings. A model calling `vault_tasks_toggle` with `line: 17` may emit `"17"` rather than `17`.

**Root cause.** `plugin/src/mcp-extensions.ts` uses `z.number()` for `vault_tasks_toggle`'s `line` parameter. `plugin/src/mcp-tools.ts` uses `z.boolean()` for `vault_batch_frontmatter`'s `dryRun` parameter (inferred via `addWriteTools` / `defineTool`). Zod's strict type validators reject stringified scalars without coercion.

**Fix.** Replace `z.boolean()` with `z.coerce.boolean()` and `z.number()` with `z.coerce.number()` for these slots. Audit every boolean and number parameter across both files for the same pattern — `vault_patch`'s `line` parameter (`z.number().optional()`) and any boolean flags should be coerced. `z.coerce.boolean()` converts `"false"` to `true` (non-empty string → truthy); if that is surprising, use `z.preprocess` with explicit `"false"` → `false` mapping instead.

**Test addition.** Unit tests asserting:
- `vault_batch_frontmatter { dryRun: "false" }` parses identically to `{ dryRun: false }`.
- `vault_tasks_toggle { line: "17" }` parses identically to `{ line: 17 }`.
- `vault_batch_frontmatter { dryRun: "true" }` parses as `true`.

**Re-test note.** Re-run Cells A/B/C after both this fix and PR-2. The Cell B-only appearance of these failures is likely state contamination, not a genuine Cell B–specific regression.

**Files to change:** `plugin/src/mcp-tools.ts`, `plugin/src/mcp-extensions.ts`.

---

## P1 — S8.5: vault_templater_create 10 s timeout

**Evidence.** Cell B: `vault_templater_create` returned `"Tool 'vault_templater_create' did not respond within 10s"`. Cells A and C both show it passing (`PASS — Created agent-workspace/mcp-test/from-template.md`). All three runs had all extensions enabled.

**Classification.** The Cell B–only failure is consistent with degraded session state — multiple Cell B failures appeared together after a session break. This is the most likely explanation given the clean passes in A and C.

**Hypothesis if it reproduces.** The Templater plugin's `create_new_note_from_template` API may block on a user prompt or an unresolved dynamic snippet in the template. The 10 s tool timeout (`plugin/src/mcp-server.ts: selectTimeoutMs` returns `toolTimeoutMs` for non-reviewed tools) fires before Templater returns.

**Re-test note.** Re-run a clean Cell B after PR-2 lands. If `vault_templater_create` still times out, inspect `plugin/src/templater-adapter.ts` — specifically `executeTemplateFromContent` and the post-validate guard — and compare which template is used in the passing vs failing runs. If it reproduces consistently, escalate to a new P0/P1 bug with the template content and Obsidian console output as evidence.

**Files to change (if it reproduces):** `plugin/src/mcp-extensions.ts` (`registerTemplaterTools`), `plugin/src/templater-adapter.ts`.

---

## P2 — S1.4: vault_list ignores path parameter

**Evidence.** Three consecutive calls in Cell B with `{ "path": "agent-workspace/mcp-test" }` returned the full vault listing (~160 items) instead of an empty list for the empty folder. The same call returned `"(no files)"` correctly in Cells A and C.

**Classification.** Almost certainly downstream of stale session state. The `vault_list` handler in `plugin/src/mcp-tools.ts` (lines 502–516) uses `isPathWithinDir(f.path, folder)` for filtering — a plain string comparison that does not depend on session state. The most plausible explanation for the Cell B anomaly is that `folder` was `undefined` in the parsed args (degraded MCP deserialization), which caused the filter to be skipped.

**Re-test note.** Re-test after PR-2 in a clean Cell B run. If it reproduces, inspect the `vault_list` handler for the path-arg threading — specifically whether the `folder` parameter arrives as `undefined` vs empty string, and whether `isPathWithinDir("", folder)` short-circuits the filter.

**Files to change (if it reproduces):** `plugin/src/mcp-tools.ts` (`vault_list` handler, lines 502–516).

---

## P2 — S8.6: vault_canvas_modify schema mismatch

**Evidence.** In Cell B, the agent called `vault_canvas_modify` with `{ nodes: [...], edges: [...] }` and received:

```
MCP error -32602: Invalid arguments for tool vault_canvas_modify: [
  {"expected": "string", "code": "invalid_type", "path": ["changes"], "message": "Invalid input: expected string, received undefined"}
]
```

The tool description reads "edit canvas nodes/edges", which implies separate structured parameters. The actual schema (`plugin/src/mcp-extensions.ts`, `CanvasChangesSchema`, lines 166–171) uses a single `changes` string containing JSON: `{ addNodes?, removeNodeIds?, addEdges?, removeEdgeIds? }`. Cells A and C passed by sending the correct `changes` JSON string.

**Root cause.** The tool description does not surface the `changes: string (JSON)` contract. Agents infer a structured `nodes/edges` interface from the description and fail on first attempt.

**Fix path.** Two options:

1. Update the `description` field in `plugin/src/mcp-extensions.ts` to prominently document the `changes` string format and show a one-line example JSON payload. The existing description already mentions the JSON structure but buries it.
2. Extend the schema to accept either a `changes` JSON string or structured `addNodes`/`removeNodeIds`/`addEdges`/`removeEdgeIds` fields directly (parsing the latter into the `CanvasChanges` shape internally). This removes the serialization step the caller must perform.

The description fix is lower-risk. The structured-input option is more ergonomic for LLMs but requires schema migration and broader testing.

**Test addition.** Unit test asserting a call with `nodes`/`edges` fields returns a clear schema-mismatch error (not a crash), and a call with a valid `changes` JSON string succeeds.

**Re-test note.** Not believed downstream of PR-2 (schema mismatch is deterministic). Can be confirmed against a Cell A run.

**Files to change:** `plugin/src/mcp-extensions.ts` (`vault_canvas_modify` description or inputSchema).

---

## P2 — S8.8: vault_periodic_note missing default for periodicity

**Evidence.** Calling `vault_periodic_note {}` in Cell B returned:

```
MCP error -32602: Invalid arguments for tool vault_periodic_note: [
  {"code": "invalid_value", "values": ["daily","weekly","monthly","quarterly","yearly"], "path": ["periodicity"], "message": "Invalid option: expected one of \"daily\"|\"weekly\"|\"monthly\"|\"quarterly\"|\"yearly\""}
]
```

The tool description says "Locate (and optionally create) a periodic note — daily/weekly/monthly/quarterly/yearly" and the summary implies today's daily note when called with no arguments. The schema in `plugin/src/mcp-extensions.ts` (line 811–815) uses `z.enum([...]).describe(...)` with no `.default()`, making `periodicity` required.

**Fix.** Add `.default("daily")` to the `periodicity` enum:

```typescript
periodicity: z
  .enum(["daily", "weekly", "monthly", "quarterly", "yearly"])
  .default("daily")
  .describe("Which periodic note to resolve (default: daily)"),
```

Alternatively, if a required parameter is the intended design, update the description to make the requirement explicit and remove the "today's daily note" implication.

**Test addition.** Unit test asserting `vault_periodic_note {}` resolves `periodicity` to `"daily"`.

**Re-test note.** Not believed downstream of PR-2. Reproducible deterministically in any clean run.

**Files to change:** `plugin/src/mcp-extensions.ts` (`registerPeriodicNotesTools`, `periodicity` schema).

---

## Investigate — S2.9: Frontmatter array stored as JSON string

**Evidence.** Cell B only: `vault_frontmatter_set { property: "tags", value: ["x", "y"] }` stored the value as `tags: '["x", "y"]'` (a YAML string) rather than a proper YAML array (`tags:\n  - x\n  - y`). The same operation in Cells A and C stored it correctly as a YAML list.

**Classification.** Almost certainly downstream of stale session state. The `vault_frontmatter_set` handler in `plugin/src/mcp-tools.ts` passes `value` directly to `app.fileManager.processFrontMatter(f, (fm) => { fm[property] = value; })`. Obsidian's `processFrontMatter` is expected to serialize arrays as YAML lists; a stringified array input (`"[\"x\",\"y\"]"` rather than `["x","y"]`) would produce the observed output. The most likely explanation is that `value` arrived as a JSON-serialized string due to stale MCP deserialization.

**Re-test note.** Re-run Cell B after PR-2 and confirm `tags: [x, y]` is produced. If the JSON-string behavior reproduces in a clean session, file as a new P1 and audit the frontmatter write path — specifically whether `value` is being double-encoded somewhere between the MCP transport and `processFrontMatter`.

**Files to change (if it reproduces):** `plugin/src/mcp-tools.ts` (`vault_frontmatter_set` handler, the `apply` lambda).
