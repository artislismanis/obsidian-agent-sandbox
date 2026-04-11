#!/bin/bash
# Environment verification + runtime contract for the Agent Sandbox container.
#
# This is BOTH a developer sanity check and the source of truth for what's
# available inside the container. Claude running inside the sandbox should
# run this to discover the environment rather than relying on a static
# manifest that could drift from reality.

set -u

echo "=== Agent Sandbox — Environment Verification ==="

echo ""
echo "── Tool versions ──────────────────────────────────"
echo "Node:    $(node --version 2>&1 || echo 'not found')"
echo "npm:     $(npm --version 2>&1 || echo 'not found')"
echo "git:     $(git --version 2>&1 || echo 'not found')"
echo "ttyd:    $(ttyd --version 2>&1 | head -1 || echo 'not found')"
echo "memory:  $(command -v mcp-server-memory >/dev/null && echo 'installed' || echo 'not found')"
echo "jq:      $(jq --version 2>&1 || echo 'not found')"
echo "Claude:  $(claude --version 2>&1 || echo 'not found')"
echo "gh:      $(gh --version 2>&1 | head -1 || echo 'not found')"
echo "delta:   $(delta --version 2>&1 | head -1 || echo 'not found')"
echo "fzf:     $(fzf --version 2>&1 | head -1 || echo 'not found')"
echo "rg:      $(rg --version 2>&1 | head -1 || echo 'not found')"
echo "fd:      $(fd --version 2>&1 || echo 'not found')"
echo "uv:      $(uv --version 2>&1 || echo 'not found')"
PY=$(uv python find 2>/dev/null) && echo "Python:  $($PY --version 2>&1)" || echo "Python:  not found"
echo "gosu:    $(command -v gosu >/dev/null && echo 'installed' || echo 'not found')"
echo "sudo:    $(command -v sudo >/dev/null && echo 'installed' || echo 'not found')"

echo ""
echo "── Mount points ───────────────────────────────────"
print_mount() {
  local path="$1"
  local label="$2"
  if [ -e "$path" ]; then
    # findmnt -> "ro,relatime,..." or "rw,..."; grab the first flag
    local opts
    opts=$(findmnt -n -o OPTIONS --target "$path" 2>/dev/null | awk -F, '{print $1}')
    local rw_state="${opts:-unknown}"
    printf "  %-48s %s\n" "$path" "[$rw_state] $label"
  else
    printf "  %-48s %s\n" "$path" "[MISSING] $label"
  fi
}
print_mount "/workspace"                                        "Claude workspace (host: workspace/)"
print_mount "/workspace/vault"                                  "Obsidian vault (read-only)"
print_mount "/workspace/vault/${PKM_WRITE_DIR:-agent-workspace}" "Vault writable subfolder"
print_mount "/home/claude/.claude"                              "Claude Code config (named volume)"
print_mount "/home/claude/.shell-history"                       "Shell history (named volume)"

echo ""
echo "── Environment variables ──────────────────────────"
for var in PKM_VAULT_PATH PKM_WRITE_DIR MEMORY_FILE_PATH MEMORY_FILE_NAME \
           TTYD_PORT TTYD_BIND ALLOWED_PRIVATE_HOSTS \
           CONTAINER_MEMORY CONTAINER_CPUS; do
  printf "  %-24s = %s\n" "$var" "${!var:-<unset>}"
done

echo ""
echo "── Privileges ─────────────────────────────────────"
echo "  running as:   $(id -un) (uid $(id -u))"
if sudo -n -l /usr/bin/apt-get >/dev/null 2>&1; then
  echo "  sudo apt-get: allowed WITHOUT password (NOPASSWD)"
elif sudo -l 2>/dev/null | grep -qE 'apt-get|apt[[:space:]]'; then
  echo "  sudo apt-get: allowed WITH password (human-gated, see README)"
else
  echo "  sudo apt-get: not allowed"
fi

echo ""
echo "── Node globals ───────────────────────────────────"
npm list -g --depth=0 2>/dev/null | tail -n +2 | sed 's/^/  /' || echo "  (npm not available)"

echo ""
echo "── Runtime checks ─────────────────────────────────"
if [ -d "/workspace/vault" ] && [ "$(ls -A /workspace/vault 2>/dev/null)" ]; then
  VAULT_ITEMS=$(ls -1 /workspace/vault | wc -l)
  echo "  Vault: mounted at /workspace/vault (${VAULT_ITEMS} items)"
else
  echo "  WARNING: No vault content at /workspace/vault"
  echo "    Set PKM_VAULT_PATH in container/.env and restart the container"
fi

if curl -sf http://localhost:7681/ > /dev/null 2>&1; then
  echo "  ttyd:  listening on port ${TTYD_PORT:-7681}"
else
  echo "  ttyd:  not yet listening (normal during build or exec)"
fi

echo ""
echo "To enable network sandboxing: sudo /usr/local/bin/init-firewall.sh"
echo "=== Done ==="
