#!/usr/bin/env bash
set -euo pipefail
. /opt/cua/bin/env-token-mode.sh
BIN="${CUA_SPACESD_BIN:-${CUA_GUESTD_BIN:-${CUA_ENV_DRIVER_BIN:-/usr/local/bin/cua-spacesd}}}"
CUA_SPACESD_ARGS="${CUA_SPACESD_ARGS:-${CUA_GUESTD_ARGS:-${CUA_ENV_DRIVER_ARGS:-}}}"
if [ -z "$CUA_SPACESD_ARGS" ] && [ -n "${CUA_ENV_RELAY_URL:-${CUA_SPACESD_RELAY_URL:-}}" ]; then
    CUA_SPACESD_ARGS=join
fi
export CUA_ENV_PORT="${CUA_ENV_PORT:-3211}"
export CUA_ENV_ALLOW_ANONYMOUS="${CUA_ENV_ALLOW_ANONYMOUS:-0}"

if [ ! -x "$BIN" ]; then
    echo "[$(date -Iseconds)] cua-spacesd not installed at $BIN; idling (image built with CUA_SPACESD_SOURCE=none)"
    exec sleep infinity
fi

if cua_await_token_file; then
    if [ -r "$CUA_CLAIM_TOKEN_FILE" ] \
        && [ "$(( 0$(stat -L -c %a "$CUA_CLAIM_TOKEN_FILE" 2>/dev/null || echo 7) & 7 ))" = 0 ]; then
        export CUA_ENV_TOKEN_FILE="$CUA_CLAIM_TOKEN_FILE"
    else
        export CUA_ENV_TOKEN_FILE="$CUA_SYNCED_TOKEN_FILE"
    fi
    export CUA_ENV_AWAIT_TOKEN_FILE=1
    unset CUA_ENV_TOKEN
fi

token="${CUA_ENV_TOKEN:-}"
[ "${CUA_ENV_AWAIT_TOKEN_FILE:-}" = 1 ] && token=await
for f in "${CUA_ENV_TOKEN_FILE:-}" /run/cua/env-token /etc/cua/env-token; do
    [ -n "$token" ] && break
    [ -n "$f" ] && [ -r "$f" ] && token="$(tr -d '\r\n' <"$f")"
done
if [ -z "$token" ]; then
    echo "[$(date -Iseconds)] no spacesd token (CUA_ENV_TOKEN, /run/cua/env-token, /etc/cua/env-token); refusing to start"
    exit 1
fi
if [ "${CUA_ENV_AWAIT_TOKEN_FILE:-}" = 1 ]; then
    token_desc="awaiting token file $CUA_ENV_TOKEN_FILE"
else
    export CUA_ENV_TOKEN="$token"
    token_desc="token set"
fi

ENV_FILE="${CUA_DESKTOP_RUNTIME_DIR:-/run/cua-desktop}/desktop.env"
for _ in $(seq 1 60); do
    [ -r "$ENV_FILE" ] && break
    sleep 1
done
if [ -r "$ENV_FILE" ]; then set -a; . "$ENV_FILE"; set +a; else export DISPLAY="${CUA_DISPLAY:-:1}"; fi

echo "[$(date -Iseconds)] starting $BIN on 0.0.0.0:$CUA_ENV_PORT (DISPLAY=$DISPLAY, $token_desc)"
# shellcheck disable=SC2086  # CUA_SPACESD_ARGS is a flag list
exec "$BIN" ${CUA_SPACESD_ARGS:-}
