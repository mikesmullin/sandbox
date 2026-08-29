#!/usr/bin/env bash
# Control-room SPA on the host (m-js HMR). Desktops stay in Kind.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

NS="${NS:-agent-desktop}"
export PORT="${PORT:-8080}"

if command -v kubectl >/dev/null 2>&1; then
  kubectl -n "$NS" scale deploy/dashboard --replicas=0 >/dev/null 2>&1 || true
fi

bun install --silent

echo "[dev-ui] http://127.0.0.1:${PORT}  (host SPA, HMR on)"
echo "[dev-ui] in-cluster UI: kubectl -n ${NS} scale deploy/dashboard --replicas=1 → http://127.0.0.1:8090"
exec bun --watch src/server.coffee
