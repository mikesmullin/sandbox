#!/usr/bin/env bash
set -euo pipefail
DESKTOP_USER="${CUA_DESKTOP_USER:-cua}"
if [ "$(id -u)" = 0 ] && [ "${CUA_AS_ROOT:-0}" != 1 ]; then
    exec runuser -u "$DESKTOP_USER" -- "$0" "$@"
fi
ENV_FILE="${CUA_DESKTOP_RUNTIME_DIR:-/run/cua-desktop}/desktop.env"
if [ -r "$ENV_FILE" ]; then
    set -a; . "$ENV_FILE"; set +a
else
    export DISPLAY="${CUA_DISPLAY:-:1}"
fi
export HOME="${HOME:-/home/$(id -un)}"
[ "$#" -gt 0 ] || set -- bash -l
exec "$@"
