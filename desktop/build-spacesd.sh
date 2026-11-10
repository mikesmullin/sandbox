#!/usr/bin/env bash
# build-spacesd.sh — build the musl cua-spacesd binary for the sandbox
# desktop image (Alpine + Openbox), in a throwaway Alpine container.
#
#   Runtime selection: `podman` or `docker` if present, else Apple `container`
#   (Mac only, native arch).
#
#   Usage:
#     ./build-spacesd.sh                      # build for the local arch (uname -m)
#     ./build-spacesd.sh amd64                # amd64 (qemu-emulated if host differs)
#     ./build-spacesd.sh arm64
#     ./build-spacesd.sh <arch> <tag>         # e.g. ... main / <git tag>
#     ./build-spacesd.sh <arch> <tag> --corporate-ca /path/to/bundle.pem
#
#   --corporate-ca /path/to/bundle.pem  (or env CORP_CA_FILE / CUA_BUILD_CORP_CA):
#   optional. When set, that user-managed CA bundle — one you exported yourself
#   when behind a TLS-intercepting corporate network — is appended to the
#   container's CA bundle and used for cargo. NOTHING is committed to or named
#   by this repo; with the flag unset the build uses the standard public bundle
#   only (works fine on the public internet).
#
#   Source: fresh sparse-clone of the public repo https://github.com/trycua/cua
#   at $TAG each build (default main). No FORK is required — current main
#   compiles for musl amd64/arm64 cleanly (see ../spike/README.md for the
#   v0.5.3 history) — but ONE patch is still required and applied below: the
#   viewer CSP (patch (c)), without which every SPA wall tile is blank. Only
#   the two standard `google/protobuf/{duration,timestamp}.proto` files that
#   alpine's protoc lacks are fetched from the protobuf repo.
#
#   KNOWN LIMITATION (upstream main): a musl build is headless BY DESIGN —
#   crates/cua-spacesd/Cargo.toml gates cua-spacesd-desktop and platform-linux
#   behind `cfg(not(target_env = "musl"))`, so this binary stubs Computer,
#   Windows, Accessibility, Stream and Presence and answers /mcp tools/list with
#   501. The viewer then shows "this cua-spacesd build has no desktop provider".
#   A desktop-capable daemon needs a glibc target and a glibc base image.
#
#   Output: $HERE/dist/cua-spacesd (gitignored); the image context is $HERE,
#   so Containerfile's `COPY dist/cua-spacesd /usr/local/bin/cua-spacesd` picks
#   it up. Re-run with the matching arch whenever you build the image on a new
#   host (mac builds arm64; this Linux box builds amd64).

set -euo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
DIST="$HERE/dist"
mkdir -p "$DIST"

# --- args --------------------------------------------------------------------
ARCH="${1:-$(uname -m)}"
[ "$ARCH" = "x86_64" ] && ARCH="amd64"
[ "$ARCH" = "aarch64" ] && ARCH="arm64"
TAG="main"
CORP_CA_FILE="${CUA_BUILD_CORP_CA:-}"
i=1
if [ $# -ge 2 ]; then
  # shift past arch
  case "$2" in --corporate-ca) CORP_CA_FILE="$3" ;; esac
  TAG="${2:-main}"
fi
case "$ARCH" in
  amd64|arm64) : ;;
  *) echo "arch: unknown '$ARCH' (use amd64|arm64)" >&2; exit 1 ;;
esac
if [ -n "${CORP_CA_FILE:-}" ] && [ ! -f "$CORP_CA_FILE" ]; then
  echo "error: corporate CA file $CORP_CA_FILE not found" >&2; exit 1
fi
HOST_ARCH=$(uname -m)
[ "$HOST_ARCH" = "x86_64" ] && HOST_ARCH="amd64"
[ "$HOST_ARCH" = "aarch64" ] && HOST_ARCH="arm64"

echo "== building cua-spacesd for $ARCH from trycua/cua@${TAG:-main} =="

# --- runtime selection --------------------------------------------------------
RUNNER=""
for c in podman docker; do
  command -v "$c" >/dev/null 2>&1 && RUNNER="$c"
  [ -n "$RUNNER" ] && break
done
if [ -z "$RUNNER" ] && command -v container >/dev/null 2>&1; then
  if [[ $(uname) != Darwin ]]; then
    echo "error: Apple 'container' CLI found but host is not a Mac; install podman or docker" >&2; exit 1
  fi
  RUNNER="container"
fi
if [ -z "$RUNNER" ]; then
  echo "error: no container runtime found (podman, docker, or container)" >&2; exit 1
fi
echo "  runtime: $RUNNER   platform: linux/$ARCH   $( [ "$ARCH" != "$HOST_ARCH" ] && echo '(emulated)' || echo '(native)')"

# qemu required for emulated podman/docker builds on a Linux host
if [ "$RUNNER" != "container" ] && [ "$ARCH" != "$HOST_ARCH" ]; then
  if ! command -v qemu-user-static >/dev/null 2>&1 && podman version 2>/dev/null | grep -qi qemu; then
    :
  else
    echo "  note: building $ARCH on $HOST_ARCH needs qemu user-mode emulation" >&2
    if ! podman run --rm --platform linux/$ARCH alpine:latest sh -c "exit 0" >/dev/null 2>&1; then
      echo "  warning: emulation may not be available; continue anyway" >&2
    fi
  fi
fi

# --- build in a container ------------------------------------------------------
OUT="$(mktemp -d /tmp/cua-build.XXXXXX)"
REG="${HOME:-/tmp}/cua-registry/$RUNNER-$ARCH"   # host-side cargo registry cache (fast re-runs)
mkdir -p "$REG"
CA_FLAG=""
[ -n "${CORP_CA_FILE:-}" ] && CA_FLAG="-v \"$CORP_CA_FILE:/opt/corp-ca.crt:ro\""
if [ "$RUNNER" = "container" ]; then
  :  # Apple Containers: no --platform/--memory/--cpus
else
  RUN_FLAGS=(--platform linux/$ARCH --memory=8g --cpus=8)
fi
rm -rf "$OUT/cua-spacesd"

$RUNNER run "${RUN_FLAGS[@]}" --rm -i $CA_FLAG \
  -v "$OUT:/work-out" -v "$REG:/root/.cargo:rw" \
  alpine:latest sh -s <<EOS
set -Eeu; set -o pipefail
apk update >/dev/null 2>&1
apk add --no-cache build-base file ca-certificates curl git nasm cmake perl pkgconf g++ gcc linux-headers musl-dev \
  libx11-dev libxi-dev libxtst-dev libxext-dev libxkbcommon-dev libxcb-dev \
  wayland-dev wayland-libs-client wayland-libs-cursor opus-dev libprotobuf protobuf protoc >/dev/null 2>&1
ln -sf /usr/bin/g++ /usr/local/bin/c++
curl --proto =https --tlsv1.2 -sSf https://sh.rustup.rs | sh -s -- -y --default-toolchain 1.97 >/dev/null 2>&1
export PATH=\$HOME/.cargo/bin:\$PATH
echo "rustc \$(rustc --version)  host-tuple \$(rustc --print host-tuple)"
rm -rf /tmp/cua-src
git clone --depth 1 --branch $TAG --filter=blob:none --sparse https://github.com/trycua/cua /tmp/cua-src
git -C /tmp/cua-src sparse-checkout set libs
mkdir -p /tmp/cua-src/libs/cua/proto/google/protobuf
curl -fsSL -o /tmp/cua-src/libs/cua/proto/google/protobuf/duration.proto \
  https://raw.githubusercontent.com/protocolbuffers/protobuf/master/src/google/protobuf/duration.proto
curl -fsSL -o /tmp/cua-src/libs/cua/proto/google/protobuf/timestamp.proto \
  https://raw.githubusercontent.com/protocolbuffers/protobuf/master/src/google/protobuf/timestamp.proto
cp -a /tmp/cua-src/libs /work-out/libs

# --- patch (c) from ../spike/README.md: viewer CSP ------------------------
# Upstream hardcodes the viewer CSP with frame-ancestors 'none', so every SPA
# wall tile renders blank while a standalone viewer tab renders fine (a
# confusing split). No env var or flag overrides it upstream, so it is a source
# patch. This is a PRODUCT patch, not a musl one: it must survive every rebase
# onto a new upstream tag, and the build fails loudly if the anchor moves
# rather than silently shipping un-embeddable tiles again.
CSP_SRC=/work-out/libs/cua/crates/cua-spacesd-html5/src/lib.rs
if ! grep -q "frame-ancestors 'none'" "\$CSP_SRC"; then
  echo "ERROR: viewer CSP anchor not found in \$CSP_SRC (upstream moved it?)" >&2
  exit 1
fi
sed -i "s|frame-ancestors 'none'|frame-ancestors 'self' http://127.0.0.1:* http://localhost:*|" "\$CSP_SRC"
echo "  patched viewer CSP: frame-ancestors -> loopback origins"

# --- patch (d): un-gate the desktop provider on musl --------------------------
# Upstream treats a musl build as THE STATIC HEADLESS GUEST DAEMON: build.rs
# emits the 'cua_headless' cfg whenever CARGO_CFG_TARGET_ENV == musl, and
# crates/cua-spacesd/Cargo.toml drops cua-spacesd-desktop, cua-spacesd-doctor
# and platform-linux on that target. Everything in src/ then keys off
# 'cua_headless', so an un-patched Alpine build stubs Computer, Windows,
# Accessibility, Stream and Presence: the viewer reports "this cua-spacesd build
# has no desktop provider" and /mcp tools/list answers 501.
#
# This sandbox wants the combination upstream does not ship: an Alpine/musl
# guest WITH the desktop. Nothing it pulls in is glibc-bound — x11rb and
# atspi/zbus are pure Rust, the X11 and opus libs are installed above, openh264
# builds from source with g++, and the hw-encoder and PulseAudio backends are
# dlopen-based (they compile to a clean "unavailable" with no build-time dep).
SD=/work-out/libs/cua-spacesd/crates/cua-spacesd
sed -i 's|if std::env::var("CARGO_CFG_TARGET_ENV").as_deref() == Ok("musl") {|if false { // patched: this sandbox builds musl WITH the desktop|' "\$SD/build.rs"
# The linux table gets a cfg that is EQUIVALENT but not byte-identical to the
# existing 'cfg(target_os = "linux")' table — two identical TOML keys collide.
sed -i 's|^\[target\.'"'"'cfg(not(target_env = "musl"))'"'"'\.dependencies\]\$|[target.'"'"'cfg(all())'"'"'.dependencies]|' "\$SD/Cargo.toml"
sed -i 's|^\[target\.'"'"'cfg(all(target_os = "linux", not(target_env = "musl")))'"'"'\.dependencies\]\$|[target.'"'"'cfg(all(target_os = "linux"))'"'"'.dependencies]|' "\$SD/Cargo.toml"
# Fail loudly rather than silently shipping another headless binary.
grep -q 'if false {' "\$SD/build.rs" || { echo "ERROR: musl un-gate failed (build.rs anchor moved)" >&2; exit 1; }
grep -q "cfg(all())" "\$SD/Cargo.toml" || { echo "ERROR: musl un-gate failed (Cargo.toml dep table anchor moved)" >&2; exit 1; }
grep -q "cfg(all(target_os = \"linux\"))" "\$SD/Cargo.toml" || { echo "ERROR: musl un-gate failed (Cargo.toml linux table anchor moved)" >&2; exit 1; }
grep -q 'target_env = "musl"' "\$SD/Cargo.toml" && { echo "ERROR: a musl gate survived in \$SD/Cargo.toml" >&2; exit 1; }
echo "  patched musl gates: desktop provider + platform-linux tool registry ON"

cd /work-out/libs/cua-spacesd
export CARGO_BUILD_JOBS=8
# The x86_64-unknown-linux-musl target defaults to -crt-static (a fully static
# -static-pie binary). That is right for the stock HEADLESS daemon, which links
# no system libraries — but the desktop build links libX11, libXi, libXtst,
# libxkbcommon and libopus, and Alpine ships those as shared objects only (no
# .a archives), so a static link fails with "cannot find -lX11 ... have you
# installed the static version". Link dynamically instead: desktop/Containerfile
# already installs exactly these libraries into the image as cua-spacesd's
# documented dynamic deps, and the guest is the same Alpine/musl as this builder.
export RUSTFLAGS="\${RUSTFLAGS:-} -C target-feature=-crt-static"
if [ -f /opt/corp-ca.crt ]; then
  echo "  trusting user corporate CA bundle (never committed)"
  cat /opt/corp-ca.crt >> /etc/ssl/certs/ca-certificates.crt
  export CARGO_HTTP_CAINFO=/etc/ssl/certs/ca-certificates.crt
fi
echo "  building ..."
cargo build --release -p cua-spacesd --bin cua-spacesd 2>&1 | tail -30
file target/release/cua-spacesd
./target/release/cua-spacesd --version
cp target/release/cua-spacesd /work-out/cua-spacesd
echo "BUILD OK"
EOS

if [ ! -x "$OUT/cua-spacesd" ]; then
  echo "ERROR: build failed (container exited non-zero or binary missing)" >&2
  exit 1
fi
mv "$OUT/cua-spacesd" "$DIST/cua-spacesd"
echo "== wrote $DIST/cua-spacesd"
file "$DIST/cua-spacesd"
