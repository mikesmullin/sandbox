#!/usr/bin/env bash

set -euo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"
DIST="$HERE/dist"
SRC="$HERE/voice/voice.c"
OUT="$DIST/voice"

mkdir -p "$DIST"

ZIG="${ZIG:-}"
if [ -z "$ZIG" ]; then
  if command -v zig >/dev/null 2>&1; then
    ZIG="$(command -v zig)"
  elif [ -x /home/user/.zvm/master/bin/zig ]; then
    ZIG=/home/user/.zvm/master/bin/zig
  elif [ -x /home/user/.zvm/bin/zig ]; then
    ZIG=/home/user/.zvm/bin/zig
  else
    echo "error: zig not found; install it or set ZIG=/path/to/zig" >&2
    exit 1
  fi
fi

echo "== building voice (x86_64-linux-musl, static) =="
echo "  src:  $SRC"
echo "  zig:  $ZIG ($($ZIG version))"

"$ZIG" cc -target x86_64-linux-musl -O2 -static -o "$OUT" "$SRC"

echo "== wrote $OUT"
file "$OUT"
ls -l "$OUT"
