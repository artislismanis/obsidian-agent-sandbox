#!/bin/bash
set -euo pipefail

# Entrypoint runs as root so we can (optionally) update the claude user's
# password for interactive sudo, then drop to the claude user for ttyd.
#
# OAS_SUDO_PASSWORD is a human-intent gate for narrow sudo (apt-get only).
# If unset or empty, the claude user password stays unset and `sudo`
# fails at the password prompt, i.e. sudo is effectively disabled.
# See container/.env.example and README.md "Development" section.

if [[ -n "${OAS_SUDO_PASSWORD:-}" ]]; then
    echo "claude:${OAS_SUDO_PASSWORD}" | chpasswd
fi

# Unset before dropping privileges so OAS_SUDO_PASSWORD does not leak into
# the child shell's environment (would otherwise be visible via `env`).
unset OAS_SUDO_PASSWORD

# /etc/oas/ holds ro-mounted config files (firewall allowlists). Ensure the
# directory is traversable so non-root users can read files inside it.
chmod 755 /etc/oas 2>/dev/null || true

# On WSL2 (Rancher Desktop, Docker Desktop WSL2 backend, raw Docker Engine in
# WSL2), host.docker.internal is set to the Docker bridge gateway (172.17.0.1)
# by the compose extra_hosts mapping. That IP is the Linux bridge interface
# INSIDE WSL2, not the Windows host. The Obsidian plugin's MCP server runs on
# Windows and is unreachable at 172.17.0.1.
#
# Fix: the plugin detects the Windows vEthernet (WSL) adapter IP via
# os.networkInterfaces() and passes it as OAS_HOST_IP. When set, override
# host.docker.internal with that IP so the container can reach Windows.
#
# On native Linux / macOS, OAS_HOST_IP is not set so this block is skipped
# and host.docker.internal keeps its default (correct) value.
if [[ -n "${OAS_HOST_IP:-}" ]]; then
    echo "entrypoint: overriding host.docker.internal → ${OAS_HOST_IP} (Windows WSL host)"
    # /etc/hosts is a bind-mount inside Docker; sed -i fails because it
    # tries to rename a temp file across mount boundaries. Use cp instead.
    tmp=$(mktemp)
    # Trap cleanup so an early failure (grep / cp denied) doesn't orphan the
    # temp file. set -e would otherwise exit before the manual `rm` ran.
    trap 'rm -f "$tmp"' EXIT
    grep -v 'host\.docker\.internal' /etc/hosts > "$tmp"
    echo "${OAS_HOST_IP}  host.docker.internal" >> "$tmp"
    cat "$tmp" > /etc/hosts
    rm -f "$tmp"
    trap - EXIT
fi

# Fix directory ownership if it doesn't match claude's current uid.
# Named volumes persist across rebuilds and bind-mount targets may be
# created as root:root; check-then-chown is idempotent and skips if
# already correct, so per-start cost is essentially zero.
claude_uid=$(id -u claude)
claude_gid=$(id -g claude)

ensure_ownership() {
    local dir="$1"
    [[ -d "$dir" ]] || return 0

    # Scan for any entry whose uid OR gid doesn't match claude. Checking only
    # the top-level dir misses subdirs created as root on a persisted named
    # volume (e.g. ~/.claude/skills/ from a past `docker exec -u root` or an
    # older image build path): the parent stays claude-owned, so a top-level
    # stat passes and the recursive chown below never runs. `find -print -quit`
    # exits on the first hit, so the fast path stays cheap on healthy starts.
    if [[ -z "$(find "$dir" \( -not -uid "$claude_uid" -o -not -gid "$claude_gid" \) -print -quit 2>/dev/null)" ]]; then
        return 0
    fi

    echo "entrypoint: fixing ownership under $dir to uid $claude_uid"
    # Try chown first (works on native Linux and named volumes). Don't abort
    # on failure (many bind-mount backends (drvfs/9p, rootless Docker idmap)
    # reject chown by design) but DO log rather than swallow, so the operator
    # can see why the chmod fallback path triggered.
    chown -R "${claude_uid}:${claude_gid}" "$dir" 2>/dev/null
    rc=$?
    if [ "$rc" -ne 0 ]; then
        echo "entrypoint: chown -R failed on $dir (rc=$rc); likely a non-Linux-native mount" >&2
    fi
    # Verify by re-scanning: on 9p/drvfs mounts (Windows), chown may succeed
    # without effect. Fall back to chmod so the claude user can write
    # regardless of ownership.
    if [[ -n "$(find "$dir" \( -not -uid "$claude_uid" -o -not -gid "$claude_gid" \) -print -quit 2>/dev/null)" ]]; then
        echo "entrypoint: chown ineffective under $dir (9p/drvfs mount?), using chmod"
        chmod -R a+rwX "$dir" 2>/dev/null
        rc=$?
        if [ "$rc" -ne 0 ]; then
            echo "entrypoint: chmod -R fallback failed on $dir (rc=$rc)" >&2
        fi
    fi

    # Final write check: both chown and chmod can fail on some exotic mount
    # setups. Surface that loudly rather than letting Claude discover it later
    # via mysterious EACCES.
    if ! sudo -u "#${claude_uid}" test -w "$dir" 2>/dev/null; then
        echo "WARN: $dir is not writable by uid $claude_uid after ownership fix" >&2
    fi
}

# Defence-in-depth guard for OAS_VAULT_WRITE_DIR. The plugin performs the
# primary host-side containment check (path.resolve + prefix comparison)
# before compose establishes the bind mount. This entrypoint check is a
# second layer that catches any value that slipped through: absolute paths,
# backslashes (Windows-style), leading-dot roots, and, via realpath -m,
# anything that normalises outside /workspace/vault regardless of '..' count.
# Nested relative paths (e.g. "@Inbox/agent-workspace") are intentionally
# allowed; only escape attempts are rejected. Empty/unset uses the default.
write_dir="${OAS_VAULT_WRITE_DIR:-agent-workspace}"
case "$write_dir" in
    ""|/*|*\\*|.*)
        echo "ERROR: OAS_VAULT_WRITE_DIR='$write_dir' must be a non-empty, non-absolute, non-hidden relative path." >&2
        exit 1
        ;;
esac
resolved=$(realpath -m "/workspace/vault/$write_dir")
case "$resolved" in
    /workspace/vault/*) : ;;
    *)
        echo "ERROR: OAS_VAULT_WRITE_DIR='$write_dir' resolves to '$resolved', which is outside /workspace/vault." >&2
        exit 1
        ;;
esac

# Named volumes
ensure_ownership /home/claude/.claude
ensure_ownership /home/claude/.shell-history
ensure_ownership /home/claude/.config

# XDG subdirs for tools we redirect via env (GIT_CONFIG_GLOBAL,
# NPM_CONFIG_USERCONFIG). git/npm won't create parent dirs on first write,
# so e.g. `gh auth login` → `gh config set ... git_protocol` fails with
# "could not lock config file" if .config/git/ is missing on the volume.
install -d -o "$claude_uid" -g "$claude_gid" -m 755 \
    /home/claude/.config/git \
    /home/claude/.config/npm
# Vault RW overlays
ensure_ownership "/workspace/vault/${write_dir}"
ensure_ownership /workspace/vault/.oas

# IPv4-only stance: docker-compose sets net.ipv6.conf.all.disable_ipv6=1, but
# some host kernels reject the sysctl (e.g. when ipv6 is built as a module
# that hasn't loaded). Hard-fail rather than allow IPv6 traffic; the
# firewall has no IPv6 rules so an enabled stack would be unfirewalled.
if [[ -r /proc/sys/net/ipv6/conf/all/disable_ipv6 ]]; then
    if [[ "$(cat /proc/sys/net/ipv6/conf/all/disable_ipv6)" != "1" ]]; then
        echo "ERROR: IPv6 is not disabled (expected disable_ipv6=1)." >&2
        echo "       The firewall has only IPv4 rules; enabled IPv6 would be unfirewalled." >&2
        echo "       Verify the host kernel honours net.ipv6.conf.all.disable_ipv6 sysctl." >&2
        exit 1
    fi
fi

# Prompt templates are not seeded; auto-seeding would overwrite user-edited prompts.

# Ensure memory file exists (MCP memory server expects it).
#
# Defence-in-depth guard mirroring the OAS_VAULT_WRITE_DIR check above. The
# plugin validates the name host-side (isValidMemoryFileName), but a
# hand-edited .env in standalone use bypasses the plugin. A plain file name
# only: no slashes, no backslashes, no leading dot. Rejecting separators
# keeps the install below contained to /workspace/vault/.oas/ ('..' needs a
# separator to escape, and bare '..' is caught by the leading-dot pattern).
memory_name="${OAS_MEMORY_FILE_NAME:-memory.json}"
case "$memory_name" in
    ""|*/*|*\\*|.*)
        echo "ERROR: OAS_MEMORY_FILE_NAME='$memory_name' must be a plain file name (no slashes, no leading dot)." >&2
        exit 1
        ;;
esac
memory_file="/workspace/vault/.oas/${memory_name}"
if [[ ! -f "$memory_file" ]]; then
    install -o "${claude_uid}" -g "${claude_gid}" -m 644 /dev/null "$memory_file"
fi

# Drop to the claude user and run ttyd. OAS_TTYD_PORT falls through from
# docker-compose.yml (defaults to 7681).
#
# -d 6 raises ttyd's log level from the default (notice) to info, so each
# WebSocket open/close lands in `docker logs oas-sandbox` with timestamp
# and remote addr. Override via OAS_TTYD_DEBUG (libwebsockets bitmask: 1=ERR 2=WARN 4=NOTICE 8=INFO 16=DEBUG) if you
# need more detail; ttyd's WS ping interval defaults to 5s and is fine.
exec gosu claude ttyd -W -d "${OAS_TTYD_DEBUG:-6}" -p "${OAS_TTYD_PORT:-7681}" /usr/local/bin/session.sh
