#!/bin/bash
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
chmod 1777 /tmp/.X11-unix
chown desktop:desktop "$XDG_RUNTIME_DIR" /var/lib/cua/spacesd
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
  log "token: generated at /run/cua/env-token (read back with: container exec <id> cat /run/cua/env-token)"
else
  log "token: found at /run/cua/env-token"
fi
chown root:"$DESKTOP_USER" /run/cua/env-token
chmod 0640 /run/cua/env-token

mkdir -p /run/dbus
rm -f /run/dbus/pid
dbus-daemon --system --nofork --syslog &
log "system dbus up"

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

rm -f "$XDG_RUNTIME_DIR/bus"
su-exec "$DESKTOP_USER" env XDG_RUNTIME_DIR="$XDG_RUNTIME_DIR" \
  dbus-daemon --session --address="unix:path=$XDG_RUNTIME_DIR/bus" --nofork --nopidfile &
for _ in $(seq 1 50); do
  [ -S "$XDG_RUNTIME_DIR/bus" ] && break
  sleep 0.1
done
[ -S "$XDG_RUNTIME_DIR/bus" ] || { log "session dbus did not start"; exit 1; }

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

mkdir -p /home/desktop/repos
chown "$DESKTOP_USER:$DESKTOP_USER" /home/desktop/repos

GIT_ID_PREFIX="$(hostname | cut -c1-8)"
cat >/home/desktop/.gitconfig <<EOF
[init]
	defaultBranch = main
[user]
	name = psicom-${GIT_ID_PREFIX}
	email = psicom@localhost
EOF
chown "$DESKTOP_USER:$DESKTOP_USER" /home/desktop/.gitconfig

su-exec "$DESKTOP_USER" bash -c 'set -a; . /tmp/runtime-desktop/desktop.env; set +a; export EXECD_DEFAULT_CWD=/home/desktop; export CUA_ENV_TOKEN="$(cat /run/cua/env-token)"; export CUA_BROWSER_TOOLS=1; exec bun /opt/execd/index.mjs >>/tmp/runtime-desktop/execd.log 2>&1' &
log "execd starting on 0.0.0.0:3213"

su-exec "$DESKTOP_USER" env HOME="$HOME" XDG_RUNTIME_DIR="$XDG_RUNTIME_DIR" \
  DISPLAY="$DISPLAY" DBUS_SESSION_BUS_ADDRESS="$DBUS_SESSION_BUS_ADDRESS" \
  GTK_MODULES="$GTK_MODULES" GNOME_ACCESSIBILITY=1 QT_ACCESSIBILITY=1 \
  openbox &
sleep 1
log "openbox up"


su-exec "$DESKTOP_USER" env HOME="$HOME" \
  nohup bun /home/desktop/serve.mjs >/tmp/runtime-desktop/serve.log 2>&1 &
log "guest http server starting on 127.0.0.1:8080"

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

su-exec "$DESKTOP_USER" env HOME="$HOME" XDG_RUNTIME_DIR="$XDG_RUNTIME_DIR" \
  /usr/local/bin/start-audio &
for _ in $(seq 1 50); do
  [ -S "$XDG_RUNTIME_DIR/pipewire-0" ] && break
  sleep 0.1
done
[ -S "$XDG_RUNTIME_DIR/pipewire-0" ] && log "pipewire up" || log "pipewire socket missing (audio degraded)"

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
  CUA_DRIVER_ENABLE_LEGACY_PAGE_MUTATIONS=1 \
  /usr/local/bin/cua-spacesd serve &
log "cua-spacesd starting on 0.0.0.0:$MCP_PORT (permission mode unrestricted — the deferred-warmup browser binds without a consent flow; the sandbox is the jail, the Jobfile is the policy)"

wait
