#!/bin/bash
# Start the virtual XFCE desktop: Xvfb → session → x11vnc → noVNC → Chromium + agent-browser.
set -u

DISPLAY="${DISPLAY:-:99}"
GEOMETRY="${GEOMETRY:-1280x800x24}"
VNC_PORT="${VNC_PORT:-5900}"
NOVNC_PORT="${NOVNC_PORT:-6080}"
CDP_PORT="${CDP_PORT:-9222}"
AGENT_PORT="${AGENT_PORT:-8091}"
HOME="${HOME:-/home/agent}"
export DISPLAY HOME
export XDG_RUNTIME_DIR="${XDG_RUNTIME_DIR:-/tmp/runtime-agent}"
export XDG_CONFIG_HOME="${HOME}/.config"
export XDG_CACHE_HOME="${HOME}/.cache"
export XDG_DATA_HOME="${HOME}/.local/share"
export XDG_CURRENT_DESKTOP=XFCE
export XFCE_PANEL_MIGRATE_DEFAULT=true
export AGENT_BROWSER_EXECUTABLE_PATH="${AGENT_BROWSER_EXECUTABLE_PATH:-/usr/local/bin/chromium}"
export AGENT_BROWSER_HEADED=1

mkdir -p \
  "$XDG_RUNTIME_DIR" \
  "$XDG_CONFIG_HOME" \
  "$XDG_CACHE_HOME" \
  "$XDG_DATA_HOME" \
  "$HOME/.vnc" \
  "$HOME/.config/chromium" \
  /workspace

# emptyDir hides the image /workspace. Point the jail at the bun-linked
# vendor trees so `bun` from cwd does not fall through to npm's stale agl-ai.
mkdir -p /workspace/node_modules
ln -sfn /opt/vendor/agl /workspace/node_modules/agl-ai
ln -sfn /opt/vendor/angela /workspace/node_modules/angela
if [ ! -f /workspace/package.json ]; then
  printf '%s\n' '{"name":"desktop-workspace","private":true,"type":"module"}' > /workspace/package.json
fi

chmod 700 "$XDG_RUNTIME_DIR" || true

NOVNC_WEB=""
for candidate in /usr/share/novnc /usr/share/web/novnc /usr/share/novnc/www; do
  if [ -f "$candidate/vnc.html" ]; then
    NOVNC_WEB="$candidate"
    break
  fi
done
if [ -z "$NOVNC_WEB" ]; then
  echo "[entrypoint] noVNC web root not found" >&2
  exit 1
fi

log() { printf '[%s] %s\n' "$1" "$2"; }

wait_for_x() {
  local i
  for i in $(seq 1 80); do
    if xdpyinfo -display "$DISPLAY" >/dev/null 2>&1; then
      return 0
    fi
    sleep 0.1
  done
  echo "[entrypoint] Xvfb failed to become ready on $DISPLAY" >&2
  return 1
}

wait_for_port() {
  local host="$1" port="$2" name="$3" i
  for i in $(seq 1 80); do
    if python3 - "$host" "$port" <<'PY' >/dev/null 2>&1
import socket, sys
s = socket.socket()
s.settimeout(0.2)
try:
    s.connect((sys.argv[1], int(sys.argv[2])))
except Exception:
    sys.exit(1)
finally:
    s.close()
PY
    then
      return 0
    fi
    sleep 0.25
  done
  log "$name" "still waiting for ${host}:${port}"
  return 1
}

cleanup() {
  log entrypoint "shutting down"
  kill $(jobs -p) 2>/dev/null || true
}
trap cleanup EXIT INT TERM

# Session D-Bus for XFCE / Thunar / Chromium.
if [ -z "${DBUS_SESSION_BUS_ADDRESS:-}" ]; then
  # shellcheck disable=SC2046
  eval $(dbus-launch --sh-syntax)
  export DBUS_SESSION_BUS_ADDRESS DBUS_SESSION_BUS_PID
  log dbus "session bus $DBUS_SESSION_BUS_ADDRESS"
fi

log xvfb "starting $DISPLAY ${GEOMETRY}"
Xvfb "$DISPLAY" -screen 0 "$GEOMETRY" -ac +extension RANDR +extension GLX +render -noreset \
  +extension MIT-SHM \
  2>&1 | sed 's/^/[xvfb] /' &

wait_for_x || exit 1
xset s off -dpms >/dev/null 2>&1 || true

log xfce "starting session"
/usr/local/bin/xfce-session.sh 2>&1 | sed 's/^/[xfce] /' &

sleep 1

# x11vnc talks only to localhost; noVNC/websockify is the published surface.
log x11vnc "listening on 127.0.0.1:${VNC_PORT}"
x11vnc \
  -display "$DISPLAY" \
  -rfbport "$VNC_PORT" \
  -localhost \
  -shared \
  -forever \
  -nopw \
  -xkb \
  -noxdamage \
  -noxfixes \
  -repeat \
  -wait 10 \
  -defer 10 \
  2>&1 | sed 's/^/[x11vnc] /' &

wait_for_port 127.0.0.1 "$VNC_PORT" x11vnc || true

log novnc "http://0.0.0.0:${NOVNC_PORT}/vnc.html  (web root ${NOVNC_WEB})"
websockify --heartbeat 30 --web "$NOVNC_WEB" 0.0.0.0:"$NOVNC_PORT" 127.0.0.1:"$VNC_PORT" \
  2>&1 | sed 's/^/[novnc] /' &

# Visible Chromium on the XFCE desktop, CDP on :9222 for agent-browser.
sleep 2
log chromium "launching headed chrome with CDP :${CDP_PORT}"
/usr/local/bin/chromium --start-maximized "about:blank" \
  2>&1 | sed 's/^/[chromium] /' &

wait_for_port 127.0.0.1 "$CDP_PORT" chromium || true

# Attach agent-browser to the same Chromium (does not launch a second browser).
if command -v agent-browser >/dev/null 2>&1; then
  log agent-browser "connecting via CDP :${CDP_PORT}"
  agent-browser --cdp "$CDP_PORT" --session desktop snapshot >/tmp/agent-browser-snapshot.txt 2>&1 || \
    log agent-browser "initial snapshot skipped (browser still starting)"
  log agent-browser "ready — run: agent-browser --cdp ${CDP_PORT} --session desktop <cmd>"
else
  log agent-browser "binary not on PATH"
fi

if [ -f /opt/agent/src/server.coffee ] && command -v bun >/dev/null 2>&1; then
  log agent "angela owner on :${AGENT_PORT}"
  (
    cd /opt/agent
    export HOME="${HOME:-/home/agent}"
    export BUN_INSTALL="${BUN_INSTALL:-$HOME/.bun}"
    export NODE_PATH="/opt/agent/node_modules${NODE_PATH:+:$NODE_PATH}"
    export AGENT_PORT DISPLAY CDP_PORT
    export ANGELA_MCP_ROOT="${ANGELA_MCP_ROOT:-/opt/mcp}"
    export ANGELA_PROJECT_ROOT="${ANGELA_PROJECT_ROOT:-/workspace}"
    bun src/server.coffee
  ) 2>&1 | sed 's/^/[agent] /' &
else
  log agent "skipped (bun or /opt/agent missing)"
fi

log entrypoint "desktop ready  display=$DISPLAY  novnc=:${NOVNC_PORT}  cdp=:${CDP_PORT}  agent=:${AGENT_PORT}"

# Keep PID 1 alive as long as Xvfb is up.
while xdpyinfo -display "$DISPLAY" >/dev/null 2>&1; do
  sleep 2
done

log entrypoint "X server gone"
exit 1
