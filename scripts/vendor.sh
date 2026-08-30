#!/usr/bin/env bash
# Pull Phosphor icons into public/vendor (offline-friendly dashboard). The
# desktop stream is Selkies (served from the pod), so no VNC client is vendored.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
VENDOR="$ROOT/public/vendor"
mkdir -p "$VENDOR"

if [[ ! -f "$VENDOR/phosphor/style.css" ]]; then
  echo "[vendor] Phosphor icons (regular)"
  mkdir -p "$VENDOR/phosphor"
  base="https://unpkg.com/@phosphor-icons/web@2.1.1/src/regular"
  curl -fsSL "$base/style.css" -o "$VENDOR/phosphor/style.css"
  # Rewrite font URLs to the local folder.
  sed -i 's|url("./Phosphor.|url("./Phosphor.|g' "$VENDOR/phosphor/style.css"
  for f in Phosphor.woff2 Phosphor.woff Phosphor.ttf Phosphor.svg; do
    curl -fsSL "$base/$f" -o "$VENDOR/phosphor/$f" || true
  done
fi

if [[ ! -f "$VENDOR/m.min.js" ]]; then
  echo "[vendor] missing m.min.js — copy from /workspace/m-js/dist" >&2
  exit 1
fi

echo "[vendor] ok"
