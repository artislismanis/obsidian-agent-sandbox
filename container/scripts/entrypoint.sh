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

# Drop to the claude user and run ttyd. TTYD_PORT falls through from
# docker-compose.yml (defaults to 7681).
exec gosu claude ttyd -W -p "${TTYD_PORT:-7681}" /usr/local/bin/session.sh
