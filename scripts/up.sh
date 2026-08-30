#!/usr/bin/env bash
# Build the desktop + control-room images and run them on a Podman Kind cluster.
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
"$ROOT/scripts/vendor-nvidia.sh"
bun install

echo "[up] building agent-desktop (Debian XFCE + browser-use)"
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

GITLAB_IMAGE="${GITLAB_IMAGE:-docker.io/gitlab/gitlab-ce:18.3.2-ce.0}"
echo "[up] pulling GitLab ${GITLAB_IMAGE}"
podman pull "$GITLAB_IMAGE"
podman tag "$GITLAB_IMAGE" docker.io/gitlab/gitlab-ce:18.3.2-ce.0 || true

echo "[up] loading images into kind"
load_image docker.io/library/agent-desktop:latest
load_image docker.io/library/agent-desktop-ui:latest
load_image docker.io/gitlab/gitlab-ce:18.3.2-ce.0

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

# GitLab root password: env override, else reuse the existing Secret, else
# generate 20 alphanumeric chars. Replace a leftover `rootroot` from the
# short-lived documented-pair experiment. Never echo the value.
gitlab_pw="${GITLAB_ROOT_PASSWORD:-}"
if [[ -z "$gitlab_pw" ]]; then
  gitlab_pw="$(kubectl -n "$NS" get secret gitlab -o jsonpath='{.data.root-password}' 2>/dev/null | base64 -d 2>/dev/null || true)"
fi
if [[ -z "$gitlab_pw" || "$gitlab_pw" == "rootroot" ]]; then
  gitlab_pw="$(python3 -c 'import secrets,string; a=string.ascii_letters+string.digits; print("".join(secrets.choice(a) for _ in range(20)))')"
fi
kubectl -n "$NS" create secret generic gitlab \
  --from-literal=root-password="${gitlab_pw}" \
  --from-literal=root-user=root \
  --dry-run=client -o yaml | kubectl apply -f -
echo "[up] gitlab secret: present"
unset gitlab_pw

# GitHub SSH for in-pod git push (host secrets/github-ssh/, gitignored).
# Never echo the private key.
gh_ssh="$ROOT/secrets/github-ssh"
if [[ -s "$gh_ssh/id_ed25519" ]]; then
  kubectl -n "$NS" create secret generic github-ssh \
    --from-file=id_ed25519="$gh_ssh/id_ed25519" \
    --from-file=id_ed25519.pub="$gh_ssh/id_ed25519.pub" \
    --from-file=known_hosts="$gh_ssh/known_hosts" \
    --dry-run=client -o yaml | kubectl apply -f -
  echo "[up] github-ssh secret: present"
else
  echo "[up] github-ssh secret: skip (no $gh_ssh/id_ed25519)"
fi

kubectl apply -f "$ROOT/k8s/gitlab.yaml"
kubectl apply -f "$ROOT/k8s/desktop.yaml"
kubectl apply -f "$ROOT/k8s/dashboard.yaml"
# Day-to-day SPA runs on the host (HMR). In-cluster dashboard stays at 0 replicas
# until you scale it up for a prod-like check.
kubectl -n "$NS" scale deploy/dashboard --replicas=0 >/dev/null 2>&1 || true

echo "[up] waiting for desktops (first boot of XFCE + browser is slow)"
# StatefulSet is a pod template (0 replicas). Live instances are unique pods.
kubectl -n "$NS" scale statefulset/container --replicas=0 >/dev/null 2>&1 || true
# Drop leftover ordinals (container-0, …) without touching container-<hex> pods.
while read -r pod; do
  [[ "$pod" =~ ^container-(0|[1-9][0-9]*)$ ]] || continue
  kubectl -n "$NS" delete pod "$pod" --wait=false >/dev/null 2>&1 || true
done < <(kubectl -n "$NS" get pods -l app=container -o jsonpath='{range .items[*]}{.metadata.name}{"\n"}{end}' 2>/dev/null)
bun src/k8s.coffee ensure 1
kubectl -n "$NS" wait --for=condition=Ready pod -l app=container --timeout=420s || true

echo
echo "[up] control room (host, HMR):  ./scripts/dev-ui.sh  →  http://127.0.0.1:8080"
echo "[up] in-cluster UI (prod):      kubectl -n $NS scale deploy/dashboard --replicas=1"
echo "[up]                            http://127.0.0.1:8090"
echo "[up] GitLab (in-cluster DNS):   http://gitlab"
echo "[up] GitLab UI:                 root + password in tmp/gitlab_password.md"
echo "[up] seeding GitLab ApplicationSettings (first boot is slow; skip if not Ready yet)"
"$ROOT/scripts/gitlab-seed.sh" || echo "[up] gitlab-seed deferred — rerun scripts/gitlab-seed.sh once GitLab is Ready"
echo "[up] pods:"
kubectl -n "$NS" get pods -o wide
