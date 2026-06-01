#!/usr/bin/env bash
#
# Report the agent's activity state to the Obsidian plugin via its MCP
# endpoint. Called from Claude Code hooks in this workspace's
# .claude/settings.json. Silent failures by design: a missing token or
# offline MCP server must never block Claude Code.
#
# Usage: notify-status.sh <status> [detail]
#   status: idle | working | awaiting_input
#   detail: optional short context string
#
# Requires OAS_MCP_TOKEN and OAS_MCP_PORT in the container env (set by
# the plugin at docker compose up). Session name is picked up from tmux
# when available.
#
# Wired hooks:
#   UserPromptSubmit      → working        (prompt received, starting turn)
#   Stop                  → idle           (turn complete)
#   PreToolUse[AskUserQuestion] → awaiting_input  (blocking on human answer)
#   Notification          → awaiting_input (system notification to user)
#
# Implementation note: pipes JSON-RPC through the stdio→HTTP proxy at
# .claude/scripts/obsidian-mcp-proxy.js, which performs the MCP
# `initialize` handshake, manages the session id, and forwards tool calls.
# Talking directly to the HTTP endpoint skips the MCP handshake and the SDK
# rejects the request, so tool calls go through the proxy instead.

# `set -u` only. `set -e` aborts on jq/tmux/node errors before `|| true`,
# defeating the silent-failure contract.
set -u

status="${1:-idle}"
detail="${2:-}"

case "$status" in
  idle|working|awaiting_input) ;;
  *)
    echo "notify-status: invalid status '$status' (want idle|working|awaiting_input)" >&2
    exit 0
    ;;
esac

token="${OAS_MCP_TOKEN:-}"
if [ -z "$token" ]; then
  # No token means MCP is disabled or not initialized. Exit silently.
  exit 0
fi

# Resolve the routing identity in precedence order:
#
# 1. tmux #S: when $TMUX is set the hook is running inside a named tmux
#    session. The plugin injected `session <name>` to create/attach that
#    session, so #S equals the tab's persisted sessionName. Named sessions are
#    intentionally shared: multiple tabs attached to the same session should
#    all light up together, so #S-first preserves that behaviour. Without the
#    $TMUX guard, tmux display-message can return the most-recently-active
#    session from another tab's tmux server and misroute the prefix.
#
# 2. OAS_TAB_ID: for unnamed ("Sandbox Terminal") tabs the plugin injects
#    `export OAS_TAB_ID='oas-tab-<N>'` into the shell on initial attach. This
#    key is used only when the tab is NOT inside tmux, routing the update
#    exclusively to this tab rather than the shared DEFAULT_SESSION_KEY bucket.
#    Not read inside tmux: the tmux server seeds its global env from whichever
#    tab first ran `session <name>`, so OAS_TAB_ID would be stale for all
#    subsequent sessions; #S-first sidesteps that env propagation issue.
#
# 3. Omit: if neither is available, the plugin falls back to DEFAULT_SESSION_KEY
#    and all unnamed tabs light up (pre-per-tab-routing behaviour).
session=""
if [ -n "${TMUX:-}" ]; then
  session="$(tmux display-message -p '#S' 2>/dev/null || true)"
elif [ -n "${OAS_TAB_ID:-}" ]; then
  session="${OAS_TAB_ID}"
fi

# jq is installed in the sandbox image (container/Dockerfile); this hook
# only ever runs in-container, so we can rely on it.
init_msg='{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-03-26","capabilities":{},"clientInfo":{"name":"notify-status","version":"1.0"}}}'
init_notif='{"jsonrpc":"2.0","method":"notifications/initialized"}'
if ! call_msg=$(jq -cn --arg s "$status" --arg n "$session" --arg d "$detail" '
  {
    jsonrpc: "2.0",
    id: 2,
    method: "tools/call",
    params: {
      name: "agent_status_set",
      arguments: ({ status: $s }
        + (if $n == "" then {} else { sessionName: $n } end)
        + (if $d == "" then {} else { detail: $d } end))
    }
  }'); then
  # On jq failure, $call_msg is empty and the proxy receives a blank line,
  # reporting success without calling the tool. Bail loudly so monitoring
  # catches it.
  echo "notify-status: jq failed to build call_msg" >&2
  exit 0
fi
if [ -z "$call_msg" ]; then
  echo "notify-status: empty call_msg from jq" >&2
  exit 0
fi

proxy="$(dirname "$0")/../scripts/obsidian-mcp-proxy.js"
if [ ! -f "$proxy" ]; then
  exit 0
fi

# Feed initialize, initialized notification, and tools/call through the
# proxy. jq -c above produces compact single-line JSON: without it,
# readline in the proxy splits pretty-printed output on newlines and each
# partial line fails JSON.parse, silently dropping the call. Total budget ~3s.
{
  printf '%s\n' "$init_msg"
  printf '%s\n' "$init_notif"
  printf '%s\n' "$call_msg"
} | timeout 3 node "$proxy" >/dev/null 2>&1 || true
