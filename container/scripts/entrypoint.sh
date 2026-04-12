#!/bin/bash
set -euo pipefail

# Entrypoint runs as root so we can (optionally) update the claude user's
# password for interactive sudo, then drop to the claude user for ttyd.
#
# SUDO_PASSWORD is a human-intent gate for narrow sudo (apt-get only).
# If unset or empty, the claude user password stays unset and `sudo`
# fails at the password prompt — i.e. sudo is effectively disabled.
# See container/.env.example and README.md "Development" section.

if [[ -n "${SUDO_PASSWORD:-}" ]]; then
    echo "claude:${SUDO_PASSWORD}" | chpasswd
fi

# Unset before dropping privileges so SUDO_PASSWORD does not leak into
# the child shell's environment (would otherwise be visible via `env`).
unset SUDO_PASSWORD

# Fix directory ownership if it doesn't match claude's current uid.
# Named volumes persist across rebuilds and bind-mount targets may be
# created as root:root — check-then-chown is idempotent and skips if
# already correct, so per-start cost is essentially zero.
claude_uid=$(id -u claude)
claude_gid=$(id -g claude)

ensure_ownership() {
    local dir="$1"
    if [[ -d "$dir" ]]; then
        local current_uid
        current_uid=$(stat -c '%u' "$dir" 2>/dev/null || echo "")
        if [[ -n "$current_uid" && "$current_uid" != "$claude_uid" ]]; then
            echo "entrypoint: chowning $dir (was uid $current_uid, claude is $claude_uid)"
            chown -R "${claude_uid}:${claude_gid}" "$dir"
        fi
    fi
}

# Named volumes
ensure_ownership /home/claude/.claude
ensure_ownership /home/claude/.shell-history
# Vault RW overlays
ensure_ownership "/workspace/vault/${PKM_WRITE_DIR:-agent-workspace}"
ensure_ownership /workspace/vault/.oas

# Ensure memory file exists (MCP memory server expects it).
memory_file="/workspace/vault/.oas/${MEMORY_FILE_NAME:-memory.json}"
if [[ ! -f "$memory_file" ]]; then
    install -o "${claude_uid}" -g "${claude_gid}" -m 644 /dev/null "$memory_file"
fi

# Drop to the claude user and run ttyd. TTYD_PORT falls through from
# docker-compose.yml (defaults to 7681).
exec gosu claude ttyd -W -p "${TTYD_PORT:-7681}" /usr/local/bin/session.sh
