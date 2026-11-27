#!/bin/sh

REAL=/usr/lib/chromium/chromium.real

seen_cdp=0; seen_a11y=0; seen_nosandbox=0; seen_nofirstrun=0; seen_nodbcheck=0
seen_nosearch=0; seen_nocrashbubble=0; seen_maximized=0; seen_udd=0
for a in "$@"; do
  case "$a" in
    --remote-debugging-port*) seen_cdp=1 ;;
    --force-renderer-accessibility) seen_a11y=1 ;;
    --no-sandbox) seen_nosandbox=1 ;;
    --no-first-run) seen_nofirstrun=1 ;;
    --no-default-browser-check) seen_nodbcheck=1 ;;
    --disable-search-engine-choice-screen) seen_nosearch=1 ;;
    --disable-session-crashed-bubble) seen_nocrashbubble=1 ;;
    --start-maximized) seen_maximized=1 ;;
    --user-data-dir*) seen_udd=1 ;;
  esac
done

set -- --disable-gpu --enable-unsafe-swiftshader --disable-dev-shm-usage "$@"

if [ "$seen_udd" = "0" ]; then
  PROFILE_DIR="${HOME:-/home/desktop}/.config/chromium"
  if [ -L "$PROFILE_DIR/SingletonLock" ]; then
    target=$(readlink "$PROFILE_DIR/SingletonLock" 2>/dev/null) || target=''
    pid=${target##*-}
    case "$pid" in
      ''|*[!0-9]*) pid='' ;;
    esac
    if [ -n "$pid" ] && ! kill -0 "$pid" 2>/dev/null; then
      rm -f "$PROFILE_DIR/SingletonLock" "$PROFILE_DIR/SingletonCookie" \
            "$PROFILE_DIR/SingletonSocket" "$PROFILE_DIR/DevToolsActivePort" \
            2>/dev/null
    fi
  elif [ ! -e "$PROFILE_DIR/SingletonLock" ] && [ -f "$PROFILE_DIR/DevToolsActivePort" ]; then
    rm -f "$PROFILE_DIR/DevToolsActivePort" 2>/dev/null
  fi

  [ "$seen_nosandbox" = "0" ]       && set -- --no-sandbox "$@"
  [ "$seen_nofirstrun" = "0" ]      && set -- --no-first-run "$@"
  [ "$seen_nodbcheck" = "0" ]       && set -- --no-default-browser-check "$@"
  [ "$seen_nosearch" = "0" ]        && set -- --disable-search-engine-choice-screen "$@"
  [ "$seen_nocrashbubble" = "0" ]   && set -- --disable-session-crashed-bubble "$@"
  [ "$seen_a11y" = "0" ]            && set -- --force-renderer-accessibility "$@"
  [ "$seen_cdp" = "0" ]             && set -- --remote-debugging-port=0 "$@"
  [ "$seen_maximized" = "0" ]       && set -- --start-maximized "$@"
fi

exec "$REAL" "$@"
