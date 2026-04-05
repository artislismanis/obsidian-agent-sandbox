#!/bin/bash
set -euo pipefail

TTYD_ARGS=(-W -p 7681)

if [[ -n "${TTYD_PASSWORD:-}" ]]; then
  TTYD_ARGS+=(--credential "${TTYD_USER:-user}:${TTYD_PASSWORD}")
fi

exec ttyd "${TTYD_ARGS[@]}" /usr/local/bin/session.sh
