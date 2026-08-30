#!/bin/bash
# Start the virtual XFCE desktop: Xvfb → session → x11vnc → noVNC → headed browser-use + agent-browser.
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
export BROWSER="${BROWSER:-/usr/local/bin/browser-use-open}"
export AGENT_BROWSER_HEADED=1
export IN_DOCKER="${IN_DOCKER:-1}"
export BROWSER_USE_CHROME_NO_SANDBOX="${BROWSER_USE_CHROME_NO_SANDBOX:-1}"
export PLAYWRIGHT_BROWSERS_PATH="${PLAYWRIGHT_BROWSERS_PATH:-/opt/ms-playwright}"
unset AGENT_BROWSER_EXECUTABLE_PATH

# pyenv / rustup / go / node / zig / rbenv (see scripts/install-devtools.sh)
if [ -f /etc/profile.d/devtools.sh ]; then
  # shellcheck disable=SC1091
  . /etc/profile.d/devtools.sh
fi

log() { printf '[%s] %s\n' "$1" "$2"; }

# Host NVIDIA userspace is vendored at /opt/nvidia (see scripts/vendor-nvidia.sh).
# Devices come from the pod spec (Kind node already sees host /dev/nvidia*).
if [ -d /opt/nvidia/lib ]; then
  export LD_LIBRARY_PATH="/opt/nvidia/lib${LD_LIBRARY_PATH:+:$LD_LIBRARY_PATH}"
fi
if [ -f /opt/nvidia/share/vulkan/icd.d/nvidia_icd.json ]; then
  export VK_ICD_FILENAMES="/opt/nvidia/share/vulkan/icd.d/nvidia_icd.json${VK_ICD_FILENAMES:+:$VK_ICD_FILENAMES}"
fi
if [ -d /opt/nvidia/share/glvnd/egl_vendor.d ]; then
  export __EGL_VENDOR_LIBRARY_DIRS="/opt/nvidia/share/glvnd/egl_vendor.d${__EGL_VENDOR_LIBRARY_DIRS:+:$__EGL_VENDOR_LIBRARY_DIRS}"
fi
if [ -d /opt/nvidia/share/egl/egl_external_platform.d ]; then
  export __EGL_EXTERNAL_PLATFORM_CONFIG_DIRS="/opt/nvidia/share/egl/egl_external_platform.d${__EGL_EXTERNAL_PLATFORM_CONFIG_DIRS:+:$__EGL_EXTERNAL_PLATFORM_CONFIG_DIRS}"
fi
export NVIDIA_VISIBLE_DEVICES="${NVIDIA_VISIBLE_DEVICES:-all}"
export NVIDIA_DRIVER_CAPABILITIES="${NVIDIA_DRIVER_CAPABILITIES:-all}"

mkdir -p \
  "$XDG_RUNTIME_DIR" \
  "$XDG_CONFIG_HOME" \
  "$XDG_CACHE_HOME" \
  "$XDG_DATA_HOME" \
  "$HOME/.vnc" \
  "$HOME/.config/browser-use" \
  "$HOME/.config/browser-use-user-data-dir-live" \
  /workspace \
  /workspace/jails

# emptyDir hides the image /workspace. Point node_modules at the bun-linked
# vendor trees so `bun` from cwd does not fall through to npm's stale agl-ai.
# Per-XFCE-workspace file-io jails live under /workspace/jails/<id>/.
mkdir -p /workspace/node_modules /workspace/jails
ln -sfn /opt/vendor/agl /workspace/node_modules/agl-ai
ln -sfn /opt/vendor/angela /workspace/node_modules/angela
if [ ! -f /workspace/package.json ]; then
  printf '%s\n' '{"name":"desktop-workspace","private":true,"type":"module"}' > /workspace/package.json
fi

# Cluster GitLab. UI password lives on the host as tmp/gitlab_password.md.
# Credential helper embeds it so git clone/push/pull never prompt. Never print it.
# Git author is the container (pod hostname), not the XFCE workspace.
GITLAB_URL="${GITLAB_URL:-http://gitlab}"
export GITLAB_URL
export ANGELA_JAILS_ROOT="${ANGELA_JAILS_ROOT:-/workspace/jails}"
gitlab_pw="${GITLAB_ROOT_PASSWORD:-}"
if [ -z "$gitlab_pw" ] && [ -s /opt/gitlab/root-password ]; then
  gitlab_pw="$(tr -d '\r\n' < /opt/gitlab/root-password)"
fi
if command -v git >/dev/null 2>&1; then
  pod="${HOSTNAME:-$(hostname 2>/dev/null || true)}"
  pod="${pod%%.*}"
  if [ -z "$pod" ] || [ "$pod" = "localhost" ]; then
    pod="container"
  fi
  git config --global user.name "$pod"
  git config --global user.email "${pod}@home.local"
  git config --global init.defaultBranch main
  git config --global --add safe.directory /workspace
  git config --global --add safe.directory '*'
  if [ -n "$gitlab_pw" ]; then
    : > "$HOME/.git-credentials"
    for host in gitlab gitlab.agent-desktop.svc.cluster.local; do
      printf 'http://root:%s@%s\n' "$gitlab_pw" "$host" >> "$HOME/.git-credentials"
    done
    chmod 600 "$HOME/.git-credentials"
    git config --global credential.helper store
    log git "author ${pod}@home.local  credential helper for ${GITLAB_URL}"
  else
    log git "no GITLAB_ROOT_PASSWORD — git push to GitLab will prompt"
  fi
  if [ -s /opt/github-ssh/id_ed25519 ]; then
    mkdir -p "$HOME/.ssh"
    chmod 700 "$HOME/.ssh"
    if ! cp /opt/github-ssh/id_ed25519 "$HOME/.ssh/id_ed25519"; then
      log git "github ssh: could not copy private key (check secret mode)"
    else
      [ -s /opt/github-ssh/id_ed25519.pub ] && cp /opt/github-ssh/id_ed25519.pub "$HOME/.ssh/id_ed25519.pub"
      [ -s /opt/github-ssh/known_hosts ] && cp /opt/github-ssh/known_hosts "$HOME/.ssh/known_hosts"
      chmod 600 "$HOME/.ssh/id_ed25519"
      chmod 644 "$HOME/.ssh/id_ed25519.pub" "$HOME/.ssh/known_hosts" 2>/dev/null || true
      printf '%s\n' \
        'Host github.com' \
        '  HostName github.com' \
        '  User git' \
        '  IdentityFile ~/.ssh/id_ed25519' \
        '  IdentitiesOnly yes' \
        '  StrictHostKeyChecking yes' \
        > "$HOME/.ssh/config"
      chmod 600 "$HOME/.ssh/config"
      git config --global --unset-all url.git@github.com:.insteadof 2>/dev/null || true
      git config --global --add url.git@github.com:.insteadOf https://github.com/
      git config --global --add url.git@github.com:.insteadOf https://www.github.com/
      log git "github ssh identity installed (https://github.com → git@github.com)"
    fi
  fi
fi
unset gitlab_pw
unset GITLAB_ROOT_PASSWORD

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

if [ -e /dev/nvidia0 ]; then
  log gpu "host NVIDIA device /dev/nvidia0"
else
  log gpu "no /dev/nvidia0 — Chromium WebGL will be software"
fi
if [ -d /opt/nvidia/lib ] && ls /opt/nvidia/lib/libnvidia-glcore.so* >/dev/null 2>&1; then
  log gpu "NVIDIA userspace /opt/nvidia/lib"
fi

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

# Session D-Bus for XFCE / Thunar / the headed browser.
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
# XFIXES watches CLIPBOARD so guest copy reaches VNC ServerCutText.
# -noprimary: selecting text must not clobber the host clipboard.
x11vnc \
  -display "$DISPLAY" \
  -rfbport "$VNC_PORT" \
  -localhost \
  -shared \
  -forever \
  -nopw \
  -xkb \
  -noxdamage \
  -noprimary \
  -repeat \
  -wait 10 \
  -defer 10 \
  2>&1 | sed 's/^/[x11vnc] /' &

wait_for_port 127.0.0.1 "$VNC_PORT" x11vnc || true

log novnc "http://0.0.0.0:${NOVNC_PORT}/vnc.html  (web root ${NOVNC_WEB})"
websockify --heartbeat 30 --web "$NOVNC_WEB" 0.0.0.0:"$NOVNC_PORT" 127.0.0.1:"$VNC_PORT" \
  2>&1 | sed 's/^/[novnc] /' &

# Optional control-room snapshot of the headed Chromium profile (cookies/logins).
# Path must include browser-use-user-data-dir- so browser-use will not copy it
# to a random /tmp dir. Dashboard extracts the tarball then touches ready.
BROWSER_USE_USER_DATA_DIR="${BROWSER_USE_USER_DATA_DIR:-$HOME/.config/browser-use-user-data-dir-live}"
export BROWSER_USE_USER_DATA_DIR
mkdir -p "$BROWSER_USE_USER_DATA_DIR"
if [ "${BROWSER_SNAPSHOT:-}" = "1" ]; then
  log snapshot "waiting for profile in $BROWSER_USE_USER_DATA_DIR"
  snap_ok=0
  for i in $(seq 1 180); do
    if [ -f /tmp/browser-snapshot.ready ]; then
      snap_ok=1
      break
    fi
    sleep 0.5
  done
  rm -f \
    "$BROWSER_USE_USER_DATA_DIR/SingletonLock" \
    "$BROWSER_USE_USER_DATA_DIR/SingletonSocket" \
    "$BROWSER_USE_USER_DATA_DIR/SingletonCookie"
  if [ "$snap_ok" = 1 ]; then
    log snapshot "restored $BROWSER_USE_USER_DATA_DIR"
  else
    log snapshot "timed out — booting empty profile"
  fi
fi

# Headed browser-use Chromium on XFCE. Writes CDP URL to /tmp/browser-use.cdp.
sleep 2
log browser-use "launching headed stealth chromium"
BROWSER_USE_PY="${BROWSER_USE_PY:-/opt/browser-use/venv/bin/python}"
if [ -x "$BROWSER_USE_PY" ] && [ -f /usr/local/bin/browser-use-headed.py ]; then
  "$BROWSER_USE_PY" /usr/local/bin/browser-use-headed.py \
    2>&1 | sed 's/^/[browser-use] /' &
else
  log browser-use "launcher missing ($BROWSER_USE_PY)"
fi

cdp_ready=0
for i in $(seq 1 80); do
  if [ -s /tmp/browser-use.cdp.port ]; then
    CDP_PORT="$(tr -d '[:space:]' < /tmp/browser-use.cdp.port)"
    export CDP_PORT
  fi
  if [ -s /tmp/browser-use.cdp ] && python3 - "$CDP_PORT" <<'PY' >/dev/null 2>&1
import socket, sys
s = socket.socket()
s.settimeout(0.2)
try:
    s.connect(("127.0.0.1", int(sys.argv[1])))
except Exception:
    sys.exit(1)
finally:
    s.close()
PY
  then
    cdp_ready=1
    break
  fi
  sleep 0.25
done
if [ "$cdp_ready" != 1 ]; then
  log browser-use "CDP not ready on :${CDP_PORT}"
fi

# Publish the well-known :9222 if browser-use picked another port.
if [ -n "${CDP_PORT}" ] && [ "${CDP_PORT}" != "9222" ] && command -v socat >/dev/null 2>&1; then
  socat TCP-LISTEN:9222,bind=127.0.0.1,fork,reuseaddr TCP:127.0.0.1:"${CDP_PORT}" \
    2>&1 | sed 's/^/[cdp-proxy] /' &
fi

CDP_TARGET="${CDP_PORT}"
if [ -s /tmp/browser-use.cdp ]; then
  CDP_TARGET="$(tr -d '[:space:]' < /tmp/browser-use.cdp)"
fi
export AGENT_BROWSER_CDP="$CDP_TARGET"

# Do not attach a shared agent-browser --session here. Each XFCE workspace
# pins its own session to its Chromium window from the Angela owner.
if command -v agent-browser >/dev/null 2>&1; then
  log agent-browser "CDP ${CDP_TARGET} — per-workspace sessions attach from agent"
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
    export AGENT_PORT DISPLAY CDP_PORT AGENT_BROWSER_CDP
    export ANGELA_MCP_ROOT="${ANGELA_MCP_ROOT:-/opt/mcp}"
    export ANGELA_PROJECT_ROOT="${ANGELA_PROJECT_ROOT:-/workspace}"
    export ANGELA_JAILS_ROOT="${ANGELA_JAILS_ROOT:-/workspace/jails}"
    unset GITLAB_ROOT_PASSWORD
    while true; do
      bun src/server.coffee
      echo "angela exited $? — restart in 2s"
      sleep 2
    done
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
