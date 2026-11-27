#!/usr/bin/env bash
set -euo pipefail
DESKTOP_USER="${CUA_DESKTOP_USER:-cua}"
install -d -m 0700 -o "$DESKTOP_USER" -g "$DESKTOP_USER" /run/cua-desktop
install -d -m 1777 /tmp/.X11-unix /tmp/.ICE-unix
install -d -m 0755 /var/log/supervisor
if id messagebus >/dev/null 2>&1; then
    install -d -m 0755 -o messagebus -g messagebus /run/dbus
else
    install -d -m 0755 /run/dbus
fi
install -d -m 0755 /run/systemd/seats /run/systemd/sessions /run/systemd/users
rm -f /run/dbus/pid

if [ -n "${SSH_AUTHORIZED_KEYS:-}" ]; then
    install -d -m 0700 -o "$DESKTOP_USER" -g "$DESKTOP_USER" "/home/$DESKTOP_USER/.ssh"
    printf '%s\n' "$SSH_AUTHORIZED_KEYS" >"/home/$DESKTOP_USER/.ssh/authorized_keys"
    chown "$DESKTOP_USER:$DESKTOP_USER" "/home/$DESKTOP_USER/.ssh/authorized_keys"
    chmod 600 "/home/$DESKTOP_USER/.ssh/authorized_keys"
fi

for hook in /opt/cua/entrypoint.d/*.sh; do
    [ -e "$hook" ] || continue
    # shellcheck disable=SC1090
    . "$hook"
done

exec /usr/bin/supervisord -n -c /etc/supervisor/supervisord.conf
