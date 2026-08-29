#!/usr/bin/env bash
# Kind + rootless Podman helpers. Podman 6 returns Labels as JSON objects,
# which breaks `kind get clusters`; we list clusters ourselves.
set -euo pipefail

export KIND_EXPERIMENTAL_PROVIDER="${KIND_EXPERIMENTAL_PROVIDER:-podman}"
CLUSTER="${CLUSTER:-agent-desktop}"

kind_bin() {
  if command -v kind >/dev/null 2>&1; then
    command -v kind
  else
    echo "$HOME/.local/bin/kind"
  fi
}

kind_run() {
  systemd-run --quiet --user --scope --property=Delegate=yes \
    --setenv=KIND_EXPERIMENTAL_PROVIDER="${KIND_EXPERIMENTAL_PROVIDER}" \
    --setenv=PATH="$PATH" \
    --setenv=HOME="$HOME" \
    --setenv=XDG_RUNTIME_DIR="${XDG_RUNTIME_DIR:-/run/user/$(id -u)}" \
    "$(kind_bin)" "$@"
}

kind_clusters() {
  python3 - <<'PY'
import json, subprocess
raw = subprocess.check_output([
    "podman", "ps", "-a",
    "--filter", "label=io.x-k8s.kind.cluster",
    "--format", "json",
], text=True)
seen = set()
for c in json.loads(raw or "[]"):
    labels = c.get("Labels") or {}
    if not isinstance(labels, dict):
        continue
    name = labels.get("io.x-k8s.kind.cluster")
    if name:
        seen.add(name)
for name in sorted(seen):
    print(name)
PY
}

kind_has_cluster() {
  kind_clusters | grep -qx "$1"
}

kind_node_name() {
  python3 - "$1" <<'PY'
import json, subprocess, sys
cluster = sys.argv[1]
raw = subprocess.check_output([
    "podman", "ps", "-a",
    "--filter", "label=io.x-k8s.kind.cluster",
    "--format", "json",
], text=True)
for c in json.loads(raw or "[]"):
    labels = c.get("Labels") or {}
    if labels.get("io.x-k8s.kind.cluster") == cluster and labels.get("io.x-k8s.kind.role") == "control-plane":
        names = c.get("Names") or []
        print(names[0] if isinstance(names, list) else names)
        break
PY
}

load_image() {
  local image="$1"
  local node
  node="$(kind_node_name "$CLUSTER")"
  if [[ -z "$node" ]]; then
    echo "no kind node for $CLUSTER" >&2
    return 1
  fi
  echo "[kind] importing $image into $node"
  podman save "$image" | podman exec -i "$node" ctr --namespace=k8s.io images import -
}
