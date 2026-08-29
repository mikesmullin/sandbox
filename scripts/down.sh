#!/usr/bin/env bash
set -euo pipefail
CLUSTER="${CLUSTER:-agent-desktop}"
export KIND_EXPERIMENTAL_PROVIDER="${KIND_EXPERIMENTAL_PROVIDER:-podman}"

if kind get clusters 2>/dev/null | grep -qx "$CLUSTER"; then
  kind delete cluster --name "$CLUSTER"
  echo "[down] deleted kind cluster $CLUSTER"
else
  echo "[down] cluster $CLUSTER not found"
fi
