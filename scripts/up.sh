#!/usr/bin/env bash
# Build the Alpine desktop + control-room images and run them on a Podman Kind cluster.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"
# shellcheck source=kind.sh
source "$ROOT/scripts/kind.sh"

CLUSTER="${CLUSTER:-agent-desktop}"
NS="${NS:-agent-desktop}"

echo "[up] provider=$KIND_EXPERIMENTAL_PROVIDER cluster=$CLUSTER"

if ! command -v kind >/dev/null 2>&1 && [[ ! -x "$HOME/.local/bin/kind" ]]; then
  echo "[up] installing kind into ~/.local/bin"
  mkdir -p "$HOME/.local/bin"
  curl -fsSL -o "$HOME/.local/bin/kind" \
    "https://kind.sigs.k8s.io/dl/v0.29.0/kind-linux-amd64"
  chmod +x "$HOME/.local/bin/kind"
fi

"$ROOT/scripts/vendor.sh"
"$ROOT/scripts/vendor-agent.sh"
bun install

echo "[up] building agent-desktop (Alpine XFCE)"
podman build -t agent-desktop:latest -f Dockerfile .
podman tag agent-desktop:latest localhost/agent-desktop:latest || true

echo "[up] building agent-desktop-ui"
podman build -t agent-desktop-ui:latest -f Dockerfile.dashboard .
podman tag agent-desktop-ui:latest localhost/agent-desktop-ui:latest || true

if kind_has_cluster "$CLUSTER"; then
  echo "[up] kind cluster $CLUSTER already exists"
  node="$(kind_node_name "$CLUSTER")"
  if [[ -n "$node" ]]; then
    podman start "$node" >/dev/null || true
  fi
  kubectl config use-context "kind-${CLUSTER}" >/dev/null
else
  echo "[up] creating kind cluster $CLUSTER"
  kind_run create cluster --name "$CLUSTER" --config "$ROOT/kind/cluster.yaml"
fi

# Chromium needs thousands of threads; rootless Podman defaults to 2048 for the whole node.
node="$(kind_node_name "$CLUSTER")"
if [[ -n "$node" ]]; then
  podman update --pids-limit=32768 "$node" >/dev/null || true
fi

echo "[up] loading images into kind"
load_image docker.io/library/agent-desktop:latest
load_image docker.io/library/agent-desktop-ui:latest

echo "[up] applying manifests"
kubectl apply -f "$ROOT/k8s/namespace.yaml"
kubectl apply -f "$ROOT/k8s/rbac.yaml"

# dad-proxy bearer. Prefer the caller's env; otherwise the local dad-proxy .env.
# Never echo the value.
dad_key="${DAD_PROXY_API_KEY:-${LLM_PROXY_API_KEY:-}}"
if [[ -z "$dad_key" && -f /workspace/dad-proxy/.env ]]; then
  dad_key="$(python3 - <<'PY'
from pathlib import Path
for line in Path("/workspace/dad-proxy/.env").read_text().splitlines():
    s = line.strip()
    if s.startswith("LLM_PROXY_API_KEY="):
        print(s.split("=", 1)[1].strip().strip('"').strip("'"), end="")
        break
PY
)"
fi
kubectl -n "$NS" create secret generic dad-proxy \
  --from-literal=api-key="${dad_key}" \
  --dry-run=client -o yaml | kubectl apply -f -
if [[ -n "$dad_key" ]]; then
  echo "[up] dad-proxy secret: present"
else
  echo "[up] dad-proxy secret: empty (https inference will 401)"
fi
unset dad_key

kubectl apply -f "$ROOT/k8s/desktop.yaml"
kubectl apply -f "$ROOT/k8s/dashboard.yaml"
# Day-to-day SPA runs on the host (HMR). In-cluster dashboard stays at 0 replicas
# until you scale it up for a prod-like check.
kubectl -n "$NS" scale deploy/dashboard --replicas=0 >/dev/null 2>&1 || true

echo "[up] waiting for desktops (first boot of XFCE/Chromium is slow)"
kubectl -n "$NS" rollout status statefulset/desktop --timeout=420s || true

echo
echo "[up] control room (host, HMR):  ./scripts/dev-ui.sh  →  http://127.0.0.1:8080"
echo "[up] in-cluster UI (prod):      kubectl -n $NS scale deploy/dashboard --replicas=1"
echo "[up]                            http://127.0.0.1:8090"
echo "[up] pods:"
kubectl -n "$NS" get pods -o wide
