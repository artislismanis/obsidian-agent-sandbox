# Security test automation — Stage 7 + Stage 8

**Status:** proposed
**Affects:** `docs/qa-test-plan.md`, `docs/mcp-capability-test.md`, `docs/testing.md`, `docs/how-to/release.md`
**New files:** `container/test-scripts/security-checks.sh`

---

## Problem

Stage 7 (symlink/path-traversal) and most of Stage 8 (firewall) of `qa-test-plan.md` are deterministic shell probes — their pass/fail criteria are fixed and need no human judgment. Running them manually on every release is tedious and error-prone. Three categories exist within these stages, and each calls for a different tool:

1. **CLI-only checks** — curl egress probes, `init-firewall.sh --list-sources` output, shell-level file assertions. No LLM or human required.
2. **MCP boundary check via real LLM client** — a single probe that verifies the symlink-denial error surfaces cleanly *as seen by an MCP client*, not just at the HTTP level. One scenario, added to the existing `mcp-capability-test.md` run.
3. **UI rendering** — status-bar icon transitions and settings-pane Refresh button. No code can substitute for human eyes; these stay in `qa-test-plan.md`.

The goal is to assign each scenario to the right tool, retire the duplicated manual steps, and update all cross-references so the documentation stays consistent.

---

## Three-bucket allocation

| Old ID | Topic | Bucket | New home |
|--------|-------|--------|----------|
| 7.1 | Read of escaping symlink denied | Shell script | `security-checks.sh` |
| 7.2 | Create into symlinked directory denied | Shell script | `security-checks.sh` |
| 7.3 | Nested symlinks resolve fully | Shell script | `security-checks.sh` |
| 7.4 | Safe symlink inside agent-workspace allowed | Shell script | `security-checks.sh` |
| (new) | Symlink denial as seen by LLM MCP client | LLM-driven | `mcp-capability-test.md` S9.7 |
| 8.1 | Firewall on/off icon transitions | **Human** | stays in Stage 8 |
| 8.2 | Plugin-setting domain reaches host | Shell script | `security-checks.sh` |
| 8.3 | extras file reachable + not vault-readable | Shell script | `security-checks.sh` |
| 8.4 | `--list-sources` tagging | Shell script | `security-checks.sh` |
| 8.5 | Effective allowlist refresh button (UI) | **Human** | stays in Stage 8 |
| 8.6 | Firewall off restores egress | Shell script | `security-checks.sh` (with `--firewall-off` flag) |

---

## New file: `container/test-scripts/security-checks.sh`

A host-runnable bash script. Requires: container running with plugin enabled and MCP enabled; firewall enabled and configured per the prerequisites printed by the script; `jq` on the host.

**Why `container/test-scripts/` and not `workspace/`?**
The script must run from the host because (a) symlink fixtures at vault root require host write access — the vault is mounted read-only inside the container (`docker-compose.yml` line 94) — and (b) `docker compose exec` is a host command. Container-side scripts go in `workspace/scripts/`; host-side test tooling goes alongside other infra scripts in `container/`.

**Token retrieval.** The plugin persists settings at `<vault>/.obsidian/plugins/obsidian-agent-sandbox/data.json`. The MCP bearer token is stored under the key `mcpToken`. The script reads it with:

```bash
MCP_TOKEN=$(jq -r '.mcpToken' "$VAULT/.obsidian/plugins/obsidian-agent-sandbox/data.json")
```

**MCP boundary probes.** The plugin's MCP server listens at `http://<mcpBindAddress>:<mcpPort>/mcp` (see `plugin/src/mcp-server.ts`). The script issues JSON-RPC 2.0 POST requests with `Authorization: Bearer $MCP_TOKEN` and `Content-Type: application/json`. For each probe it asserts whether the response contains `"isError":true` (or equivalent) or a success payload.

**Sketch of the script's structure** (to be refined in the implementation PR):

```bash
#!/usr/bin/env bash
# Run from repo root: bash container/test-scripts/security-checks.sh <vault-root> [--firewall-off]
set -uo pipefail
PASS=0; FAIL=0

VAULT=${1:?Usage: $0 <vault-root> [--firewall-off]}
MCP_PORT=${MCP_PORT:-28080}
MCP_BIND=${MCP_BIND:-127.0.0.1}
MCP_BASE="http://$MCP_BIND:$MCP_PORT/mcp"
MCP_TOKEN=$(jq -r '.mcpToken' "$VAULT/.obsidian/plugins/obsidian-agent-sandbox/data.json")

mcp_call() {   # $1=tool-name $2=args-json
  curl -sS -H "Authorization: Bearer $MCP_TOKEN" \
       -H "Content-Type: application/json" \
       -X POST "$MCP_BASE" \
       -d "{\"jsonrpc\":\"2.0\",\"id\":1,\"method\":\"tools/call\",\"params\":{\"name\":\"$1\",\"arguments\":$2}}"
}
assert_error() { echo "$1" | grep -q '"isError":true' && { echo "PASS $2"; ((PASS++)); } \
                                                      || { echo "FAIL $2"; ((FAIL++)); }; }
assert_ok()    { echo "$1" | grep -qv '"isError":true' && { echo "PASS $2"; ((PASS++)); } \
                                                       || { echo "FAIL $2"; ((FAIL++)); }; }

# --- Host-side symlink setup (vault root is writable from host, read-only in container)
cd "$VAULT"
ln -sf /etc/hosts evil.md
ln -sf /tmp escape
mkdir -p innocent && ln -sf /tmp innocent/inner
# 7.4: symlink inside agent-workspace pointing back into vault/notes (safe link)
[[ -d notes ]] && ln -sf "$(pwd)/notes" agent-workspace/safe-link || echo "SKIP 7.4 (no 'notes' folder)"

# --- T7: MCP path-traversal boundary
assert_error "$(mcp_call vault_read      '{"path":"evil.md"}')"        "7.1 escaping symlink read denied"
assert_error "$(mcp_call vault_create    '{"path":"escape/note.md","content":"hi"}')" \
                                                                        "7.2 create into symlinked dir denied"
assert_error "$(mcp_call vault_read      '{"path":"innocent/inner/x.md"}')" \
                                                                        "7.3 nested symlink denied"
[[ -L agent-workspace/safe-link ]] && \
  assert_ok "$(mcp_call vault_list '{"path":"agent-workspace/safe-link"}')" \
                                                                        "7.4 safe symlink allowed"

# --- T8.2/8.3a: egress (firewall must be ON for these)
docker compose -f container/docker-compose.yml exec -T sandbox \
  curl -fsI -m 8 https://example.com >/dev/null 2>&1 \
  && { echo "PASS 8.2a example.com reachable"; ((PASS++)); } \
  || { echo "FAIL 8.2a example.com blocked";   ((FAIL++)); }

docker compose -f container/docker-compose.yml exec -T sandbox \
  curl -fsI -m 8 https://example.org >/dev/null 2>&1 \
  && { echo "FAIL 8.2b example.org should be blocked"; ((FAIL++)); } \
  || { echo "PASS 8.2b example.org blocked";           ((PASS++)); }

docker compose -f container/docker-compose.yml exec -T sandbox \
  curl -fsI -m 8 https://internal.corp.example >/dev/null 2>&1 \
  && { echo "PASS 8.3a extras-file domain reachable"; ((PASS++)); } \
  || { echo "FAIL 8.3a extras-file domain blocked";   ((FAIL++)); }

# --- T8.3b: firewall-extras.txt not readable via MCP
assert_error "$(mcp_call vault_read '{"path":"/etc/oas/firewall-extras.txt"}')" \
                                                                        "8.3b host path not vault-readable"

# --- T8.4: --list-sources tagging
SOURCES=$(docker compose -f container/docker-compose.yml exec -T sandbox \
  /usr/local/bin/init-firewall.sh --list-sources 2>&1)
echo "$SOURCES" | grep -q '\[baseline\]' && echo "$SOURCES" | grep -q '\[plugin\]' && \
  echo "$SOURCES" | grep -q '\[file\]' \
  && { echo "PASS 8.4 all three source tags present"; ((PASS++)); } \
  || { echo "FAIL 8.4 missing source tag(s)";         ((FAIL++)); }

# --- T8.6: firewall off restores egress (only with --firewall-off flag)
if [[ "${2:-}" == "--firewall-off" ]]; then
  docker compose -f container/docker-compose.yml exec -T sandbox \
    curl -fsI -m 8 https://example.org >/dev/null 2>&1 \
    && { echo "PASS 8.6 egress restored when firewall off"; ((PASS++)); } \
    || { echo "FAIL 8.6 egress still blocked";              ((FAIL++)); }
fi

# --- Teardown
cd "$VAULT"
rm -f evil.md escape innocent/inner; rmdir innocent 2>/dev/null || true
rm -f agent-workspace/safe-link

echo ""
echo "Results: $PASS passed, $FAIL failed"
[[ $FAIL -eq 0 ]]
```

The implementation PR should confirm the exact JSON-RPC envelope shape from `plugin/src/mcp-server.ts` and the exact `docker compose` project flags (the live stack uses compose project `oas`; pass `-p oas` or set `COMPOSE_PROJECT_NAME=oas` if running outside `container/`).

**Prerequisites the script prints before running:**
- Container running with plugin enabled, MCP enabled.
- Firewall enabled with `example.com` in plugin's "Additional firewall domains" setting.
- `internal.corp.example` present in `container/firewall-extras.txt` and container restarted.
- `jq` on the host.

For T8.6 specifically: toggle firewall off via **Sandbox: Toggle Firewall** in the Obsidian command palette, then re-run with `--firewall-off`. The firewall toggle itself stays in Stage 8 of `qa-test-plan.md` as a human UI step.

---

## `mcp-capability-test.md` addition: S9.7

One new scenario after S9.6, in the existing `S9 — Cross-cutting / failure modes` section:

```markdown
### S9.7 Path-traversal probe

`Requires: (any)`

Prerequisite: `<vault-root>/evil.md` → `/etc/hosts` symlink must exist (created by `container/test-scripts/security-checks.sh` setup phase, or manually with `ln -sf /etc/hosts <vault>/evil.md` from the host).

Call `vault_read { path: "evil.md" }`. Capture the verbatim error. Confirm `/etc/hosts` contents (first line begins `#`) are NOT in the response.
```

This single row is the only LLM-client-side coverage needed: it proves the error surfaces cleanly to a real MCP client rather than silently succeeding or returning raw host-file data. The shell script (`security-checks.sh`) provides broader boundary coverage; this row closes the "as seen by Claude" gap.

---

## `docs/qa-test-plan.md` changes

### Stage 7

Replace the entire Stage 7 body with a pointer stub:

> Stage 7 symlink/path-traversal boundary checks are automated in `container/test-scripts/security-checks.sh` (see setup and usage instructions in that file). For the LLM-client-side view of a symlink denial, see `mcp-capability-test.md` S9.7. UI-observable aspects (none currently exist in Stage 7) would live here.

The stage heading and setup-carried-forward line remain so the stage numbering is unchanged. No scenarios listed.

### Stage 8

Slim to two UI-bound scenarios (renumbered 8.1, 8.2) and add an intro paragraph:

> Automated firewall checks (egress allow/block, list-sources tagging, MCP path isolation) run via `container/test-scripts/security-checks.sh`. The two scenarios below require Obsidian to be running because they verify visual feedback in the plugin UI.

Remaining scenarios:
- **8.1** (was 8.1): Firewall on/off toggle live — status-bar icon transition. P1.
- **8.2** (was 8.5): Effective allowlist refresh button. P2.

---

## Cross-document alignment

These three files reference the test plans and must be updated in the same PR:

### `docs/testing.md`

Add a fourth automated tier in the existing numbered layers section, before the "Manual test scenarios" heading:

> **Security smoke** (`container/test-scripts/security-checks.sh`): host-runnable bash. Covers MCP path-traversal boundary enforcement (symlink probes via HTTP POST to the MCP server) and firewall egress verification (curl probes from inside the container). Requires a live container with firewall enabled and a test vault configured with the domain entries documented in the script's prerequisites. Complements but does not replace the `mcp-capability-test.md` cell-A sweep.
>
> ```bash
> bash container/test-scripts/security-checks.sh /path/to/test-vault
> # Firewall-off probe (toggle firewall off in Obsidian first):
> bash container/test-scripts/security-checks.sh /path/to/test-vault --firewall-off
> ```

Also update the "Manual test scenarios" paragraph to note that Stage 7 is now fully automated and Stage 8 is reduced to two UI scenarios.

### `docs/how-to/release.md`

In section **1. Pre-flight**, add after the existing `npm run test:e2e:headless` line:

```bash
# Security boundary smoke (needs live container + test vault):
bash container/test-scripts/security-checks.sh /path/to/test-vault
```

With a note that this is required before shipping, corresponding to P0 scenarios 8.2/8.3 that previously lived in Stage 8 of `qa-test-plan.md`.

---

## Verification

1. Run `bash container/test-scripts/security-checks.sh <test-vault>` — all probes report PASS.
2. Run with `--firewall-off` after toggling firewall off in the plugin — T8.6 reports PASS.
3. Run `mcp-capability-test.md` cell A sweep — S9.7 produces `File not found` (or equivalent isError) and no `/etc/hosts` content appears.
4. `grep -rn "Stage 7\|7\.1\|7\.2\|7\.3\|7\.4" docs/qa-test-plan.md` — no step-by-step remnants.
5. Doc-link consistency: `grep -rn "qa-test-plan\|mcp-capability-test\|security-checks" docs/ README.md CLAUDE.md` — every hit is live and current.
6. `docs/testing.md` lists four automated tiers; manual section notes Stage 7 automated and Stage 8 reduced.
7. `docs/how-to/release.md` pre-flight list includes the security-checks step.

---

## Follow-up issues (to be filed when this PR opens)

Two items are explicitly out of scope for this PR and should be tracked as GitHub issues so they aren't forgotten:

**Issue: Stage 12 stress/recovery sweep automation**
Stage 12 contains several pure-shell-automatable scenarios (12.1 Docker daemon stop, 12.2 unicode vault path, 12.3 large-file read, 12.7a teardown debris check) alongside UI-bound ones. The pattern is identical to this PR: write a `container/test-scripts/stress-checks.sh`, slim the human-checklist to UI-only, update `docs/testing.md`. See plan file for detailed categorization.

**Issue: Stage 9 (plugin API integrations) restructure against `mcp-capability-test.md` S8**
Stage 9 was written before `mcp-capability-test.md` existed. Nearly all of its 8 scenarios (9.1 Dataview DQL, 9.4 Templater, 9.5 Periodic Notes, 9.6 Canvas, 9.7 extensions list, 9.8 malformed args) are already covered by S8 of the capability test. The refactor mirrors Stage 3's treatment in PR #118: remove duplicates, keep 9.3 (recurring-task semantics — genuinely unique), replace Stage 9 with a pointer paragraph. Should be the immediate follow-on PR after this one merges.
