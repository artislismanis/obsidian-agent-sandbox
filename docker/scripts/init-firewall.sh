#!/usr/bin/env bash
set -euo pipefail

# Allowlist-based outbound firewall for headless Claude Code usage.
# Restricts outbound traffic to known-good domains only.
# Usage: sudo /usr/local/bin/init-firewall.sh

ALLOWED_DOMAINS=(
  # Anthropic
  api.anthropic.com
  statsig.anthropic.com
  sentry.io

  # npm
  registry.npmjs.org
  registry.yarnpkg.com

  # GitHub
  github.com
  api.github.com
  raw.githubusercontent.com
  objects.githubusercontent.com
  github-releases.githubusercontent.com
  cli.github.com

  # PyPI
  pypi.org
  files.pythonhosted.org

  # CDNs
  cdn.jsdelivr.net
  cdnjs.cloudflare.com
  unpkg.com
)

# Create or flush the ipset
ipset create allowed_ips hash:net -exist
ipset flush allowed_ips

echo "Resolving domains..."
for domain in "${ALLOWED_DOMAINS[@]}"; do
  (
    ips=$(dig +short A "$domain" 2>/dev/null | grep -E '^[0-9]+\.' || true)
    for ip in $ips; do
      ipset add allowed_ips "${ip}/32" -exist
    done
  ) &
done
wait

# Aggregate into CIDR blocks if possible
if command -v aggregate &>/dev/null; then
  AGGREGATED=$(ipset list allowed_ips | grep -E '^[0-9]' | aggregate -q 2>/dev/null || true)
  if [ -n "$AGGREGATED" ]; then
    ipset flush allowed_ips
    while IFS= read -r cidr; do
      ipset add allowed_ips "$cidr" -exist
    done <<< "$AGGREGATED"
  fi
fi

# Flush existing OUTPUT rules (idempotent)
iptables -F OUTPUT 2>/dev/null || true

# Allow loopback
iptables -A OUTPUT -o lo -j ACCEPT

# Allow established/related connections
iptables -A OUTPUT -m state --state ESTABLISHED,RELATED -j ACCEPT

# Allow DNS
iptables -A OUTPUT -p udp --dport 53 -j ACCEPT
iptables -A OUTPUT -p tcp --dport 53 -j ACCEPT

# Allow traffic to allowlisted IPs
iptables -A OUTPUT -m set --match-set allowed_ips dst -p tcp --dport 443 -j ACCEPT
iptables -A OUTPUT -m set --match-set allowed_ips dst -p tcp --dport 80 -j ACCEPT

# Allow private networks (port forwarding, host access)
iptables -A OUTPUT -d 10.0.0.0/8 -j ACCEPT
iptables -A OUTPUT -d 172.16.0.0/12 -j ACCEPT
iptables -A OUTPUT -d 192.168.0.0/16 -j ACCEPT
iptables -A OUTPUT -d 169.254.0.0/16 -j ACCEPT

# Drop everything else
iptables -A OUTPUT -j DROP

echo "Firewall active. $(ipset list allowed_ips | grep -c '^[0-9]') IP entries allowlisted."
echo "To disable: iptables -F OUTPUT"
