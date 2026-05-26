# QA test-plan restructure — Stage 3 + capability test

**Status:** proposed
**Affects:** `docs/qa-test-plan.md`, `docs/mcp-capability-test.md`

---

## Problem

Stage 3 of `qa-test-plan.md` and `mcp-capability-test.md` overlap substantially. Ten of Stage 3's twenty scenarios are already covered scenario-for-scenario by the capability test's S0–S10 sweep. Running both against the same vault duplicates effort and yields no additional signal.

A second problem: the capability test currently assumes a single fixed permission state. Verifying tier-gating requires running the entire sweep multiple times with different settings, but the plan gives no structure for that — which cells to run, which scenarios to skip in which configuration, or how to name the resulting run files.

Stage 3 also contains two tier-toggle scenarios (3.7, 3.19) written as prose steps, when the same assertions are already implied by the capability test's matrix structure. They belong in the matrix, not the checklist.

---

## Proposed Stage 3 changes

### Remove (fully covered by the capability test)

3.1 (tool announcement — S0.1), 3.2 (vault search — S1.5), 3.3 (vault read — S1.1), 3.4 (write scoped create — S2.1), 3.5 (scope violation — S2.11), 3.8 (rename with backlinks — S5.1), 3.9 (move — S5.2), 3.10 (delete + create folder — S5.3/S5.6), 3.14 (read-toolbelt spot-check — S1.*), 3.15 (vault_append — S2.4).

### Keep (UI/UX or host-process — human must verify)

- **3.6**: Slim to the single UI assertion: "active tab changes in Obsidian". The `vault_open` call itself is covered by S6.1.
- **3.11**: Settings UI inspection — confirm only three toggles (Navigate, Manage, Extensions) and one dropdown appear; no toggle for always-on tiers.
- **3.12**: Token rotation + auth failure (host-process, plugin-side).
- **3.13**: MCP off mid-session — tools fail cleanly; re-enable restores access.
- **3.16**: Cache invalidation after human edits in Obsidian — requires a human typing in the live editor.
- **3.17**: Concurrent MCP tool calls — no automated coverage; stays here pending a capability test addition to S9.
- **3.18**: File ownership after Claude writes (Linux host UID concern).
- **3.20**: Awaiting-input badge — status-bar pill, human-visible only.

### Move to capability test matrix (tier-toggle scenarios)

- **3.7** ("Navigate disabled removes tool from list + calling it returns clean error") — this is exactly what cells D/E/F cover via S0.1 + S9.5.
- **3.19** ("Vault write mode = full; _anywhere tools appear; switch to none, they disappear") — cell C vs cell A in the matrix.

---

## Permission cells matrix

Add a "Permission cells" section near the top of `mcp-capability-test.md`, before the Prerequisites.

| Cell | Nav | Mng | Ext | Write mode | Active tier tags |
|------|-----|-----|-----|------------|-----------------|
| A | ON | ON | ON | none | read, writeScoped, agent, navigate, manage, extensions |
| B | ON | ON | ON | reviewed | + writeReviewed |
| C | ON | ON | ON | full | + writeVault |
| D | OFF | ON | ON | none | read, writeScoped, agent, manage, extensions |
| E | ON | OFF | ON | none | read, writeScoped, agent, navigate, extensions |
| F | ON | ON | OFF | none | read, writeScoped, agent, navigate, manage |

**Full-sweep cells (A, B, C):** run all scenarios; skip only those whose `Requires:` tag is not in the active set.

**Smoke cells (D, E, F):** run only scenarios whose `Requires:` tag set is no longer satisfied by the cell — mark the rest `SKIPPED (cell D/E/F)`. Always run S0.1 and S9.5 regardless.

**Run-file naming convention:** `workspace/mcp-testing/<YYYY-MM-DD>-cell-<letter>-<short-name>.md`
Examples: `2026-05-26-cell-A-baseline.md`, `2026-05-26-cell-B-reviewed-write.md`, `2026-05-26-cell-C-full-write.md`.

The three existing run files in `workspace/mcp-testing/` correspond to cells A, B, and C without the cell letter in the name:
- `mcp-capability-test-run-2026-05-26.md` → cell A (baseline, write mode none)
- `mcp-capability-test-run-2026-05-26-review-write.md` → cell B
- `mcp-capability-test-run-2026-05-26-full-write.md` → cell C

---

## `Requires:` annotation scheme

Every scenario in `mcp-capability-test.md` should gain a `Requires:` line immediately after its ID heading (or as a column in table rows). Values are tier tags from the cells table above, or `(any)` for scenarios that always run.

| Scenario group | Requires |
|----------------|----------|
| S0.1–S0.3 | `(any)` — mandatory setup |
| S1.* | `read` — always-on, present in all cells |
| S2.* | `writeScoped` — always-on |
| S3.* | `writeReviewed` |
| S4.* | `writeVault` |
| S5.* | `manage` |
| S6.* | `navigate` |
| S7.* | `agent` — always-on |
| S8.0 | `extensions` |
| S8.1–S8.2 | `extensions +DataviewPlugin` |
| S8.3–S8.4 | `extensions +TasksPlugin` |
| S8.5 | `extensions +TemplaterPlugin` |
| S8.6–S8.7 | `extensions` (Canvas is native format; no third-party plugin needed) |
| S8.8 | `extensions +PeriodicNotesPlugin` |
| S9.* | `(any)` |
| S10.* | `(any)` |

The `+Plugin` qualifiers mean both the tier tag and the plugin must be present. They are discovered at runtime from S8.0's `plugin_extensions_list` output, not from the cell definition.

---

## "Instructions to Claude" update

Add a **Cell mode** step to the existing Instructions to Claude section, after the intro paragraph:

> **Cell mode**
>
> 1. Read the cell letter from the run file's header (e.g. "Cell B").
> 2. Look up the cell's active tag set in the Cells table above.
> 3. Before running each scenario, check its `Requires:` value. If any required tag is absent from the active set, mark the scenario `SKIPPED (cell)` without calling any tool, and continue to the next.
> 4. Smoke cells (D, E, F): only scenarios that become SKIPPED in this cell need to be visited — these confirm the tier gate is working. S0.1 and S9.5 always run.

---

## Files to change in the implementation PR

1. **`docs/qa-test-plan.md`**: Remove scenarios 3.1–3.5, 3.8–3.10, 3.14–3.15. Slim 3.6 to the UI assertion only. Retitle 3.7 and 3.19 with a "see capability test" note and remove their steps. Renumber the surviving scenarios 3.1–3.8.

2. **`docs/mcp-capability-test.md`**:
   - Add the Permission cells table and Cell mode instructions (as above).
   - Add `Requires:` annotations to every scenario group per the scheme above.
   - Update the run-file naming convention in the "Managing context" section.
   - Add a row for the concurrent-calls scenario (currently Stage 3 scenario 3.17) in S9 as S9.6, with `Requires: (any)`.

---

## Verification

Dry-run against `workspace/mcp-testing/mcp-capability-test-run-2026-05-26.md` (cell A, write mode none).

Cell A active tags: `read, writeScoped, agent, navigate, manage, extensions`.

Every scenario in that run that was marked PASS or FAIL must have a `Requires:` set fully satisfied by cell A's tags.

Spot checks:

- S1.1–S1.22 (`Requires: read`) — `read` is in cell A. All marked PASS. Consistent.
- S2.1–S2.11 (`Requires: writeScoped`) — `writeScoped` is in cell A. All marked PASS or EXPECTED-FAIL. Consistent.
- S3.* (`Requires: writeReviewed`) — `writeReviewed` absent from cell A. All marked SKIPPED. Consistent.
- S4.* (`Requires: writeVault`) — `writeVault` absent. All marked SKIPPED. Consistent.
- S5.1–S5.7 (`Requires: manage`) — `manage` is in cell A. All marked PASS. Consistent.
- S6.1–S6.2 (`Requires: navigate`) — `navigate` is in cell A. Both marked PASS/EXPECTED-FAIL. Consistent.
- S8.* (`Requires: extensions`) — `extensions` is in cell A. Scenarios ran; sub-scenarios for unavailable plugins marked SKIPPED. Consistent.
- S9.5 (`Requires: (any)`) — writeReviewed and writeVault absent from cell A; S9.5 used one of the disabled tiers to confirm the gate. Marked PASS. Consistent.

No PASS or FAIL scenario in the cell A run has a `Requires:` tag that is absent from cell A's active set. The annotation scheme is coherent with the existing run record.
