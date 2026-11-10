#!/bin/bash
# sbox headless sandbox entrypoint (runs as root; drops to `desktop` via su-exec).
#
# Startup order — the headed entrypoint's first step and last step, with the
# whole desktop in between removed:
#   1. materialize the env token at /run/cua/env-token (root:desktop 0640)
#   2. execd on 0.0.0.0:3213 as the desktop user
#
# There is no D-Bus, no Xvfb, no session and no spacesd here. Readiness is
# execd's own /healthz on 3213 — the backend probes that for `headless`
# records, not spacesd's /health on 3211, which this image never binds.
set -u

export HOME=/home/desktop
export XDG_RUNTIME_DIR=/tmp/runtime-desktop
DESKTOP_USER=desktop
EXEC_PORT="${EXECD_PORT:-3213}"

log() { echo "[$(date -Iseconds)] start-headless: $*"; }

mkdir -p "$XDG_RUNTIME_DIR" /run/cua
chown "$DESKTOP_USER":"$DESKTOP_USER" "$XDG_RUNTIME_DIR"
chmod 700 "$XDG_RUNTIME_DIR"

# ── 1. env token ─────────────────────────────────────────────────────────────
# Identical contract to the headed image: first match wins — CUA_ENV_TOKEN
# (injected at `container create -e`), then an exec-pushed token file, then a
# generated one. execd authenticates Bearer against this same value, so the
# host's HMAC(secret, containerId) works on either image unchanged.
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

# ── 2. execd ─────────────────────────────────────────────────────────────────
# Bind 0.0.0.0 so the published host port reaches it (the container's own
# loopback is not the host's). The token is read from the file rather than
# passed in argv, so it never shows up in a process listing.
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
