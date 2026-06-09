#!/usr/bin/env bash
# Shared helpers for MCP test scripts (stress-checks.sh).
# Source this file after setting VAULT.  It sets MCP_PORT/BIND/BASE/PASS/FAIL,
# reads MCP_TOKEN, defines helpers, and runs preflight checks.

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

# assert that the JSON response is a successful tool result
assert_ok() {  # $1=response-json $2=label
    if echo "$1" | jq -e '.result.isError == true or (.error // empty | length > 0)' \
            >/dev/null 2>&1; then
        fail "$2"
    else
        pass "$2"
    fi
}

# ---------------------------------------------------------------------------
# Preflight
# ---------------------------------------------------------------------------

command -v jq     >/dev/null || { echo "FATAL: jq not found" >&2; exit 1; }
command -v docker >/dev/null || { echo "FATAL: docker not found" >&2; exit 1; }

# ---------------------------------------------------------------------------
# MCP token
# ---------------------------------------------------------------------------

MCP_TOKEN=$(jq -r '.mcpToken' \
    "$VAULT/.obsidian/plugins/obsidian-agent-sandbox/data.json" 2>/dev/null || true)
if [[ -z "$MCP_TOKEN" || "$MCP_TOKEN" == "null" ]]; then
    echo "FATAL: could not read mcpToken from plugin settings." >&2
    echo "       Ensure Obsidian is running with the plugin installed." >&2
    exit 1
fi

# ---------------------------------------------------------------------------
# MCP session helpers
# ---------------------------------------------------------------------------

init_session() {
    local headers
    headers=$(curl -sS -D - -o /dev/null \
        -H "Authorization: Bearer $MCP_TOKEN" \
        -H "Content-Type: application/json" \
        -X POST "$MCP_BASE" \
        -d "{\"jsonrpc\":\"2.0\",\"id\":0,\"method\":\"initialize\",\"params\":{\"protocolVersion\":\"2025-03-26\",\"capabilities\":{},\"clientInfo\":{\"name\":\"${0##*/}\",\"version\":\"1.0\"}}}" \
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
