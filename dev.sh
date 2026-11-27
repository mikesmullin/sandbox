#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")"

if ! rustup target list --installed | grep -q wasm32-unknown-unknown; then
  echo "sbox-a: adding the wasm32-unknown-unknown target"
  rustup target add wasm32-unknown-unknown
fi

V="$(grep -o 'wasm-bindgen = "=[0-9.]*"' vendor/rustex1/kit/Cargo.toml | grep -o '[0-9.]*' | head -1)"
V="${V:-0.2.129}"

have_cli() {
  ls tools/*/wasm-bindgen >/dev/null 2>&1 \
    || ls vendor/rustex1/tools/*/wasm-bindgen >/dev/null 2>&1 \
    || command -v wasm-bindgen >/dev/null 2>&1
}

if ! have_cli; then
  case "$(uname -s)" in
    Darwin) ARCH="$(uname -m)-apple-darwin" ;;
    *)      ARCH="$(uname -m)-unknown-linux-musl" ;;
  esac
  echo "sbox-a: installing wasm-bindgen ${V} (${ARCH}) into tools/"
  mkdir -p tools
  curl -fsSL "https://github.com/wasm-bindgen/wasm-bindgen/releases/download/${V}/wasm-bindgen-${V}-${ARCH}.tar.gz" \
    | tar xz -C tools/
fi

BUILD=cargo
command -v blaze >/dev/null 2>&1 && BUILD=blaze
$BUILD build -q -p sbox-a-server

exec ./target/debug/sbox-a-server "$@"
