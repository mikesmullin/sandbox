#!/usr/bin/env bash
# Copy angela / agl / mcp sources (no node_modules, no llama.cpp) for the desktop image.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
VENDOR="$ROOT/vendor"
mkdir -p "$VENDOR"

rsync_src() {
  local src="$1" dest="$2"
  mkdir -p "$dest"
  rsync -a --delete \
    --exclude node_modules \
    --exclude tmp \
    --exclude zig-out \
    --exclude zig-pkg \
    --exclude .git \
    --exclude bun.lock \
    --exclude 'target/' \
    --exclude plugins \
    --exclude test \
    --exclude .env \
    --exclude .copilot_tokens.json \
    --exclude .angela \
    "$src/" "$dest/"
}

echo "[vendor-agent] agl"
rsync_src /workspace/agl "$VENDOR/agl"
echo "[vendor-agent] angela"
rsync_src /workspace/angela "$VENDOR/angela"
# TUI is unused in the container; skip native opentui.
# Resolve agl-ai via bun link of /workspace/agl (npm agl-ai is stale).
python3 - <<'PY'
import json
from pathlib import Path
p = Path("/workspace/factory/sandbox/vendor/angela/package.json")
pkg = json.loads(p.read_text())
deps = pkg.get("dependencies") or {}
deps.pop("@opentui/core", None)
deps["agl-ai"] = "link:agl-ai"
pkg["dependencies"] = deps
p.write_text(json.dumps(pkg, indent=2) + "\n")
PY

echo "[vendor-agent] bun link agl-ai + angela (host)"
( cd /workspace/agl && bun link )
( cd /workspace/angela && bun link )

echo "[vendor-agent] mcp (file-io + term-local + todo + shared)"
mkdir -p "$VENDOR/mcp"
rsync -a --delete \
  --exclude node_modules \
  --exclude .git \
  --exclude bun.lock \
  --exclude test \
  /workspace/mcp/file-io "$VENDOR/mcp/"
rsync -a --delete \
  --exclude node_modules \
  --exclude .git \
  --exclude test \
  /workspace/mcp/term-local "$VENDOR/mcp/"
rsync -a --delete \
  --exclude node_modules \
  --exclude .git \
  --exclude test \
  /workspace/mcp/todo "$VENDOR/mcp/"
rsync -a --delete \
  --exclude node_modules \
  /workspace/mcp/shared "$VENDOR/mcp/" 2>/dev/null || true
cp /workspace/mcp/package.json "$VENDOR/mcp/package.json"

if [[ -f /workspace/dad-proxy/certs/ca.pem ]]; then
  mkdir -p "$VENDOR/certs"
  cp /workspace/dad-proxy/certs/ca.pem "$VENDOR/certs/ca.pem"
  echo "[vendor-agent] dad-proxy CA"
fi

echo "[vendor-agent] ok"
