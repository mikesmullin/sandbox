#!/usr/bin/env bash
# sbox-a dev server — Rust backend forwards, Rust→wasm frontend, on the rustex1 kit.
#
#   ./dev.sh                 build if needed, serve on the port in rustex1.json
#   ./dev.sh 4000            override the port
#   ./dev.sh --rebuild       force a fresh wasm build on start
#
# Saving a file under app/ rebuilds the wasm and hot-swaps it with no page
# reload; saving one under server/ rebuilds and re-execs the server. Both are
# the rustex1 watcher's doing, not this script's.
#
# The API lives in sbox-b (default http://127.0.0.1:3000, env
# SANDBOX_API_ORIGIN) — start it first or the wall polls into a red brand.
set -euo pipefail
cd "$(dirname "$0")"

if ! rustup target list --installed | grep -q wasm32-unknown-unknown; then
  echo "sbox-a: adding the wasm32-unknown-unknown target"
  rustup target add wasm32-unknown-unknown
fi

# Pin the wasm-bindgen version the kit pins — a mismatched CLI produces a
# module the browser will not instantiate.
V="$(grep -o 'wasm-bindgen = "=[0-9.]*"' vendor/rustex1/kit/Cargo.toml | grep -o '[0-9.]*' | head -1)"
V="${V:-0.2.129}"

# The dev server looks for a wasm-bindgen CLI in ./tools, vendor/rustex1/tools
# and ../rustex1/tools before falling back to PATH. Keep that promise.
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

# blaze if it is here (seconds off every incremental rebuild), cargo if not
BUILD=cargo
command -v blaze >/dev/null 2>&1 && BUILD=blaze
$BUILD build -q -p sbox-a-server

exec ./target/debug/sbox-a-server "$@"
