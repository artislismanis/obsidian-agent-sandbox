#!/bin/bash
set -euo pipefail

exec ttyd -W -p 7681 /usr/local/bin/session.sh
