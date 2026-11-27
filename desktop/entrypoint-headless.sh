#!/bin/bash
set -u

export HOME=/home/desktop
export XDG_RUNTIME_DIR=/tmp/runtime-desktop
DESKTOP_USER=desktop
EXEC_PORT="${EXECD_PORT:-3213}"

log() { echo "[$(date -Iseconds)] start-headless: $*"; }

mkdir -p "$XDG_RUNTIME_DIR" /run/cua
chown "$DESKTOP_USER":"$DESKTOP_USER" "$XDG_RUNTIME_DIR"
chmod 700 "$XDG_RUNTIME_DIR"

if [ -n "${CUA_ENV_TOKEN:-}" ]; then
  printf '%s\n' "$CUA_ENV_TOKEN" >/run/cua/env-token
  unset CUA_ENV_TOKEN
  log "token: provided by environment"
fi
if [ ! -s /run/cua/env-token ]; then
  for _ in $(seq 1 20); do
    [ -s /run/cua/env-token ] && break
    sleep 1
  done
fi
if [ ! -s /run/cua/env-token ]; then
  head -c 32 /dev/urandom | od -An -tx1 | tr -d ' \n' >/run/cua/env-token
  echo >>/run/cua/env-token
  log "token: generated at /run/cua/env-token"
else
  log "token: found at /run/cua/env-token"
fi
chown root:"$DESKTOP_USER" /run/cua/env-token
chmod 0640 /run/cua/env-token

mkdir -p /home/desktop/repos
chown -R "$DESKTOP_USER":"$DESKTOP_USER" /home/desktop

log "execd starting on 0.0.0.0:${EXEC_PORT}"
exec su-exec "$DESKTOP_USER" bash -c '
  export HOME=/home/desktop
  export EXECD_DEFAULT_CWD=/home/desktop
  export PORT="'"$EXEC_PORT"'"
  export CUA_ENV_TOKEN="$(cat /run/cua/env-token)"
  exec bun /opt/execd/index.mjs
'
