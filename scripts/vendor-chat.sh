#!/usr/bin/env bash
# Copy /workspace/m-js-cmp-chat into public/vendor (Docker cannot follow a host symlink).
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
SRC="${MJS_CMP_CHAT:-/workspace/m-js-cmp-chat}"
if [[ -x "$SRC/scripts/vendor.sh" ]]; then
  exec "$SRC/scripts/vendor.sh" "$ROOT/public/vendor" "$@"
fi
echo "[vendor-chat] missing $SRC" >&2
exit 1
