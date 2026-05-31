#!/usr/bin/env bash
set -euo pipefail

# Allowlist-based outbound firewall for headless Claude Code usage.
# Restricts outbound traffic to known-good domains only.
# Usage: /usr/local/bin/init-firewall.sh [--disable|--status|--list-sources]

SOURCES_FILE="/etc/oas/firewall-sources.tsv"
BASELINE_FILE="/etc/oas/firewall-baseline.txt"
EXTRAS_FILE="/etc/oas/firewall-extras.txt"
LOCK_FILE="/var/lock/oas-firewall.lock"

# Serialise concurrent invocations. A re-init racing the ipset swap can leave
# the OUTPUT chain attached to a half-built set. flock with -n bails fast
# rather than queueing — the second caller's intent is already satisfied
# by the first. --status and --list-sources don't mutate active ruleset
# state so they skip the lock to stay responsive.
case "${1:-}" in
  --status|--list-sources) ;;
  *)
    # --disable also takes the lock because it mutates the active ruleset
    # (flushes OUTPUT, destroys ipset); running concurrently with the apply
    # path would destroy allowed_ips mid-swap.
    exec 9>"$LOCK_FILE"
    if ! flock -n 9; then
      echo "init-firewall.sh: another instance is already running ($LOCK_FILE)" >&2
      exit 1
    fi
    ;;
esac

case "${1:-}" in
  --disable)
    iptables -F OUTPUT 2>/dev/null || true
    iptables -P OUTPUT ACCEPT
    ipset destroy allowed_ips 2>/dev/null || true
    echo "Firewall disabled."
    exit 0
    ;;
  --status)
    if iptables -L OUTPUT -n 2>/dev/null | grep -q "DROP"; then
      echo "enabled"
    else
      echo "disabled"
    fi
    exit 0
    ;;
  --list-sources)
    if [ ! -f "$SOURCES_FILE" ]; then
      echo "(no firewall-sources file — firewall has not been initialized in this container)" >&2
      exit 1
    fi
    # Pretty-print grouped by source tag
    awk -F'\t' '{printf "[%-8s] %s\n", $1, $2}' "$SOURCES_FILE" | sort
    exit 0
    ;;
esac


# Assemble the effective allowlist from three sources. Record each
# entry's origin for later inspection via --list-sources.
# Sources are additive — no override semantics, duplicates are harmless.
mkdir -p "$(dirname "$SOURCES_FILE")"
: > "$SOURCES_FILE"

declare -A SEEN
declare -a ALLOWED_DOMAINS=()
declare -a BASELINE_ENTRIES=()

_trim() {
  local s="$1"
  # Strip CR (handles CRLF line endings from Windows-edited files like
  # firewall-extras.txt) before whitespace trimming.
  s="${s//$'\r'/}"
  s="${s#"${s%%[![:space:]]*}"}"
  s="${s%"${s##*[![:space:]]}"}"
  printf '%s' "$s"
}

# Validate an IPv4 octet (0-255). Rejects leading-zero forms ("01", "010")
# because some libc inet_aton variants reinterpret them as octal — a user
# typing "0177.0.0.1" would otherwise get a literal-decimal rule when they
# meant 127.0.0.1. Always reject to keep the contract dot-decimal-only.
_is_valid_octet() {
  local n="$1"
  [[ "$n" =~ ^(0|[1-9][0-9]*)$ ]] || return 1
  (( n >= 0 && n <= 255 ))
}

# Returns 0 if "$1" is a valid IPv4 address or IPv4 CIDR. Hostnames rejected.
_is_ipv4_or_cidr() {
  local entry="$1"
  local addr="$entry"
  local prefix=""
  if [[ "$entry" == */* ]]; then
    addr="${entry%/*}"
    prefix="${entry#*/}"
    [[ "$prefix" =~ ^[0-9]+$ ]] || return 1
    (( prefix >= 0 && prefix <= 32 )) || return 1
  fi
  local IFS=.
  # shellcheck disable=SC2206
  local parts=( $addr )
  [ "${#parts[@]}" -eq 4 ] || return 1
  local p
  for p in "${parts[@]}"; do
    _is_valid_octet "$p" || return 1
  done
  return 0
}

add_entry() {
  local tag="$1"
  local entry
  entry="$(_trim "$2")"
  [ -z "$entry" ] && return
  # Skip duplicates but record the additional source tag
  if [ -n "${SEEN[$entry]:-}" ]; then
    printf '%s\t%s\n' "$tag" "$entry" >> "$SOURCES_FILE"
    return
  fi
  SEEN[$entry]=1
  ALLOWED_DOMAINS+=("$entry")
  printf '%s\t%s\n' "$tag" "$entry" >> "$SOURCES_FILE"
}

# Baseline — read from host-managed file (mounted ro at BASELINE_FILE).
# The file is also baked into the image as a fallback so the container
# works if the host mount is absent. Both the directory-shadow case and
# the missing-file case are hard errors: the baseline is required for
# normal Claude Code operation and its absence indicates a configuration
# problem that must not be silently papered over.
if [ -d "$BASELINE_FILE" ]; then
  echo "init-firewall: ERROR: $BASELINE_FILE is a directory (host file missing — Docker auto-created the mount target). Baseline domains cannot be loaded. Restore container/firewall-baseline.txt on the host and 'docker compose down && up -d' to re-bind." >&2
  exit 1
elif [ ! -f "$BASELINE_FILE" ]; then
  echo "init-firewall: ERROR: $BASELINE_FILE not found. The baseline allowlist is required — ensure the image was built with the file baked in." >&2
  exit 1
else
  first_line=1
  while IFS= read -r line || [ -n "$line" ]; do
    # Strip UTF-8 BOM on the first line (Windows editors may insert one).
    if [ "$first_line" = "1" ]; then
      line="${line#$'\xEF\xBB\xBF'}"
      first_line=0
    fi
    # Strip comments and trim
    line="${line%%#*}"
    entry="$(_trim "$line")"
    [ -z "$entry" ] && continue
    BASELINE_ENTRIES+=("$entry")
    add_entry baseline "$entry"
  done < "$BASELINE_FILE"
fi

# Plugin-supplied (comma-separated env var). Strip `#` comments so a user
# who put a comment in the env var doesn't end up trying to resolve a domain
# with trailing `#text` (silent DNS-resolution failure with no clear cause).
if [ -n "${OAS_ALLOWED_DOMAINS:-}" ]; then
  IFS=',' read -ra PLUGIN_EXTRAS <<< "$OAS_ALLOWED_DOMAINS"
  for d in "${PLUGIN_EXTRAS[@]}"; do
    d="${d%%#*}"
    add_entry plugin "$d"
  done
fi

# Host-managed file (read-only mount, invisible to Claude). Defensive:
# if the host deleted firewall-extras.txt before `docker compose up`,
# Docker auto-creates the mount target as a *directory* (the bind source
# doesn't exist, so Docker treats it as a folder), and a -f test silently
# returns false — extras are dropped without any user-visible signal.
# Flag the directory case so the operator notices, but still proceed so
# the firewall comes up.
if [ -d "$EXTRAS_FILE" ]; then
  echo "init-firewall: WARNING: $EXTRAS_FILE is a directory (host file missing — Docker auto-created the mount target). File-tier extras skipped. Restore container/firewall-extras.txt on the host and 'docker compose down && up -d' to re-bind." >&2
elif [ -f "$EXTRAS_FILE" ]; then
  first_line=1
  while IFS= read -r line || [ -n "$line" ]; do
    # Strip UTF-8 BOM on the first line — Windows editors often save with
    # one and the resulting `﻿host.example.com` fails IPv4 routing,
    # gets passed to dig, returns no records, and is logged as a generic
    # resolution failure with no hint at the real cause.
    if [ "$first_line" = "1" ]; then
      line="${line#$'\xEF\xBB\xBF'}"
      first_line=0
    fi
    # Strip comments and trim
    line="${line%%#*}"
    add_entry file "$line"
  done < "$EXTRAS_FILE"
fi

# Resolve domains BEFORE flipping the OUTPUT policy. A DNS hiccup must not
# leave the container with a DROP policy and no rules; existing rules from a
# prior successful init keep protecting until the atomic swap below.
#
# Build a fresh ipset in parallel with the existing one — only swap on
# success.
ipset create allowed_ips hash:net -exist
ipset create allowed_ips_new hash:net -exist
ipset flush allowed_ips_new

# Trap orphan cleanup: if `set -e` aborts anywhere between here and the
# final `ipset destroy allowed_ips_new` below, the new set is left dangling.
# This trap clears it on any abnormal exit; the success path disarms it.
trap 'ipset destroy allowed_ips_new 2>/dev/null || true' EXIT

echo "Resolving domains..."
# Track baseline domains separately so a failure to resolve one (e.g.
# api.anthropic.com) is treated as a hard error rather than a silent gap.
# Plugin/file-supplied entries can fail safely with a warning — the user
# may have typo'd a domain or be working offline.
declare -A IS_BASELINE
for d in "${BASELINE_ENTRIES[@]}"; do IS_BASELINE[$d]=1; done

# Resolve a single domain with up to N retries. Baseline domains retry so
# transient resolver glitches don't brick the firewall apply. Optional
# user-supplied domains use a single attempt so typos surface fast.
_resolve_domain() {
  local domain="$1" tries="$2" attempt=0 ips=""
  while [ "$attempt" -lt "$tries" ]; do
    ips=$(dig +time=2 +tries=1 +short A "$domain" 2>/dev/null | grep -E '^[0-9]+\.' || true)
    if [ -n "$ips" ]; then
      printf '%s\n' "$ips"
      return 0
    fi
    attempt=$((attempt + 1))
    [ "$attempt" -lt "$tries" ] && sleep 1
  done
  return 1
}

PIDS=()
PID_DOMAIN=()
PID_TIER=()
for entry in "${ALLOWED_DOMAINS[@]}"; do
  # CIDR (e.g. 10.0.0.0/16) or bare IPv4 — add directly, no DNS needed.
  # Octet bounds and prefix length are validated by _is_ipv4_or_cidr;
  # the simple shape regex below is just to route CIDR-shaped entries
  # away from DNS resolution.
  if [[ "$entry" =~ ^[0-9]+(\.[0-9]+){3}(/[0-9]+)?$ ]]; then
    if _is_ipv4_or_cidr "$entry"; then
      cidr="$entry"
      [[ "$cidr" != */* ]] && cidr="${cidr}/32"
      ipset add allowed_ips_new "$cidr" -exist
    else
      echo "WARNING: skipping invalid IPv4/CIDR entry: $entry" >&2
    fi
    continue
  fi
  if [ -n "${IS_BASELINE[$entry]:-}" ]; then
    tries=3
    tier="baseline"
  else
    tries=1
    tier="optional"
  fi
  (
    set -e
    ips="$(_resolve_domain "$entry" "$tries")" || exit 1
    for ip in $ips; do
      ipset add allowed_ips_new "${ip}/32" -exist || exit 1
    done
  ) &
  PIDS+=($!)
  PID_DOMAIN+=("$entry")
  PID_TIER+=("$tier")
done

BASELINE_FAILED=0
OPTIONAL_FAILED=0
for i in "${!PIDS[@]}"; do
  pid="${PIDS[$i]}"
  if ! wait "$pid"; then
    domain="${PID_DOMAIN[$i]}"
    tier="${PID_TIER[$i]}"
    if [ "$tier" = "baseline" ]; then
      echo "ERROR: failed to resolve baseline domain $domain" >&2
      BASELINE_FAILED=$((BASELINE_FAILED + 1))
    else
      echo "WARNING: failed to resolve $domain ($tier)" >&2
      OPTIONAL_FAILED=$((OPTIONAL_FAILED + 1))
    fi
  fi
done

if [ "$BASELINE_FAILED" -gt 0 ]; then
  echo "ERROR: $BASELINE_FAILED baseline domain(s) failed to resolve — refusing to apply firewall with required gaps" >&2
  ipset destroy allowed_ips_new 2>/dev/null || true
  # Existing OUTPUT chain (if any) is left intact — policy and rules are
  # untouched on this code path.
  exit 1
fi
if [ "$OPTIONAL_FAILED" -gt 0 ]; then
  echo "WARNING: $OPTIONAL_FAILED optional domain(s) failed to resolve — firewall applied without them" >&2
fi

# Aggregate into CIDR blocks if possible
if command -v aggregate &>/dev/null; then
  AGGREGATED=$(ipset list allowed_ips_new | grep -E '^[0-9]' | aggregate -q 2>/dev/null || true)
  if [ -n "$AGGREGATED" ]; then
    ipset flush allowed_ips_new
    while IFS= read -r cidr; do
      ipset add allowed_ips_new "$cidr" -exist
    done <<< "$AGGREGATED"
  fi
fi

# Atomically swap the ipset so iptables rules always reference a complete set
ipset swap allowed_ips_new allowed_ips
ipset destroy allowed_ips_new
# Disarm the orphan-cleanup trap now that allowed_ips_new is gone; reapply
# at the end so a failure in iptables-restore below doesn't leak.
trap - EXIT

# Build the OUTPUT chain into a single iptables-restore transaction so the
# chain is replaced atomically. Per-rule `-A OUTPUT` calls would leave a
# sub-second window where the DROP policy was in force with no ACCEPT rules,
# silently dropping traffic. iptables-restore commits everything in one
# kernel transaction.
MCP_PORT="${OAS_MCP_PORT:-28080}"
# Validate MCP_PORT — typo'd values would land verbatim in --dport and
# iptables-restore would reject the whole transaction, leaving the firewall
# half-applied with the previous OUTPUT rules intact (or completely down on
# a fresh container).
if ! [[ "$MCP_PORT" =~ ^[0-9]+$ ]] || (( MCP_PORT < 1 || MCP_PORT > 65535 )); then
  echo "init-firewall: ERROR: invalid OAS_MCP_PORT='$MCP_PORT' (must be 1-65535)" >&2
  exit 1
fi
# Take the first default route only — multiple default routes (rare, e.g.
# attached secondary networks) would otherwise produce a multi-line literal
# that iptables-restore rejects.
GATEWAY=$(ip route | awk '/default/ {print $3; exit}')
OAS_HOST=$(getent hosts host.docker.internal 2>/dev/null | awk '{print $1; exit}')
# Reject OAS_HOST if it isn't an IPv4 address. getent can return an IPv6
# alias for host.docker.internal on some hosts; passing it verbatim to
# iptables-restore (which expects IPv4) aborts the transaction.
if [ -n "$OAS_HOST" ] && ! _is_ipv4_or_cidr "$OAS_HOST"; then
  echo "init-firewall: WARNING: host.docker.internal resolved to non-IPv4 '$OAS_HOST' — skipping MCP gateway rule" >&2
  OAS_HOST=""
fi

# Collect IPv4 nameservers BEFORE building the rule heredoc. If there are no
# IPv4 nameservers in resolv.conf (IPv6-only Docker network, unusual host
# config), DNS would be silently dropped under the OUTPUT DROP policy below.
# Bail loudly here so the operator sees the cause instead of a "firewall
# active" message followed by inexplicable resolution failures.
mapfile -t NAMESERVERS < <(grep -oP 'nameserver \K[\d.]+' /etc/resolv.conf)
if [ "${#NAMESERVERS[@]}" -eq 0 ]; then
  echo "init-firewall: ERROR: no IPv4 nameservers found in /etc/resolv.conf — DNS would be unreachable under the planned OUTPUT DROP policy. Aborting before applying any rules." >&2
  exit 1
fi

# Collect nameservers up-front; assemble rules into a heredoc; pipe to
# iptables-restore -n (no-flush of *other* tables) with a single commit.
{
  echo "*filter"
  # Set policies inside the table block so they apply together with the
  # rule additions in one transaction.
  echo ":INPUT ACCEPT [0:0]"
  echo ":FORWARD ACCEPT [0:0]"
  echo ":OUTPUT DROP [0:0]"

  echo "-F OUTPUT"

  echo "-A OUTPUT -o lo -j ACCEPT"
  echo "-A OUTPUT -m state --state ESTABLISHED,RELATED -j ACCEPT"

  # DNS — restrict to configured resolvers only (prevents DNS tunneling).
  # IPv4-only by design; presence of at least one resolver was checked above.
  for ns in "${NAMESERVERS[@]}"; do
    echo "-A OUTPUT -d $ns -p udp --dport 53 -j ACCEPT"
    echo "-A OUTPUT -d $ns -p tcp --dport 53 -j ACCEPT"
  done

  # Block cloud metadata + DNS-rebinding surfaces BEFORE allowlist ACCEPTs —
  # defense in depth in case any of these IPs ends up in allowed_ips by mistake
  # (a malicious authoritative DNS for an allowlisted domain can return any IP).
  #   169.254.0.0/16 — link-local incl. AWS/Azure/GCP metadata (.169.254)
  #   100.64.0.0/10  — CGNAT range incl. Alibaba metadata (100.100.100.200)
  # Legitimate access to these is opt-in via OAS_ALLOWED_PRIVATE_HOSTS (which
  # adds rules AFTER these DROPs but is keyed on specific IPv4/CIDRs, not the
  # broad ranges below).
  echo "-A OUTPUT -d 169.254.0.0/16 -j DROP"
  echo "-A OUTPUT -d 100.64.0.0/10 -j DROP"

  echo "-A OUTPUT -m set --match-set allowed_ips dst -p tcp --dport 443 -j ACCEPT"
  echo "-A OUTPUT -m set --match-set allowed_ips dst -p tcp --dport 80 -j ACCEPT"

  # Docker gateway — port-scoped (HTTP/HTTPS + MCP only). The gateway is
  # the path to all host services, so a wide-open rule would be a hole in
  # NAT mode.
  if [ -n "$GATEWAY" ]; then
    echo "-A OUTPUT -d $GATEWAY -p tcp --dport 80 -j ACCEPT"
    echo "-A OUTPUT -d $GATEWAY -p tcp --dport 443 -j ACCEPT"
    echo "-A OUTPUT -d $GATEWAY -p tcp --dport $MCP_PORT -j ACCEPT"
  fi

  # Obsidian MCP host — host.docker.internal can resolve to the gateway or
  # to a separately mapped adapter (WSL2 mirrored). Always emit the MCP
  # rule independently.
  if [ -n "$OAS_HOST" ]; then
    echo "-A OUTPUT -d $OAS_HOST -p tcp --dport $MCP_PORT -j ACCEPT"
  fi

  # Configurable private hosts. IPv4 / IPv4-CIDR only; hostnames rejected
  # (we can't safely resolve them inside the firewall apply path).
  if [ -n "${OAS_ALLOWED_PRIVATE_HOSTS:-}" ]; then
    IFS=',' read -ra HOSTS <<< "$OAS_ALLOWED_PRIVATE_HOSTS"
    for host in "${HOSTS[@]}"; do
      host="$(_trim "$host")"
      [ -z "$host" ] && continue
      if ! _is_ipv4_or_cidr "$host"; then
        echo "ERROR: OAS_ALLOWED_PRIVATE_HOSTS entry '$host' is not a valid IPv4 address or CIDR — hostnames are not accepted here. Skipping." >&2
        continue
      fi
      echo "-A OUTPUT -d $host -p tcp --dport 80 -j ACCEPT"
      echo "-A OUTPUT -d $host -p tcp --dport 443 -j ACCEPT"
      echo "-A OUTPUT -d $host -p tcp --dport $MCP_PORT -j ACCEPT"
    done
  fi

  # Explicit terminal DROP (defense in depth — policy is also DROP).
  echo "-A OUTPUT -j DROP"

  echo "COMMIT"
} | iptables-restore -n

echo "Firewall active. $(ipset list allowed_ips | grep -c '^[0-9]') IP entries allowlisted."
echo "To disable: /usr/local/bin/init-firewall.sh --disable"
