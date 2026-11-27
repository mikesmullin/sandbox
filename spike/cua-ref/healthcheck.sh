#!/usr/bin/env bash
set -euo pipefail
DISPLAY="${CUA_DISPLAY:-:1}" xdpyinfo >/dev/null 2>&1
if [ "${CUA_X_SERVER:-xvnc}" = xvnc ]; then
    ss -Hltn "sport = :${CUA_VNC_PORT:-5901}" | grep -q .
fi
for check in /opt/cua/healthcheck.d/*.sh; do
    [ -e "$check" ] || continue
    bash "$check"
done
