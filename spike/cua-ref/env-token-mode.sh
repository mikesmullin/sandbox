#!/usr/bin/env bash

for _cua_prefix in CUA_GUESTD_ CUA_SPACESD_; do
    for _cua_var in $(compgen -e); do
        case "$_cua_var" in
            "$_cua_prefix"?*) export "CUA_ENV_${_cua_var#"$_cua_prefix"}=${!_cua_var}" ;;
        esac
    done
done
unset _cua_var _cua_prefix

CUA_CLAIM_SECRETS_DIR="${CUA_CLAIM_SECRETS_DIR:-/run/cua}"
CUA_CLAIM_TOKEN_FILE="$CUA_CLAIM_SECRETS_DIR/env-token"
CUA_SYNCED_TOKEN_DIR="${CUA_SYNCED_TOKEN_DIR:-/run/cua-env}"
CUA_SYNCED_TOKEN_FILE="$CUA_SYNCED_TOKEN_DIR/env-token"

cua_is_mountpoint() {
    awk -v p="$1" '$5 == p { found = 1 } END { exit !found }' /proc/self/mountinfo 2>/dev/null
}

cua_wait_claim_mount() {
    cua_is_mountpoint "$CUA_CLAIM_SECRETS_DIR" && return 0
    grep -qs '^0x001a$' /sys/bus/virtio/devices/*/device || return 0
    command -v systemctl >/dev/null 2>&1 || return 0
    systemctl start run-cua.mount >/dev/null 2>&1 || true
}

cua_await_token_file() {
    case "${CUA_ENV_AWAIT_TOKEN_FILE:-}" in
        1|true|yes|on) return 0 ;;
        0|false|no|off) return 1 ;;
    esac
    [ -n "${CUA_ENV_TOKEN:-}" ] && return 1
    [ -s /etc/cua/env-token ] && return 1
    cua_wait_claim_mount
    cua_is_mountpoint "$CUA_CLAIM_SECRETS_DIR"
}
