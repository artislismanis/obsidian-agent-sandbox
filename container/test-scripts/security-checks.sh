#!/usr/bin/env bash
# Run from repo root: bash container/test-scripts/security-checks.sh <vault-root> [--firewall-off]
#
# Automates Stage 7 (symlink/path-traversal), most of Stage 8 (firewall), and Stage 9
# tool-bug regression probes from qa-test-plan.md.
# UI-bound scenarios (firewall toggle icon, allowlist refresh button) remain in qa-test-plan.md.
#
# Implementation notes (verified from plugin source):
#   - mcpToken:       top-level key in .obsidian/plugins/obsidian-agent-sandbox/data.json
#   - mcpBindAddress: default "127.0.0.1"  (plugin/src/settings.ts)
#   - mcpPort:        default 28080         (plugin/src/settings.ts)
#   - Tool errors:    result.isError == true (plugin/src/mcp-server.ts)
#   - Protocol errors: top-level .error object (standard JSON-RPC)
#   - Session protocol: POST initialize → capture Mcp-Session-Id header → reuse per MCP spec
#   - Compose project: "oas" (CLAUDE.md naming convention)
#
# Prerequisites (printed before running):
#   - Obsidian open with plugin enabled and MCP enabled
#   - Firewall enabled; "example.com" in plugin's Additional firewall domains
#   - "internal.corp.example" in container/firewall-extras.txt; container restarted
#   - jq on the host PATH
#
# For T8.6: toggle firewall off in Obsidian, then re-run with --firewall-off.
set -uo pipefail

VAULT=${1:?Usage: $0 <vault-root> [--firewall-off]}
# shellcheck source=mcp-common.sh
source "$(dirname "$0")/mcp-common.sh"

# ---------------------------------------------------------------------------
# Script-specific helpers
# ---------------------------------------------------------------------------

# assert that the JSON response represents an MCP tool error or JSON-RPC error
assert_error() {  # $1=response-json $2=label
    if echo "$1" | jq -e '.result.isError == true or (.error // empty | length > 0)' \
            >/dev/null 2>&1; then
        pass "$2"
    else
        fail "$2"
    fi
}

# assert that a marker string does NOT appear in the response (host-content leak check)
assert_no_content() {  # $1=response-json $2=label $3=forbidden-marker
    if echo "$1" | grep -qF "$3"; then
        fail "$2 (host content leaked: '$3')"
    else
        pass "$2"
    fi
}

# ---------------------------------------------------------------------------
# Teardown (runs on EXIT so fixtures are removed even if a probe fails)
# ---------------------------------------------------------------------------

teardown() {
    pushd "$VAULT" >/dev/null
    rm -f evil.md escape
    rm -f innocent/inner
    rmdir innocent 2>/dev/null || true
    rm -f agent-workspace/safe-link
    rm -f agent-workspace/regression.canvas
    popd >/dev/null
}
trap teardown EXIT

echo "=== Security checks ==="
echo "Vault:  $VAULT"
echo "MCP:    $MCP_BASE"
echo ""
echo "Prerequisites:"
echo "  [required] Obsidian running with plugin enabled, MCP enabled"
echo "  [required] Firewall enabled; 'example.com' in Additional firewall domains"
echo "  [required] 'internal.corp.example' in container/firewall-extras.txt (container restarted)"
echo "  [T8.6 only] Firewall toggled off in Obsidian before running with --firewall-off"
echo ""

init_session
echo "Session: ${MCP_SESSION:0:8}…"
echo ""

# ---------------------------------------------------------------------------
# Symlink fixture setup
# ---------------------------------------------------------------------------

pushd "$VAULT" >/dev/null
ln -sf /etc/hosts evil.md
ln -sf /tmp escape
mkdir -p innocent && ln -sf /tmp innocent/inner
if [[ -d notes ]]; then
    ln -sf "$(pwd)/notes" agent-workspace/safe-link
else
    SKIP_74=1
fi
# Regression fixture: minimal canvas file for T9.4/T9.5
mkdir -p agent-workspace
printf '{"nodes":[],"edges":[]}\n' > agent-workspace/regression.canvas
popd >/dev/null

# ---------------------------------------------------------------------------
# T7: MCP path-traversal boundary
# ---------------------------------------------------------------------------

echo "--- T7: path-traversal ---"

RESP=$(mcp_call vault_read '{"path":"evil.md"}')
assert_error "$RESP" "7.1 escaping symlink read denied"
assert_no_content "$RESP" "7.1 /etc/hosts content not leaked" "127.0.0.1"

RESP=$(mcp_call vault_create '{"path":"escape/note.md","content":"hi"}')
assert_error "$RESP" "7.2 create into symlinked dir denied"

RESP=$(mcp_call vault_read '{"path":"innocent/inner/x.md"}')
assert_error "$RESP" "7.3 nested symlink denied"

if [[ "${SKIP_74:-0}" == "1" ]]; then
    skip "7.4 (no 'notes' folder in vault)"
else
    RESP=$(mcp_call vault_list '{"path":"agent-workspace/safe-link"}')
    assert_ok "$RESP" "7.4 safe symlink inside vault allowed"
fi

# ---------------------------------------------------------------------------
# T8: Firewall
# ---------------------------------------------------------------------------

echo ""
echo "--- T8: firewall ---"

docker compose -f container/docker-compose.yml -p oas exec -T sandbox \
    curl -fsI -m 8 https://example.com >/dev/null 2>&1 \
    && pass "8.2a example.com reachable" \
    || fail "8.2a example.com blocked"

docker compose -f container/docker-compose.yml -p oas exec -T sandbox \
    curl -fsI -m 8 https://example.org >/dev/null 2>&1 \
    && fail "8.2b example.org should be blocked" \
    || pass "8.2b example.org blocked"

docker compose -f container/docker-compose.yml -p oas exec -T sandbox \
    curl -fsI -m 8 https://internal.corp.example >/dev/null 2>&1 \
    && pass "8.3a extras-file domain reachable" \
    || fail "8.3a extras-file domain blocked"

# vault_read only accepts vault-relative paths; an absolute /etc/oas/... path is
# rejected as outside-vault before any symlink check fires. Either error confirms
# the file is inaccessible via MCP; assert_no_content double-checks no leak.
RESP=$(mcp_call vault_read '{"path":"/etc/oas/firewall-extras.txt"}')
assert_error "$RESP" "8.3b host path not vault-readable"
assert_no_content "$RESP" "8.3b no extras-file content leaked" "internal.corp.example"

SOURCES=$(docker compose -f container/docker-compose.yml -p oas exec -T sandbox \
    /usr/local/bin/init-firewall.sh --list-sources 2>&1)
if echo "$SOURCES" | grep -q '\[baseline\]' && \
   echo "$SOURCES" | grep -q '\[plugin\]'   && \
   echo "$SOURCES" | grep -q '\[file\]'; then
    pass "8.4 all three source tags present"
else
    fail "8.4 missing source tag(s)"
fi

for arg in "${@:2}"; do
    if [[ "$arg" == "--firewall-off" ]]; then
        docker compose -f container/docker-compose.yml -p oas exec -T sandbox \
            curl -fsI -m 8 https://example.org >/dev/null 2>&1 \
            && pass "8.6 egress restored when firewall off" \
            || fail "8.6 egress still blocked"
        break
    fi
done

# ---------------------------------------------------------------------------
# T9: Tool-bug regression probes (P1/P2 fixes from capability-test triage)
# ---------------------------------------------------------------------------

echo ""
echo "--- T9: tool-bug regressions ---"

# 9.1a: String "false" must coerce to boolean false (not be rejected by Zod)
RESP=$(mcp_call vault_search '{"query":"__t9probe__","caseSensitive":"false"}')
assert_ok "$RESP" "9.1a caseSensitive=\"false\" coerces to bool"

# 9.1b: String "true" must coerce to boolean true
RESP=$(mcp_call vault_search '{"query":"__t9probe__","caseSensitive":"true"}')
assert_ok "$RESP" "9.1b caseSensitive=\"true\" coerces to bool"

# 9.2: String numeric must coerce to number
RESP=$(mcp_call vault_search '{"query":"__t9probe__","limit":"3"}')
assert_ok "$RESP" "9.2 limit=\"3\" coerces to number"

# 9.3: vault_periodic_note with no args must default periodicity to "daily"
# Gate: probe for PeriodicNotesPlugin availability first; SKIP if absent.
PROBE=$(mcp_call vault_periodic_note '{}')
if echo "$PROBE" | jq -e '.result.isError == true' >/dev/null 2>&1; then
    ERR_MSG=$(echo "$PROBE" | jq -r '.result.content[0].text // ""')
    if echo "$ERR_MSG" | grep -qi "plugin not available\|not installed\|not enabled"; then
        skip "9.3 (Periodic Notes plugin not available)"
    else
        fail "9.3 vault_periodic_note {} failed unexpectedly"
    fi
else
    pass "9.3 vault_periodic_note {} defaults to daily (no periodicity required)"
fi

# 9.4: vault_canvas_modify with plain-object changes must be rejected
RESP=$(mcp_call vault_canvas_modify \
    '{"path":"agent-workspace/regression.canvas","changes":{"ops":[]}}')
assert_error "$RESP" "9.4 canvas changes as plain object rejected"

# 9.5: vault_canvas_modify with JSON-string changes must succeed
RESP=$(mcp_call vault_canvas_modify \
    '{"path":"agent-workspace/regression.canvas","changes":"{\"ops\":[]}"}')
assert_ok "$RESP" "9.5 canvas changes as JSON string accepted"

# ---------------------------------------------------------------------------
# Results
# ---------------------------------------------------------------------------

echo ""
echo "Results: $PASS passed, $FAIL failed"
[[ $FAIL -eq 0 ]]
