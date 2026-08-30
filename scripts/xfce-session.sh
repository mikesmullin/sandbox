#!/bin/bash
# Lightweight XFCE session without a display manager.
set -u
export DISPLAY="${DISPLAY:-:99}"
export XDG_CURRENT_DESKTOP=XFCE
export XFCE_PANEL_MIGRATE_DEFAULT=true
export BROWSER="${BROWSER:-/usr/local/bin/browser-use-open}"
if [ -f /etc/profile.d/devtools.sh ]; then
  # shellcheck disable=SC1091
  . /etc/profile.d/devtools.sh
fi

# xfconfd must be up before panel / desktop read settings.
if command -v xfconfd >/dev/null 2>&1; then
  xfconfd --daemon >/dev/null 2>&1 || true
fi

# Prefer a full session; fall back to the individual pieces if it exits quickly.
startxfce4 &
SESSION_PID=$!

sleep 3
if kill -0 "$SESSION_PID" 2>/dev/null; then
  wait "$SESSION_PID"
  exit $?
fi

echo "startxfce4 exited early; starting components by hand"

xfwm4 --compositor=off &
sleep 0.4
xfce4-panel &
xfdesktop &
thunar --daemon &
wait
