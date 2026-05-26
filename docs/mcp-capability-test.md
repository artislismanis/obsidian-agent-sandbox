# Obsidian MCP Capability Test Plan

A Claude-driven sweep of every tool exposed by the in-repo Obsidian MCP server. Produces a matrix-format report listing how each tool behaves against a real vault on a real Obsidian instance.

This complements [qa-test-plan.md](./qa-test-plan.md) — that plan is a human-driven UI/UX checklist; this one is an LLM-driven tool-surface sweep. Run it whenever the tool surface changes (new tool, new tier, schema rev), as part of release validation, or whenever you want a high-confidence "the server still does what its tools claim" signal.

The plan covers only the MCP surface. Container lifecycle, terminal UX, review modals, and platform edges live in `qa-test-plan.md`.

## Permission cells

| Cell | Nav | Mng | Ext | Write mode | Active tier tags |
|------|-----|-----|-----|------------|-----------------|
| A | ON | ON | ON | none | read, writeScoped, agent, navigate, manage, extensions |
| B | ON | ON | ON | reviewed | + writeReviewed |
| C | ON | ON | ON | full | + writeVault |
| D | OFF | ON | ON | none | read, writeScoped, agent, manage, extensions |
| E | ON | OFF | ON | none | read, writeScoped, agent, navigate, extensions |
| F | ON | ON | OFF | none | read, writeScoped, agent, navigate, manage |

Cell B's active set extends cell A's with `writeReviewed`; cell C extends A's with `writeVault`. The `+ writeReviewed` / `+ writeVault` notation is additive, not replacement.

**Full-sweep cells (A, B, C):** run all scenarios; skip only those whose `Requires:` tag is not in the active set.

**Smoke cells (D, E, F):** run only scenarios whose `Requires:` tag set is no longer satisfied by the cell — mark the rest `SKIPPED (cell D/E/F)`. Always run S0.1 and S9.5 regardless.

**Run-file naming convention:** `workspace/mcp-testing/<YYYY-MM-DD>-cell-<letter>-<short-name>.md`  
Examples: `2026-05-26-cell-A-baseline.md`, `2026-05-26-cell-B-reviewed-write.md`, `2026-05-26-cell-C-full-write.md`.

The three existing run files correspond to cells A, B, and C:
- `mcp-capability-test-run-2026-05-26.md` → cell A (baseline, write mode none)
- `mcp-capability-test-run-2026-05-26-review-write.md` → cell B
- `mcp-capability-test-run-2026-05-26-full-write.md` → cell C

---

## Prerequisites

- Sandbox container running with a test vault open in Obsidian and the plugin enabled (per `qa-test-plan.md` Stages 0–2).
- `workspace/.mcp.json` wires `obsidian` to `workspace/.claude/scripts/obsidian-mcp-proxy.js`. The proxy talks to the plugin's MCP HTTP server (`plugin/src/mcp-server.ts`); tools are defined in `plugin/src/mcp-tools.ts` and `plugin/src/mcp-extensions.ts`.
- A Claude Code session **inside the container** attached to that MCP server. Tools appear under the `mcp__obsidian__` prefix; bare names (`vault_read`, …) are used below — call them with the prefix.
- For cross-checking results, the plugin's audit log is at `<vault>/.oas/mcp-audit.jsonl` (one JSONL entry per call).

## How to use

1. Hand this file to the in-container Claude Code session: *"Run the capability test plan in `docs/mcp-capability-test.md` against this vault."*
2. Claude executes scenarios sequentially, persisting a partial report to disk after each group (see [Managing context](#managing-context)).
3. After **S10 — Cleanup**, Claude emits the consolidated final report using the [Final report format](#final-report-format).
4. Triage anomalies and coverage gaps; file issues; rerun if the surface changed.

## Naming and placeholders

| Placeholder | Resolves to |
|-------------|-------------|
| `${SANDBOX}` | Sandbox folder under the active `writeDir` from S0.1. Default: `mcp-test/`. Created in S0.3. |
| `${PROBE}` | A pre-existing markdown note used for read-only tools. Pick any vault note outside `${SANDBOX}`. If the vault is empty, create `${SANDBOX}/probe.md` first and use that. |
| `${PROBE_BASENAME}` | Basename of `${PROBE}` without extension (e.g. `Welcome` for `Welcome.md`). |
| `${PROBE_BASENAME_TYPO}` | `${PROBE_BASENAME}` with one character substituted (e.g. `Welcome` → `Welkome`). For fuzzy-search exercise. |
| `${PROBE2}` | A second pre-existing note linked to `${PROBE}` via `[[wikilink]]`. Used for graph-path scenarios. If none exists, mark graph-path scenarios `SKIPPED (no linked pair)`. |

Capture the resolved values in the final report's Environment section.

## Managing context

A full sweep produces a lot of tool output. Without discipline you'll exhaust the conversation context before reaching the final report. Follow these rules:

1. **Persist as you go.** After every group (S0, S1, S2, …) write the partial matrix and verbatim evidence collected so far to `workspace/mcp-testing/<YYYY-MM-DD>-cell-<letter>-<short-name>.md` on the container filesystem (use your `Write` / `Bash` tool, not MCP — this is a host-side scratch file, not a vault note). This file is the canonical record; the conversation is just working memory.
2. **Paraphrase results, quote errors.** For each tool result, record:
   - **Success**: a one-line summary of the returned shape (top-level keys, item count, first item snippet). Paste full payloads only where this doc explicitly asks (e.g. `mcp_capabilities` in S0.1, the cumulative `alpha.md` body in S2, the tree in S5, schemas in S2.7 / S5.5 / S7.1 / S8.5 / S8.8).
   - **Failure**: the **verbatim** error message — code, text, hint, structured fields. Do not paraphrase errors.
3. **Compact between groups.** After flushing a group to the run file, run `/compact` (or your client's equivalent) before starting the next group. Reload only the run file's path and the next group's section of this plan; do not reload prior tool outputs.
4. **Stop-loss budget.** If you reach <20% context remaining mid-group, stop, flush whatever is collected, mark unfinished scenarios `INCOMPLETE`, and emit the final report. A partial report with intact verbatim errors is more useful than a complete one squeezed into compaction.

## Instructions to Claude

You are exercising every capability of the Obsidian MCP server.

**Cell mode**

1. Read the cell letter from the run file's header (e.g. "Cell B").
2. Look up the cell's active tag set in the [Permission cells](#permission-cells) table above.
3. Before running each scenario, check its `Requires:` value. If any required tag is absent from the active set, mark the scenario `SKIPPED (cell)` without calling any tool, and continue to the next.
4. Smoke cells (D, E, F): only scenarios that become SKIPPED in this cell need to be visited — these confirm the tier gate is working. S0.1 and S9.5 always run.

For **each scenario**:

1. Run the listed tool call with the exact inputs shown (or the documented variant).
2. Capture evidence per the rules in [Managing context](#managing-context).
3. **One shot per scenario.** Do not retry on failure.
4. If a scenario depends on a prior one and the prior failed, mark it `BLOCKED` and explain.
5. All mutations are confined to `${SANDBOX}` (created in S0). Do not touch anything else in the vault.
6. After all groups, emit the final report.

Run scenarios sequentially. Parallel tool calls are allowed only within one scenario when noted.

---

## S0 — Setup and capability discovery (mandatory first)

`Requires: (any)` — all S0 scenarios are mandatory regardless of cell.

### S0.1 mcp_capabilities

Inputs: `{}`.

Record verbatim: `enabledTiers`, `alwaysOn`, `escalations`, `writeDir`, `toolsByTier` (full lists), `rateLimits`. This output drives the rest of the run. If a tier is **disabled**, mark every scenario gated on that tier `SKIPPED (tier disabled)` and proceed — do not attempt the call.

### S0.2 Resolve placeholders

Pick `${SANDBOX}` under the active `writeDir` (default `<writeDir>/mcp-test/`). Pick `${PROBE}` and `${PROBE2}` from existing vault notes (see [Naming and placeholders](#naming-and-placeholders)). Record the absolute vault path of `${SANDBOX}` and the resolved placeholders.

### S0.3 Create sandbox folder

`vault_create_folder` is in the **`manage` tier** (gated). If `manage` is enabled, call it:

- Tool: `vault_create_folder`
- Inputs: `{ path: "${SANDBOX}" }`

If `manage` is disabled, **do not call** `vault_create_folder`. Instead, create the sandbox implicitly by running `vault_create { path: "${SANDBOX}/.placeholder.md", content: "sandbox marker\n" }` — Obsidian's `vault.create` materialises intermediate folders. Mark S5.3, S5.4, S5.6 (folder-mutation scenarios) `SKIPPED (manage tier disabled)`.

If both paths fail, mark all write scenarios `BLOCKED`.

---

## S1 — Read tier (always on)

`Requires: read`

Pick `${PROBE}` per S0.2. Record the **exact tool-name string** the server returned in S0.1 for each row (catches drift like `vault_search_fuzzy` vs `vault_searchFuzzy`).

| ID | Tool | Inputs |
|----|------|--------|
| S1.1 | `vault_read` | `{ path: "${PROBE}" }` |
| S1.2 | `vault_read` (missing) | `{ path: "does/not/exist-xyz.md" }` — expect error |
| S1.3 | `vault_list` | `{}` (root) |
| S1.4 | `vault_list` | `{ path: "${SANDBOX}" }` |
| S1.5 | `vault_search` | `{ query: "the" }` (or any common token) |
| S1.6 | `vault_search` | `{ query: "qwertyzxcv-no-match-token" }` |
| S1.7 | `vault_search_fuzzy` | `{ query: "${PROBE_BASENAME_TYPO}" }` |
| S1.8 | `vault_file_info` | `{ path: "${PROBE}" }` |
| S1.9 | `vault_tags` | `{}` |
| S1.10 | `vault_frontmatter` | `{ path: "${PROBE}" }` |
| S1.11 | `vault_links` | `{ path: "${PROBE}" }` |
| S1.12 | `vault_backlinks` | `{ path: "${PROBE}" }` |
| S1.13 | `vault_headings` | `{ path: "${PROBE}" }` |
| S1.14 | `vault_orphans` | `{}` |
| S1.15 | `vault_unresolved` | `{}` |
| S1.16 | `vault_recent` | `{}` |
| S1.17 | `vault_properties` | `{}` |
| S1.18 | `vault_graph_neighborhood` | `{ path: "${PROBE}" }` (default depth; record what depth the server used) |
| S1.19 | `vault_graph_path` | `{ source: "${PROBE}", target: "${PROBE2}" }` — argument names are `source` / `target`, not `from` / `to`. If `${PROBE2}` is not set, skip with reason. |
| S1.20 | `vault_graph_clusters` | `{}` |
| S1.21 | `vault_context` | `{ path: "${PROBE}" }` |
| S1.22 | `vault_suggest_links` | `{ path: "${PROBE}" }` |

> **Flush to run file, then `/compact` before S2.**

---

## S2 — Write tier — scoped (`writeScoped`, no suffix)

`Requires: writeScoped`

Default `writeScoped` tools — gated to `writeDir`. All inputs are scoped under `${SANDBOX}`.

| ID | Tool | Inputs |
|----|------|--------|
| S2.1 | `vault_create` | `{ path: "${SANDBOX}/alpha.md", content: "# Alpha\n\nInitial body. #mcp-test\n" }` |
| S2.2 | `vault_create` | `{ path: "${SANDBOX}/beta.md", content: "# Beta\n\n[[alpha]]\n" }` |
| S2.3 | `vault_modify` | `{ path: "${SANDBOX}/alpha.md", content: "# Alpha\n\nRewritten body.\n" }` |
| S2.4 | `vault_append` | `{ path: "${SANDBOX}/alpha.md", content: "\n\nAppended line.\n" }` |
| S2.5 | `vault_prepend` | `{ path: "${SANDBOX}/alpha.md", content: "Prepended line.\n\n" }` |
| S2.6 | `vault_search_replace` | `{ path: "${SANDBOX}/alpha.md", search: "Rewritten", replace: "Replaced" }` — argument is `search`, not `find`. |
| S2.7 | `vault_patch` | `{ path: "${SANDBOX}/alpha.md", heading: "Alpha", position: "after", content: "Patched paragraph.\n" }` — targets the `Alpha` H1 from S2.1. |
| S2.8 | `vault_frontmatter_set` | `{ path: "${SANDBOX}/alpha.md", property: "status", value: "draft" }` — the key is `property`, not `key`. |
| S2.9 | `vault_frontmatter_set` | `{ path: "${SANDBOX}/alpha.md", property: "tags", value: ["x", "y"] }` |
| S2.10 | `vault_frontmatter_delete` | `{ path: "${SANDBOX}/alpha.md", property: "status" }` |
| S2.11 | **Scope-violation probe**: `vault_create` | `{ path: "outside-sandbox-xyz.md", content: "x" }` — expect synchronous rejection. Confirm the file was **not** created (verify with `vault_read` and capture that error too). |

After S2.11, run `vault_read { path: "${SANDBOX}/alpha.md" }` and paste the final body verbatim into the run file — this is the cumulative-effect check for S2.3–S2.10.

> **Flush + `/compact` before S3.**

---

## S3 — Reviewed-write tier (suffix `_reviewed`)

`Requires: writeReviewed`

Only run if S0.1's `enabledTiers` includes `writeReviewed`. These prompt a diff modal in Obsidian — **a human must approve each one in real time**. Before starting, tell the user: *"S3 will trigger 4 approval modals — approve or reject each as instructed in the plan."*

| ID | Tool | Inputs | Approval action |
|----|------|--------|-----------------|
| S3.1 | `vault_create_reviewed` | `{ path: "${SANDBOX}/reviewed.md", content: "reviewed-create\n" }` | **Approve** |
| S3.2 | `vault_modify_reviewed` | `{ path: "${SANDBOX}/reviewed.md", content: "reviewed-modify\n" }` | **Approve** |
| S3.3 | `vault_append_reviewed` | `{ path: "${SANDBOX}/reviewed.md", content: "appended\n" }` | **Reject** — confirm file unchanged via `vault_read` |
| S3.4 | `vault_create_reviewed` (outside sandbox) | `{ path: "review-outside.md", content: "x" }` | **Approve** — reviewed tier is unscoped, so this should succeed |

Record both the modal outcome and the tool's return value for each.

> **Flush + `/compact` before S4.**

---

## S4 — Vault-wide write tier (suffix `_anywhere`)

`Requires: writeVault`

Only run if `writeVault` is enabled. These bypass scope and review — **destructive if misused**. Confine all paths to `${SANDBOX}`.

| ID | Tool | Inputs |
|----|------|--------|
| S4.1 | `vault_create_anywhere` | `{ path: "${SANDBOX}/wide.md", content: "anywhere\n" }` |
| S4.2 | `vault_modify_anywhere` | `{ path: "${SANDBOX}/wide.md", content: "anywhere-modified\n" }` |
| S4.3 | `vault_frontmatter_set_anywhere` | `{ path: "${SANDBOX}/wide.md", property: "wide", value: true }` |

---

## S5 — Manage tier (rename, move, delete, folders, batch)

`Requires: manage`

All tools below are in the `manage` tier. Skip the whole section (`SKIPPED (manage tier disabled)`) if `manage` was absent from S0.1's `enabledTiers`.

| ID | Tool | Inputs |
|----|------|--------|
| S5.1 | `vault_rename` | `{ path: "${SANDBOX}/beta.md", name: "beta-renamed.md" }` |
| S5.3 | `vault_create_folder` | `{ path: "${SANDBOX}/subdir" }` (run before S5.2) |
| S5.2 | `vault_move` | `{ path: "${SANDBOX}/beta-renamed.md", to: "${SANDBOX}/subdir" }` — `to` is the destination **folder**; the file keeps its name. |
| S5.4 | `vault_create_folder` (duplicate) | same inputs as S5.3 — capture how the server reports re-creation |
| S5.5 | `vault_batch_frontmatter` | `{ folder: "${SANDBOX}", property: "status", value: "test", dryRun: false }` — `folder` scopes the batch; omitting both `folder` and `query` is rejected. |
| S5.6 | `vault_delete` (folder) | `{ path: "${SANDBOX}/subdir" }` — recursive folder delete. Note whether `subdir` is empty at this point or still contains the moved beta file. |
| S5.7 | `vault_delete` (file) | `{ path: "${SANDBOX}/wide.md" }` — only if S4 ran |

Scenarios are listed in execution order (S5.3 runs before S5.2 because move needs the destination folder).

After S5, run `vault_list { path: "${SANDBOX}" }` and paste the resulting tree into the run file.

> **Flush + `/compact` before S6.**

---

## S6 — Navigate tier

`Requires: navigate`

Only run if `navigate` is in S0.1's `enabledTiers`.

| ID | Tool | Inputs |
|----|------|--------|
| S6.1 | `vault_open` | `{ path: "${SANDBOX}/alpha.md" }` — record whether the active pane changes in Obsidian |
| S6.2 | `vault_open` (missing) | `{ path: "does/not/exist.md" }` — capture error |

---

## S7 — Agent / meta

`Requires: agent`

| ID | Tool | Inputs |
|----|------|--------|
| S7.1 | `agent_status_set` | `{ status: "working", detail: "mcp test" }` — `status` is the enum `idle` / `working` / `awaiting_input`; the message argument is `detail` (not `note`) |
| S7.2 | `agent_status_set` (clear) | `{ status: "idle" }` |
| S7.3 | `mcp_capabilities` (second call) | `{}` — diff against S0.1; capture any drift |

---

## S8 — Extensions tier (Dataview / Templater / Tasks / Canvas / Periodic Notes)

`Requires: extensions`

Only run if `extensions` is enabled. Use S8.0 to discover which integrations are wired.

### S8.0 plugin_extensions_list

`Requires: extensions`

Inputs: `{}`. Record which extensions report `enabled`. Skip sub-scenarios for any that aren't, marking `SKIPPED (extension unavailable)`.

| ID | Requires | Tool | Inputs |
|----|----------|------|--------|
| S8.1 | `extensions +DataviewPlugin` | `vault_dataview_query` | `{ query: "LIST FROM \"${SANDBOX}\"" }` |
| S8.2 | `extensions +DataviewPlugin` | `vault_dataview_query` (invalid) | `{ query: "NOT A QUERY" }` |
| S8.3 | `extensions +TasksPlugin` | `vault_tasks_query` | inspect the tool's schema, send a minimal valid query (e.g. all open tasks). If no tasks exist, append `- [ ] test task\n` to `${SANDBOX}/alpha.md` first via `vault_append`. |
| S8.4 | `extensions +TasksPlugin` | `vault_tasks_toggle` | `{ path: "${SANDBOX}/alpha.md", line: <line-of-task-from-S8.3> }` |
| S8.5 | `extensions +TemplaterPlugin` | `vault_templater_create` | inspect schema; create `${SANDBOX}/from-template.md` from any available template. If no templates configured, mark `SKIPPED (no templates)` and paste the schema. |
| S8.6 | `extensions` | `vault_canvas_modify` | create a minimal `${SANDBOX}/board.canvas` with one text node (consult the schema) |
| S8.7 | `extensions` | `vault_canvas_read` | `{ path: "${SANDBOX}/board.canvas" }` |
| S8.8 | `extensions +PeriodicNotesPlugin` | `vault_periodic_note` | `{ }` — defaults to today's daily note. Inspect schema first; capture how it behaves when the note already exists. |

The `+Plugin` qualifiers mean both the `extensions` tier tag and the named plugin must be present. Plugin availability is discovered at runtime from S8.0's output, not from the cell definition.

> **Flush + `/compact` before S9.**

---

## S9 — Cross-cutting / failure modes

`Requires: (any)`

These probe behaviour that isn't tool-specific.

### S9.1 Rate limiting

Pick `rateLimits.defaultReadsPerMin` from S0.1. Issue `defaultReadsPerMin + 5` calls of `vault_list { }` in rapid succession (sequentially, no sleep). Record the index at which the first rate-limit error appears and its **verbatim** message.

> **Context budget note:** Each `vault_list` response can be large. To avoid exhausting context, issue the burst via Bash rather than MCP tool calls. Capture only the response that first returns a rate-limit error verbatim; summarise the rest as "200 OK".
>
> ```bash
> # Example burst — replace TOKEN and PORT with values from S0.2 / plugin settings:
> for i in $(seq 1 $N); do
>   curl -sS -o /dev/null -w "%{http_code}\n" \
>     -H "Authorization: Bearer $TOKEN" \
>     -H "Content-Type: application/json" \
>     -X POST "http://127.0.0.1:$PORT/mcp" \
>     -d '{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"vault_list","arguments":{}}}'
> done
> ```

### S9.2 Unknown tool

Call `mcp__obsidian__vault_does_not_exist` with `{}`. Capture the error.

### S9.3 Wrong-type arg

Call `vault_read` with `{ path: 123 }` (number instead of string). Capture the verbatim validation error.

### S9.4 Missing required arg

Call `vault_read` with `{}`. Capture the verbatim error.

### S9.5 Disabled-tier probe

If at least one tier is disabled per S0.1, pick any tool from that tier and call it with otherwise-valid inputs. Confirm it isn't exposed and capture the error — distinguish "tool not found" from "tier disabled".

### S9.6 Concurrent tool calls

Issue three `vault_list { }` calls in parallel within a single tool-invocation batch. Record whether all three complete, any ordering anomalies, and whether interleaved responses arrive correctly. If the client does not support parallel invocation, issue them in rapid sequential bursts instead and note the method used.

### S9.7 Path-traversal probe

`Requires: (any)`

Prerequisite: `<vault-root>/evil.md` → `/etc/hosts` symlink must exist. Create it from the host before running this scenario:

```bash
ln -sf /etc/hosts <vault>/evil.md
```

(`container/test-scripts/security-checks.sh` creates this fixture automatically once that script lands; remove it after the run.)

Call `vault_read { path: "evil.md" }`. Capture the verbatim error. Confirm that the content of `/etc/hosts` (first line begins `#`) does **not** appear anywhere in the response.

---

## S10 — Cleanup

`Requires: (any)`

Use the highest-privilege write tier available — `writeVault` if enabled, else `writeReviewed`, else `manage`'s `vault_delete` (note which).

1. `vault_delete` on `${SANDBOX}` (recursive folder delete).
2. If `review-outside.md` was created in S3.4, delete it.
3. `vault_list { path: "${SANDBOX}" }` — confirm not-found error.

Mark `SKIPPED (no delete-capable tier)` if no available tool can reach the cleanup target. Leftover state in that case should be flagged in the final report's Anomalies section.

---

## Final report format

```
# Obsidian MCP Capability Test Report — <ISO date> — <vault name>

## Environment
- Vault path: ...
- Plugin version (from manifest.json if accessible): ...
- ${SANDBOX} / ${PROBE} / ${PROBE2}: ...
- enabledTiers / alwaysOn / escalations: ...
- writeDir: ...
- Extensions available (S8.0): ...
- Rate limits: ...

## Results matrix
| ID | Tool | Status | Notes (≤120 chars) |
|----|------|--------|--------------------|
| S0.1 | mcp_capabilities | PASS | tiers=[read,writeScoped,...] |
| S1.2 | vault_read | EXPECTED-FAIL | "File not found" |
| ... |

(Status values: PASS, FAIL, EXPECTED-FAIL, BLOCKED, SKIPPED, AMBIGUOUS, INCOMPLETE)

## Detailed evidence

### S0.1
- Inputs: {}
- Result (verbatim JSON):
  ```json
  ...
  ```
- Observations: ...

### S1.2
- Inputs: { "path": "does/not/exist-xyz.md" }
- Error (verbatim):
  ```
  ...
  ```
- Observations: error shape matches MCP spec? error code present?

(repeat for every scenario — including SKIPPED, with the *why*)

## Cumulative file state
- ${SANDBOX}/alpha.md after S2 (full body):
  ```
  ...
  ```
- vault_list ${SANDBOX} after S5 (full tree):
  ```
  ...
  ```

## Anomalies & follow-ups
- Bullets: undocumented fields, inconsistent error shapes, schema drift between
  the description and accepted args, surprising tier behaviour, anywhere
  the spec/code disagrees with observed behaviour.

## Coverage gaps
- Tools that appear in S0.1's `toolsByTier` but weren't exercised — and why.
- Schemas inspected during the run (S2.7, S5.5, S7.1, S8.3, S8.5, S8.8) — paste verbatim.
```

---

## Notes for the operator

- This script assumes the test vault has at least one existing markdown note for `${PROBE}`. If it doesn't, S0.2 creates one inside `${SANDBOX}` and uses that.
- S3 needs a human at the keyboard for the diff modals. Skip the section entirely if the run is unattended — do not auto-dismiss.
- Cross-check the run file against `<vault>/.oas/mcp-audit.jsonl` as a second pass — the audit log records every call the server saw.
- If you find a tool listed in S0.1's `toolsByTier` that isn't covered above, add it to **Coverage gaps** rather than improvising — consistency across runs is the whole point.
- Run-file convention: `workspace/mcp-testing/<YYYY-MM-DD>-cell-<letter>-<short-name>.md` (e.g. `2026-05-26-cell-A-baseline.md`). Keep runs; diffing successive reports catches regressions cheaply.
