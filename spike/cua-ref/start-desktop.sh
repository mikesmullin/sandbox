#!/usr/bin/env bash
set -euo pipefail

DISPLAY_NUM="${CUA_DISPLAY:-:1}"
N="${DISPLAY_NUM#:}"
GEOMETRY="${CUA_RESOLUTION:-1280x800}"
VNC_PORT="${CUA_VNC_PORT:-5901}"
VNC_LOCALHOST="${CUA_VNC_LOCALHOST:-0}"
X_SERVER="${CUA_X_SERVER:-xvnc}"

log() { echo "[$(date -Iseconds)] start-desktop: $*"; }

export HOME="${HOME:-/home/$(id -un)}"
export XDG_RUNTIME_DIR="${XDG_RUNTIME_DIR:-/run/cua-desktop}"
if [ ! -d "$XDG_RUNTIME_DIR" ]; then
    log "XDG_RUNTIME_DIR $XDG_RUNTIME_DIR missing; the entrypoint/tmpfiles should create it"
    exit 1
fi

rm -f "/tmp/.X${N}-lock" "/tmp/.X11-unix/X${N}"

SECURITY_ARGS=(-SecurityTypes None)
if [ "$X_SERVER" = xvnc ] && [ -n "${VNC_PASSWORD:-}" ]; then
    mkdir -p "$HOME/.vnc"
    printf '%s\n' "$VNC_PASSWORD" | vncpasswd -f >"$HOME/.vnc/passwd"
    chmod 600 "$HOME/.vnc/passwd"
    SECURITY_ARGS=(-SecurityTypes VncAuth -PasswordFile "$HOME/.vnc/passwd")
fi
unset VNC_PASSWORD

PIDS=()
cleanup() {
    for p in "${PIDS[@]}"; do kill "$p" 2>/dev/null || true; done
    wait 2>/dev/null || true
}
trap cleanup EXIT TERM INT

case "$X_SERVER" in
xvfb)
    log "Xvfb ${DISPLAY_NUM} ${GEOMETRY}"
    Xvfb "${DISPLAY_NUM}" -screen 0 "${GEOMETRY}x24" -dpi 96 \
        -nolisten tcp +extension RANDR +extension GLX -noreset &
    ;;
xvnc)
    log "Xvnc ${DISPLAY_NUM} ${GEOMETRY} rfbport=${VNC_PORT} localhost=${VNC_LOCALHOST}"
    Xvnc "${DISPLAY_NUM}" \
        -geometry "$GEOMETRY" -depth 24 \
        -rfbport "$VNC_PORT" -localhost="$VNC_LOCALHOST" \
        "${SECURITY_ARGS[@]}" \
        -AlwaysShared -AcceptSetDesktopSize=1 \
        -nolisten tcp -desktop "cua" &
    ;;
*)
    log "unknown CUA_X_SERVER=$X_SERVER (xvfb or xvnc)"
    exit 1
    ;;
esac
PIDS+=($!)

for _ in $(seq 1 100); do
    [ -S "/tmp/.X11-unix/X${N}" ] && break
    sleep 0.1
done
[ -S "/tmp/.X11-unix/X${N}" ] || { log "$X_SERVER did not create its socket"; exit 1; }
export DISPLAY="$DISPLAY_NUM"

BUS="$XDG_RUNTIME_DIR/bus"
rm -f "$BUS"
dbus-daemon --session --address="unix:path=$BUS" --nofork --nopidfile --syslog-only &
PIDS+=($!)
for _ in $(seq 1 50); do
    [ -S "$BUS" ] && break
    sleep 0.1
done
export DBUS_SESSION_BUS_ADDRESS="unix:path=$BUS"

export GTK_MODULES="${GTK_MODULES:+$GTK_MODULES:}gail:atk-bridge"
export GNOME_ACCESSIBILITY=1 QT_ACCESSIBILITY=1 QT_LINUX_ACCESSIBILITY_ALWAYS_ON=1
export MOZ_ENABLE_ACCESSIBILITY=1 ACCESSIBILITY_ENABLED=1
unset NO_AT_BRIDGE SESSION_MANAGER

# shellcheck source=browser-sandbox.sh
. "$(dirname "$0")/browser-sandbox.sh"
SANDBOX_ENV="$(browser_sandbox_env)"
while IFS= read -r line; do
    case "$line" in MOZ_DISABLE_*) export "${line?}" ;; esac
done <<<"$SANDBOX_ENV"
if [ -n "$SANDBOX_ENV" ]; then
    log "browser sandbox settings: $(echo "$SANDBOX_ENV" | tr '\n' ' ')"
    SANDBOX_ENV="$SANDBOX_ENV
"
fi

cat >"$XDG_RUNTIME_DIR/desktop.env" <<EOF
DISPLAY=$DISPLAY
DBUS_SESSION_BUS_ADDRESS=$DBUS_SESSION_BUS_ADDRESS
XDG_RUNTIME_DIR=$XDG_RUNTIME_DIR
GTK_MODULES=$GTK_MODULES
GNOME_ACCESSIBILITY=1
EOF
printf '%s' "$SANDBOX_ENV" >>"$XDG_RUNTIME_DIR/desktop.env"

log "starting XFCE session"
startxfce4 >"$XDG_RUNTIME_DIR/xfce-session.log" 2>&1 &
PIDS+=($!)

(
    for _ in $(seq 1 60); do
        if busctl --user --no-pager status org.a11y.Bus >/dev/null 2>&1 \
            || dbus-send --session --print-reply --dest=org.a11y.Bus /org/a11y/bus org.a11y.Bus.GetAddress >/dev/null 2>&1; then
            dbus-send --session --type=method_call --dest=org.a11y.Bus /org/a11y/bus \
                org.freedesktop.DBus.Properties.Set string:org.a11y.Status string:IsEnabled variant:boolean:true \
                >/dev/null 2>&1 || true
            log "AT-SPI bus enabled"
            break
        fi
        sleep 1
    done
) &

log "desktop up on ${DISPLAY}"
wait -n "${PIDS[@]}"
rc=$?
log "a desktop process exited (rc=$rc); tearing down"
exit 1
