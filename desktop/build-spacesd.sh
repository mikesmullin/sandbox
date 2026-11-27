#!/usr/bin/env bash

set -euo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
DIST="$HERE/dist"
mkdir -p "$DIST"

ARCH="${1:-$(uname -m)}"
[ "$ARCH" = "x86_64" ] && ARCH="amd64"
[ "$ARCH" = "aarch64" ] && ARCH="arm64"
TAG="main"
CORP_CA_FILE="${CUA_BUILD_CORP_CA:-}"
i=1
if [ $# -ge 2 ]; then
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

OUT="$(mktemp -d /tmp/cua-build.XXXXXX)"
REG="${HOME:-/tmp}/cua-registry/$RUNNER-$ARCH"
mkdir -p "$REG"
CA_FLAG=""
[ -n "${CORP_CA_FILE:-}" ] && CA_FLAG="-v \"$CORP_CA_FILE:/opt/corp-ca.crt:ro\""
if [ "$RUNNER" = "container" ]; then
  :
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

CSP_SRC=/work-out/libs/cua/crates/cua-spacesd-html5/src/lib.rs
if ! grep -q "frame-ancestors 'none'" "\$CSP_SRC"; then
  echo "ERROR: viewer CSP anchor not found in \$CSP_SRC (upstream moved it?)" >&2
  exit 1
fi
sed -i "s|frame-ancestors 'none'|frame-ancestors 'self' http://127.0.0.1:* http://localhost:*|" "\$CSP_SRC"
echo "  patched viewer CSP: frame-ancestors -> loopback origins"

SD=/work-out/libs/cua-spacesd/crates/cua-spacesd
sed -i 's|if std::env::var("CARGO_CFG_TARGET_ENV").as_deref() == Ok("musl") {|if false { // patched: this sandbox builds musl WITH the desktop|' "\$SD/build.rs"
sed -i 's|^\[target\.'"'"'cfg(not(target_env = "musl"))'"'"'\.dependencies\]\$|[target.'"'"'cfg(all())'"'"'.dependencies]|' "\$SD/Cargo.toml"
sed -i 's|^\[target\.'"'"'cfg(all(target_os = "linux", not(target_env = "musl")))'"'"'\.dependencies\]\$|[target.'"'"'cfg(all(target_os = "linux"))'"'"'.dependencies]|' "\$SD/Cargo.toml"
grep -q 'if false {' "\$SD/build.rs" || { echo "ERROR: musl un-gate failed (build.rs anchor moved)" >&2; exit 1; }
grep -q "cfg(all())" "\$SD/Cargo.toml" || { echo "ERROR: musl un-gate failed (Cargo.toml dep table anchor moved)" >&2; exit 1; }
grep -q "cfg(all(target_os = \"linux\"))" "\$SD/Cargo.toml" || { echo "ERROR: musl un-gate failed (Cargo.toml linux table anchor moved)" >&2; exit 1; }
grep -q 'target_env = "musl"' "\$SD/Cargo.toml" && { echo "ERROR: a musl gate survived in \$SD/Cargo.toml" >&2; exit 1; }
echo "  patched musl gates: desktop provider + platform-linux tool registry ON"

cd /work-out/libs/cua-spacesd
export CARGO_BUILD_JOBS=8
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
