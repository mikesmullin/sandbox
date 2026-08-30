#!/bin/sh
# XFCE / exo WebBrowser helper. Always a new window on the running
# browser-use Chromium (CDP). Never spawn a second Chrome/Chromium.
url="${1:-about:blank}"
export DISPLAY="${DISPLAY:-:99}"
home="${HOME:-/home/agent}"
py="${BROWSER_USE_WINDOW_PY:-}"
if [ -z "$py" ] || [ ! -f "$py" ]; then
  for cand in \
      /usr/local/bin/browser-use-window.py \
      "$home/bin/browser-use-window.py"
  do
    if [ -f "$cand" ]; then
      py="$cand"
      break
    fi
  done
fi
if [ -z "$py" ] || [ ! -f "$py" ]; then
  echo "browser-use window helper missing" >&2
  exit 1
fi
if command -v python3 >/dev/null 2>&1; then
  exec python3 "$py" "$url"
fi
if [ -x /opt/browser-use/venv/bin/python ]; then
  exec /opt/browser-use/venv/bin/python "$py" "$url"
fi
echo "python3 not found; cannot talk to browser-use CDP" >&2
exit 1
