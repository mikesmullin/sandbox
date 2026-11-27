#!/usr/bin/env bash
# build-voice.sh — build the thin TTS client binary for the sandbox image
# (Alpine/musl), straight from the host Zig toolchain.
#
#   The binary is a single static file with no deps beyond libc: built from
#     desktop/voice/voice.c
#   with `zig cc -target x86_64-linux-musl -O2 -static`.
#
#   Output: $HERE/dist/voice (gitignored); the image context is $HERE, so
#   Containerfile's `COPY dist/voice /usr/local/bin/voice` (or equivalent) picks
#   it up. Re-run this whenever voice.c changes — it is cheap (<2s).
#
#   Usage:
#     ./build-voice.sh    # build for x86_64 (the image's target)
#
#   Override the toolchain with ZIG=/path/to/zig (defaults to `zig` on PATH,
#   then the .zvm layouts).
#
#   Why Zig and not the system gcc: the system may be glibc; musl is what the
#   image ships, so the binary is cross-compiled with zig cc rather than built
#   inside a throwaway container (unlike build-spacesd.sh, which has to).

set -euo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"
DIST="$HERE/dist"
SRC="$HERE/voice/voice.c"
OUT="$DIST/voice"

mkdir -p "$DIST"

# --- toolchain resolution ------------------------------------------------------
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

# -static: the image is Alpine, which ships musl; do not leak glibc in.
"$ZIG" cc -target x86_64-linux-musl -O2 -static -o "$OUT" "$SRC"

# -static is not accepted together with -fPIC; nothing here needs PIC.
echo "== wrote $OUT"
file "$OUT"
ls -l "$OUT"
