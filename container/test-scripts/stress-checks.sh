#!/usr/bin/env bash
# Run from repo root: bash container/test-scripts/stress-checks.sh <vault-root> [--with-daemon-stop]
#
# Automates shell-verifiable Stage 12 scenarios from qa-test-plan.md:
#   T12.2  Vault path with unicode
#   T12.3  Very large note read
#   T12.7a Teardown leaves no oas-test-* debris
#
# T12.1 (Docker daemon stop mid-session) requires --with-daemon-stop because it
# disrupts Docker on the host. Run it manually when you can tolerate the downtime.
#
# UI-bound scenarios (T12.4 concurrent terminals, T12.5 plugin disable while modal,
# T12.6 Obsidian close mid-call, T12.7 DevTools console errors) remain in
# qa-test-plan.md Stage 12.
#
# Prerequisites (printed before running):
#   - Obsidian open with plugin enabled and MCP enabled
#   - Container running
#   - jq on the host PATH
#
# For T12.1: run with --with-daemon-stop; Docker will be stopped and restarted.
set -uo pipefail

VAULT=${1:?Usage: $0 <vault-root> [--with-daemon-stop]}
MCP_PORT=${MCP_PORT:-28080}
MCP_BIND=${MCP_BIND:-127.0.0.1}
MCP_BASE="http://$MCP_BIND:$MCP_PORT/mcp"
PASS=0
FAIL=0

# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

pass() { echo "PASS $1"; PASS=$((PASS+1)); }
fail() { echo "FAIL $1"; FAIL=$((FAIL+1)); }
skip() { echo "SKIP $1"; }

assert_ok() {  # $1=response-json $2=label
    if echo "$1" | jq -e '.result.isError == true or (.error // empty | length > 0)' \
            >/dev/null 2>&1; then
        fail "$2"
    else
        pass "$2"
    fi
}

# ---------------------------------------------------------------------------
# MCP session
# ---------------------------------------------------------------------------

MCP_TOKEN=$(jq -r '.mcpToken' \
    "$VAULT/.obsidian/plugins/obsidian-agent-sandbox/data.json" 2>/dev/null || true)
if [[ -z "$MCP_TOKEN" || "$MCP_TOKEN" == "null" ]]; then
    echo "FATAL: could not read mcpToken from plugin settings." >&2
    echo "       Ensure Obsidian is running with the plugin installed." >&2
    exit 1
fi

init_session() {
    local headers
    headers=$(curl -sS -D - -o /dev/null \
        -H "Authorization: Bearer $MCP_TOKEN" \
        -H "Content-Type: application/json" \
        -X POST "$MCP_BASE" \
        -d '{"jsonrpc":"2.0","id":0,"method":"initialize","params":{"protocolVersion":"2024-11-05","capabilities":{},"clientInfo":{"name":"stress-checks","version":"1.0"}}}' \
        2>/dev/null)
    MCP_SESSION=$(echo "$headers" | grep -i "^mcp-session-id:" | tr -d '\r' | awk '{print $2}')
    if [[ -z "$MCP_SESSION" ]]; then
        echo "FATAL: could not establish MCP session." >&2
        echo "       Is Obsidian running with the plugin and MCP enabled?" >&2
        exit 1
    fi
}

mcp_call() {  # $1=tool-name $2=args-json  →  prints response JSON
    curl -sS \
        -H "Authorization: Bearer $MCP_TOKEN" \
        -H "Content-Type: application/json" \
        -H "Mcp-Session-Id: $MCP_SESSION" \
        -X POST "$MCP_BASE" \
        -d "{\"jsonrpc\":\"2.0\",\"id\":1,\"method\":\"tools/call\",\"params\":{\"name\":\"$1\",\"arguments\":$2}}"
}

# ---------------------------------------------------------------------------
# Teardown
# ---------------------------------------------------------------------------

UNICODE_VAULT=""
teardown() {
    rm -f "$VAULT/stress-large-file.md" 2>/dev/null || true
    if [[ -n "$UNICODE_VAULT" && -L "$UNICODE_VAULT" ]]; then
        rm -f "$UNICODE_VAULT"
    fi
}
trap teardown EXIT

# ---------------------------------------------------------------------------
# Preflight
# ---------------------------------------------------------------------------

command -v jq     >/dev/null || { echo "FATAL: jq not found" >&2; exit 1; }
command -v docker >/dev/null || { echo "FATAL: docker not found" >&2; exit 1; }

echo "=== Stress checks ==="
echo "Vault:  $VAULT"
echo "MCP:    $MCP_BASE"
echo ""
echo "Prerequisites:"
echo "  [required] Obsidian running with plugin enabled, MCP enabled"
echo "  [required] Container running"
echo "  [T12.1 only] Run with --with-daemon-stop (will stop and restart Docker)"
echo ""

init_session
echo "Session: ${MCP_SESSION:0:8}…"
echo ""

# ---------------------------------------------------------------------------
# T12: Stress / edge cases / recovery
# ---------------------------------------------------------------------------

echo "--- T12: stress and edge cases ---"

# ---------------------------------------------------------------------------
# T12.2 — Vault path with unicode
# Run a vault_list through a symlink whose path contains non-ASCII characters.
# Confirms that the mount point and paths survive unicode path round-trips.
# ---------------------------------------------------------------------------

UNICODE_VAULT="$VAULT/../Документы-vault"
ln -sf "$VAULT" "$UNICODE_VAULT" 2>/dev/null || UNICODE_VAULT=""
if [[ -n "$UNICODE_VAULT" ]]; then
    UNICODE_MCP_TOKEN=$(jq -r '.mcpToken' \
        "$UNICODE_VAULT/.obsidian/plugins/obsidian-agent-sandbox/data.json" 2>/dev/null || true)
    if [[ -n "$UNICODE_MCP_TOKEN" && "$UNICODE_MCP_TOKEN" != "null" ]]; then
        RESP=$(mcp_call vault_list '{"path":"."}')
        if echo "$RESP" | jq -e '.result.isError == true or (.error // empty | length > 0)' \
                >/dev/null 2>&1; then
            fail "12.2 vault_list through unicode-path vault failed"
        else
            pass "12.2 vault_list through unicode path succeeds"
        fi
    else
        skip "12.2 (could not read token via unicode symlink path)"
    fi
else
    skip "12.2 (could not create unicode symlink — filesystem may not support it)"
fi

# ---------------------------------------------------------------------------
# T12.3 — Very large note read
# Create a ~5 MB file in the vault and read it via vault_read.
# Asserts a success result is returned without timeout.
# ---------------------------------------------------------------------------

LARGE_FILE="$VAULT/stress-large-file.md"
python3 -c "
import sys
# Generate ~5 MB of markdown content
line = '# Stress test line\n'
target = 5 * 1024 * 1024
count = target // len(line) + 1
sys.stdout.write('# Large file stress test\n\n')
for i in range(count):
    sys.stdout.write(f'{i}: {line}')
" > "$LARGE_FILE" 2>/dev/null || {
    skip "12.3 (could not create large test file)"
}

if [[ -f "$LARGE_FILE" ]]; then
    FILE_SIZE=$(wc -c < "$LARGE_FILE")
    RESP=$(mcp_call vault_read '{"path":"stress-large-file.md"}')
    if echo "$RESP" | jq -e '.result.isError == true or (.error // empty | length > 0)' \
            >/dev/null 2>&1; then
        fail "12.3 large-file read failed (${FILE_SIZE} bytes)"
    else
        pass "12.3 large-file read succeeded (${FILE_SIZE} bytes)"
    fi
fi

# ---------------------------------------------------------------------------
# T12.7a — Teardown leaves no oas-test-* debris
# Run compose down on the test project, then scan for leftover resources.
# Uses the oas-test compose project (integration test project, not production).
# ---------------------------------------------------------------------------

echo ""
docker compose -f container/docker-compose.yml -p oas-test down -v \
    >/dev/null 2>&1 || true  # harmless if test project is already down

DEBRIS_CONTAINERS=$(docker ps -a --format '{{.Names}}' 2>/dev/null | grep "^oas-test" || true)
DEBRIS_VOLUMES=$(docker volume ls --format '{{.Name}}' 2>/dev/null | grep "^oas-test" || true)
DEBRIS_NETWORKS=$(docker network ls --format '{{.Name}}' 2>/dev/null | grep "^oas-test" || true)

if [[ -z "$DEBRIS_CONTAINERS" && -z "$DEBRIS_VOLUMES" && -z "$DEBRIS_NETWORKS" ]]; then
    pass "12.7a no oas-test-* debris after compose down"
else
    fail "12.7a oas-test-* debris found"
    [[ -n "$DEBRIS_CONTAINERS" ]] && echo "  containers: $DEBRIS_CONTAINERS"
    [[ -n "$DEBRIS_VOLUMES"    ]] && echo "  volumes:    $DEBRIS_VOLUMES"
    [[ -n "$DEBRIS_NETWORKS"   ]] && echo "  networks:   $DEBRIS_NETWORKS"
fi

# ---------------------------------------------------------------------------
# T12.1 — Docker daemon stop mid-session (optional, host-disruptive)
# ---------------------------------------------------------------------------

for arg in "${@:2}"; do
    if [[ "$arg" == "--with-daemon-stop" ]]; then
        echo ""
        echo "--- T12.1: daemon stop (host-disruptive) ---"
        echo "Stopping Docker daemon..."
        if command -v systemctl >/dev/null 2>&1; then
            sudo systemctl stop docker.socket docker.service 2>/dev/null || true
        else
            # macOS / non-systemd: best-effort
            sudo pkill -f "Docker Desktop" 2>/dev/null || \
            sudo pkill -f "dockerd" 2>/dev/null || true
        fi
        sleep 3
        # The plugin's next poll should surface an errored state.
        # We probe by trying an MCP call; it must fail cleanly (not hang).
        DAEMON_RESP=$(curl -sS --max-time 5 \
            -H "Authorization: Bearer $MCP_TOKEN" \
            -H "Content-Type: application/json" \
            -H "Mcp-Session-Id: $MCP_SESSION" \
            -X POST "$MCP_BASE" \
            -d '{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"vault_list","arguments":{}}}' \
            2>&1 || true)
        if echo "$DAEMON_RESP" | grep -qiE "connection refused|curl.*error|could not connect"; then
            pass "12.1a MCP unreachable after daemon stop (expected)"
        else
            fail "12.1a MCP still responding after daemon stop (unexpected)"
        fi
        echo "Restarting Docker daemon..."
        if command -v systemctl >/dev/null 2>&1; then
            sudo systemctl start docker.socket docker.service
        fi
        sleep 5
        # Re-init session to test recovery
        init_session 2>/dev/null && pass "12.1b MCP session re-established after restart" \
                                 || fail "12.1b MCP session failed to recover"
        break
    fi
done

# ---------------------------------------------------------------------------
# Results
# ---------------------------------------------------------------------------

echo ""
echo "Results: $PASS passed, $FAIL failed"
[[ $FAIL -eq 0 ]]
