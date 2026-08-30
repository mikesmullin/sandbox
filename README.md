# Agent desktop

A local **computer-use sandbox**: Debian XFCE desktops on Kind over rootless Podman, each with headed browser-use Chromium and an in-pod coding agent. A control-room SPA tiles the screens and talks to the agent over a cowork-style chat.

## Problem

Cloud agent products give the model a real Linux PC — XFCE, Thunar, a terminal, a browser — and a remote viewer so you can watch and take over. Local coding agents usually get the opposite: a process sandbox with files and a shell, no headed desktop, no clickable browser.

Recreating the cloud stack on a laptop is fiddly. Chromium wants thousands of PIDs. Kind on Podman does not import images the same way Docker does. Inference has to leave the cluster without hairpinning through the LAN. The agent needs the *current* `agl-ai` providers (`llama-server`), not the stale npm package. And the human still needs a tiled VNC wall plus a chat that can approve tools.

## Solution

This repo is that stack, running on one Kind cluster (`agent-desktop`) in namespace `agent-desktop`:

```text
browser  http://127.0.0.1:8080   (host SPA + HMR; recommended)
         http://127.0.0.1:8090   (in-cluster dashboard; production)
    │  tiled noVNC + chat
    ▼
dashboard  (Bun / CoffeeScript Express)
    │  REST for pods/scale
    │  WS pipe  /desktops/:name/websockify  →  pod :6080
    │  WS pipe  /desktops/:name/agent       →  pod :8091/ws
    ▼
desktop-N  (Debian bookworm)
  Xvfb → XFCE → x11vnc → websockify/noVNC
  headed browser-use Chromium  (stealth launch, CDP)
  Angela owner     (file-io, term-local, agent-browser MCP)
       │
       ▼
  dad-proxy  https://host.containers.internal:1234
             (llama-server:default, pasta IP 169.254.1.2)
```

Tools run **inside the pod**. Durable work lives in `/workspace/jails/<workspace-id>/` (emptyDir). Do not paste secrets into chat — type them on the desktop.

GitLab (in-cluster): `http://gitlab` (same-namespace DNS; FQDN `gitlab.agent-desktop.svc.cluster.local` also works)  
UI: `root` — password is `tmp/gitlab_password.md` on the host (gitignored)  
git CLI: credential helper already set; do not type the password in chat

See [`CONTRIB.md`](CONTRIB.md) for bring-up and rebuild.

## Quick start

Needs **Podman**, **Bun**, and **kubectl** on the host. `scripts/up.sh` installs Kind into `~/.local/bin` if it is missing. Inference goes through a running **dad-proxy** on the host (`:1234`); `up.sh` copies `LLM_PROXY_API_KEY` from `/workspace/dad-proxy/.env` into a cluster Secret without printing it.

```sh
cd /workspace/factory/container
./scripts/up.sh          # Kind cluster + desktop pods
./scripts/dev-ui.sh      # control room on the host (m-js HMR)
```

First boot of XFCE + the headed browser is slow. Open the host control room in a desktop-width browser:

```text
http://127.0.0.1:8080
```

Scale replicas from the wall. Click a tile (the desktop image or its margin) to isolate it; click the desktop again to capture mouse and keyboard; **Esc** releases capture, then the wall.

The in-cluster dashboard (Kind NodePort `http://127.0.0.1:8090`) is the production shape — scale `deploy/dashboard` to 1 when you want that. Day-to-day SPA work stays on the host so m-js HMR can reload JS/CSS. See [`CONTRIB.md`](CONTRIB.md).

Tear the cluster down:

```sh
./scripts/down.sh
```

How to rebuild and roll out after a code change is in [`CONTRIB.md`](CONTRIB.md).

## GPU (WebGL / three.js)

Headed Chromium in each desktop pod can use the **host NVIDIA GPU** (Vulkan + ANGLE). Several pods share the same card (time-sliced; no VRAM isolation). This is not the NVIDIA CDI / `nvidia-ctk` path — Kind’s node is already privileged and sees host `/dev/nvidia*` and `/dev/dri`, and `up.sh` copies matching NVIDIA userspace into the desktop image.

### Host

1. Proprietary NVIDIA driver installed and loaded. Check:

```sh
nvidia-smi
ls -l /dev/nvidia0 /dev/nvidiactl /dev/nvidia-uvm /dev/dri
```

2. Userspace libraries next to the driver (`libnvidia-glcore.so.*`, `libGLX_nvidia.so.*`, `libEGL_nvidia.so.*`, Vulkan ICD JSON). Typical locations: `/usr/lib64` or `/usr/lib/x86_64-linux-gnu`.

You do **not** need `nvidia-container-toolkit` or `/etc/cdi/nvidia.yaml` for this stack.

Without a driver or userspace, `./scripts/vendor-nvidia.sh` prints a warning and Chromium falls back to software GL. Pods still boot.

### Bring-up

`./scripts/up.sh` already runs `vendor-nvidia.sh` before `podman build`. That copies host NVIDIA libs into `vendor/nvidia/` (gitignored) so the image has `/opt/nvidia`. Desktop pods then mount the device nodes and run privileged so the cgroup allows them.

If you built the image before NVIDIA was installed, or you upgraded the host driver:

```sh
./scripts/vendor-nvidia.sh
podman build -t agent-desktop:latest -f Dockerfile .
source scripts/kind.sh
load_image docker.io/library/agent-desktop:latest
kubectl -n agent-desktop delete pod -l app=container
# then + container in the control room, or:
bun src/k8s.coffee ensure 1
```

Driver version in the image must match `nvidia-smi` on the host.

### Check

Inside a running desktop pod:

```sh
POD=$(kubectl -n agent-desktop get pods -l app=container -o jsonpath='{.items[0].metadata.name}')
kubectl -n agent-desktop exec "$POD" -- ls -l /dev/nvidia0 /dev/dri
kubectl -n agent-desktop logs "$POD" -c desktop | grep '\[gpu\]'
```

Expect `[gpu] host NVIDIA device /dev/nvidia0` and `[gpu] NVIDIA userspace /opt/nvidia/lib`. In the headed browser, `chrome://gpu` should show **WebGL: Hardware accelerated** and a renderer like `ANGLE (NVIDIA, Vulkan … GeForce …)`. A three.js page uses that path.
