#!/bin/bash
# sandbox2 desktop entrypoint (runs as root; drops to `desktop` via su-exec).
#
# Startup order (mirrors the cua reference image):
#   1. materialize the spacesd token at /run/cua/env-token (root:desktop 0640)
#   2. system D-Bus
#   3. Xvfb :1 (no network listener; XTEST input, MIT-SHM/DAMAGE capture, RANDR)
#   4. session D-Bus on a FIXED address so spacesd and exec helpers share the
#      AT-SPI registry the apps register with
#   5. session: openbox (+ autostart → terminator), feh wallpaper, AT-SPI enable
#   6. cua-spacesd on 0.0.0.0:3211 (token via env, never argv)
set -u

export HOME=/home/desktop
export XDG_RUNTIME_DIR=/tmp/runtime-desktop
export XCURSOR_THEME=Bibata-Modern-Classic
export XCURSOR_SIZE=24
DESKTOP_USER=desktop
DISPLAY_NUM=:1
RESOLUTION="${CUA_RESOLUTION:-1280x800}"
MCP_PORT="${CUA_ENV_PORT:-3211}"

log() { echo "[$(date -Iseconds)] start-desktop: $*"; }

mkdir -p "$XDG_RUNTIME_DIR" /tmp/.X11-unix /run/cua /var/lib/cua/spacesd
# X sockets are created by the (unprivileged) Xvfb process.
chmod 1777 /tmp/.X11-unix
chown desktop:desktop "$XDG_RUNTIME_DIR" /var/lib/cua/spacesd
chmod 700 "$XDG_RUNTIME_DIR"

# ── 1. spacesd token ─────────────────────────────────────────────────────────
# First match wins: CUA_ENV_TOKEN (injected at `container create -e`), then an
# exec-pushed /run/cua/env-token (waited for briefly), then generate one and
# log it so the host can read it back via `container exec ... cat`.
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
  log "token: generated at /run/cua/env-token (read back with: container exec <id> cat /run/cua/env-token)"
else
  log "token: found at /run/cua/env-token"
fi
chown root:"$DESKTOP_USER" /run/cua/env-token
chmod 0640 /run/cua/env-token

# ── 2. system D-Bus ──────────────────────────────────────────────────────────
mkdir -p /run/dbus
rm -f /run/dbus/pid
dbus-daemon --system --nofork --syslog &
log "system dbus up"

# ── 3. Xvfb ──────────────────────────────────────────────────────────────────
rm -f "/tmp/.X${DISPLAY_NUM#:}-lock" "/tmp/.X11-unix/X${DISPLAY_NUM#:}"
su-exec "$DESKTOP_USER" env HOME="$HOME" XDG_RUNTIME_DIR="$XDG_RUNTIME_DIR" \
  Xvfb "$DISPLAY_NUM" -screen 0 "${RESOLUTION}x24" -dpi 96 \
  -nolisten tcp +extension RANDR +extension GLX -noreset &
log "Xvfb $DISPLAY_NUM ${RESOLUTION}"
for _ in $(seq 1 100); do
  [ -S "/tmp/.X11-unix/X${DISPLAY_NUM#:}" ] && break
  sleep 0.1
done
[ -S "/tmp/.X11-unix/X${DISPLAY_NUM#:}" ] || { log "Xvfb did not create its socket"; exit 1; }

# ── 4. session D-Bus (fixed address) + session env ──────────────────────────
rm -f "$XDG_RUNTIME_DIR/bus"
su-exec "$DESKTOP_USER" env XDG_RUNTIME_DIR="$XDG_RUNTIME_DIR" \
  dbus-daemon --session --address="unix:path=$XDG_RUNTIME_DIR/bus" --nofork --nopidfile &
for _ in $(seq 1 50); do
  [ -S "$XDG_RUNTIME_DIR/bus" ] && break
  sleep 0.1
done
[ -S "$XDG_RUNTIME_DIR/bus" ] || { log "session dbus did not start"; exit 1; }

# Accessibility on for every toolkit so AT-SPI sees the whole tree.
export DISPLAY="$DISPLAY_NUM"
export DBUS_SESSION_BUS_ADDRESS="unix:path=$XDG_RUNTIME_DIR/bus"
export GTK_MODULES="${GTK_MODULES:+$GTK_MODULES:}atk-bridge"
export GNOME_ACCESSIBILITY=1
export QT_ACCESSIBILITY=1
export QT_LINUX_ACCESSIBILITY_ALWAYS_ON=1
export MOZ_ENABLE_ACCESSIBILITY=1
export ACCESSIBILITY_ENABLED=1
unset NO_AT_BRIDGE SESSION_MANAGER

cat >"$XDG_RUNTIME_DIR/desktop.env" <<EOF
DISPLAY=$DISPLAY
DBUS_SESSION_BUS_ADDRESS=$DBUS_SESSION_BUS_ADDRESS
XDG_RUNTIME_DIR=$XDG_RUNTIME_DIR
GTK_MODULES=$GTK_MODULES
GNOME_ACCESSIBILITY=1
EOF
chown desktop:desktop "$XDG_RUNTIME_DIR/desktop.env"

# ── 4b. execd — guest exec MCP server (ONE bash tool; 0.0.0.0:3213) ──────────
# Pre-provision the workspace the orchestration pipeline clones into: clones
# run as the `desktop` user → /home/desktop/repos must exist desktop-owned
# BEFORE the first clone. Git identity pre-provisioned so agents never juggle
# -c user.name/email flags (contract: web/docs/execd-contract.md).
mkdir -p /home/desktop/repos
chown "$DESKTOP_USER:$DESKTOP_USER" /home/desktop/repos

# Hostname == container id in the sandbox; first 8 chars is the host disambiguator.
GIT_ID_PREFIX="$(hostname | cut -c1-8)"
cat >/home/desktop/.gitconfig <<EOF
[init]
	defaultBranch = main
[user]
	name = psicom-${GIT_ID_PREFIX}
	email = psicom@localhost
EOF
chown "$DESKTOP_USER:$DESKTOP_USER" /home/desktop/.gitconfig

# execd: started as the desktop user AFTER desktop.env exists, sourcing it so
# children inherit the session env (DISPLAY, DBUS_SESSION_BUS_ADDRESS,
# XDG_RUNTIME_DIR) naturally, plus the data-plane token (same materialization
# the spacesd launch uses — CUA_ENV_TOKEN is unset above, /run/cua/env-token is
# the source of truth). Log to the runtime dir (desktop-owned).
su-exec "$DESKTOP_USER" bash -c 'set -a; . /tmp/runtime-desktop/desktop.env; set +a; export EXECD_DEFAULT_CWD=/home/desktop; export CUA_ENV_TOKEN="$(cat /run/cua/env-token)"; exec bun /opt/execd/index.mjs >>/tmp/runtime-desktop/execd.log 2>&1' &
log "execd starting on 0.0.0.0:3213"

# ── 5. session: openbox (+ autostart), wallpaper, AT-SPI enable ───────────
su-exec "$DESKTOP_USER" env HOME="$HOME" XDG_RUNTIME_DIR="$XDG_RUNTIME_DIR" \
  DISPLAY="$DISPLAY" DBUS_SESSION_BUS_ADDRESS="$DBUS_SESSION_BUS_ADDRESS" \
  GTK_MODULES="$GTK_MODULES" GNOME_ACCESSIBILITY=1 QT_ACCESSIBILITY=1 \
  openbox &
sleep 1
log "openbox up"

# (terminator REMOVED from boot 2026-10-14 — Mike: boot state is the browser
# window only. The openbox menu keeps a Terminal item as the human escape
# hatch in the viewer; the agent uses execd, not terminal windows.)

# ── 5a-1. guest-loopback static server (local content over HTTP) ──────────
# browser_navigate refuses file:// — local content rides http://127.0.0.1:8080
# (serve.mjs serves /home/desktop). Started before chromium so the prewarm's
# start page is HTTP from the first paint.
su-exec "$DESKTOP_USER" env HOME="$HOME" \
  nohup bun /home/desktop/serve.mjs >/tmp/runtime-desktop/serve.log 2>&1 &
log "guest http server starting on 127.0.0.1:8080"

# ── 5a-2. chromium prewarm (OPT-IN — CUA_PREWARM_BROWSER=1) ───────────────
# DEFAULT OFF (Mike, 2026-10-14): the desktop boots to the background — the
# browser exists only when an agent asks for one (browser_prepare
# {allow_launch:true} launches a driver-owned isolated Chromium on demand; see
# the browser recipe in the analysis doc). Opt back in for GUI-heavy jobs by
# creating the sandbox with CUA_PREWARM_BROWSER=1 in its environment.
# Flags: the no-first-run set + the two the cua-driver needs on Linux:
#   --remote-debugging-port=0      → DevToolsActivePort (endpoint discovery
#                                    without a consent GUI flow).
#   --force-renderer-accessibility → existing-profile attach needs the browser's
#                                    COMPLETE AT-SPI tree on Linux.
if [ "${CUA_PREWARM_BROWSER:-0}" = "1" ]; then
  su-exec "$DESKTOP_USER" env HOME="$HOME" DISPLAY="$DISPLAY" \
    XDG_RUNTIME_DIR="$XDG_RUNTIME_DIR" DBUS_SESSION_BUS_ADDRESS="$DBUS_SESSION_BUS_ADDRESS" \
    chromium --no-sandbox --disable-gpu --no-first-run --no-default-browser-check \
      --disable-search-engine-choice-screen --disable-session-crashed-bubble \
      --force-renderer-accessibility --remote-debugging-port=0 \
      --start-maximized "about:blank" &
  log "chromium prewarmed on about:blank (CUA_PREWARM_BROWSER=1)"
else
  log "browser not prewarmed (default) — agents start one via browser_prepare(allow_launch)"
fi

su-exec "$DESKTOP_USER" env DISPLAY="$DISPLAY" \
  feh --no-xinerama --no-fehbg --bg-fill /home/desktop/Pictures/wallpaper.png &
log "wallpaper set"

# ── 5b. headless PipeWire (desktop audio; spacesd opens pa_simple here) ────
su-exec "$DESKTOP_USER" env HOME="$HOME" XDG_RUNTIME_DIR="$XDG_RUNTIME_DIR" \
  /usr/local/bin/start-audio &
for _ in $(seq 1 50); do
  [ -S "$XDG_RUNTIME_DIR/pipewire-0" ] && break
  sleep 0.1
done
[ -S "$XDG_RUNTIME_DIR/pipewire-0" ] && log "pipewire up" || log "pipewire socket missing (audio degraded)"

# Flip the AT-SPI "enabled" switch once the a11y bus is up. Best-effort.
(
  for _ in $(seq 1 60); do
    if dbus-send --session --print-reply --dest=org.a11y.Bus /org/a11y/bus \
        org.freedesktop.DBus.Properties.Set string:org.a11y.Status \
        string:IsEnabled variant:boolean:true >/dev/null 2>&1; then
      log "AT-SPI bus enabled"
      break
    fi
    sleep 1
  done
) &

# ── 6. cua-spacesd ───────────────────────────────────────────────────────────────────────────────────────────
# Driver browser config (verified against spacesd 0.5.3):
#   CUA_DRIVER_BROWSER_PROFILE_ROOT → desktop-writable root for driver-owned
#     isolated profiles (the default root is not writable by the desktop user:
#     "could not create the driver-owned profile root: Permission denied").
#   CUA_DRIVER_BROWSER_NO_SANDBOX   → the driver's launches include --no-sandbox
#     (chromium cannot sandbox under Apple Containers).
mkdir -p /home/desktop/.local/share/cua-driver-profiles
chown "$DESKTOP_USER:$DESKTOP_USER" /home/desktop/.local/share/cua-driver-profiles
su-exec "$DESKTOP_USER" env \
  HOME="$HOME" \
  XDG_RUNTIME_DIR="$XDG_RUNTIME_DIR" \
  DISPLAY="$DISPLAY" \
  DBUS_SESSION_BUS_ADDRESS="$DBUS_SESSION_BUS_ADDRESS" \
  CUA_ENV_TOKEN="$(cat /run/cua/env-token)" \
  CUA_ENV_PORT="$MCP_PORT" \
  CUA_ENV_DATA_DIR=/var/lib/cua/spacesd \
  CUA_ENV_LOG="${CUA_ENV_LOG:-info}" \
  CUA_DRIVER_BROWSER_PROFILE_ROOT=/home/desktop/.local/share/cua-driver-profiles \
  CUA_DRIVER_BROWSER_NO_SANDBOX=1 \
  CUA_DRIVER_PERMISSION_MODE=unrestricted \
  CUA_DRIVER_DANGEROUSLY_BYPASS_APPROVALS=1 \
  /usr/local/bin/cua-spacesd serve &
log "cua-spacesd starting on 0.0.0.0:$MCP_PORT (permission mode unrestricted — the deferred-warmup browser binds without a consent flow; the sandbox is the jail, the Jobfile is the policy)"

# Keep alive
wait
