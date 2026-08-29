#!/bin/sh
# XFCE / exo WebBrowser helper. Prefer a new tab on the running browser-use
# instance; fall back to launching Playwright Chromium with the same profile.
url="${1:-about:blank}"
if [ -f /tmp/browser-use.cdp ]; then
  cdp=$(tr -d '[:space:]' < /tmp/browser-use.cdp)
  hostport=$(printf '%s' "$cdp" | sed -e 's#^[a-z]*://##' -e 's#/.*##')
  enc=$(python3 -c 'import urllib.parse,sys; print(urllib.parse.quote(sys.argv[1], safe=""))' "$url")
  if curl -fsS "http://${hostport}/json/new?${enc}" >/dev/null 2>&1; then
    exit 0
  fi
fi
exec /opt/browser-use/chrome \
  --no-sandbox \
  --disable-gpu \
  --disable-dev-shm-usage \
  --user-data-dir="${HOME}/.config/browser-use" \
  "$@"
