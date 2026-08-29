# Contributing

Cluster name `agent-desktop`, namespace `agent-desktop`. Provider is **Podman**, not Docker (`KIND_EXPERIMENTAL_PROVIDER=podman`).

**Control room (SPA) is optional in-cluster.** Recommended for active development: run it on the host so m-js HMR reloads `public/` JS/CSS without rebuilding an image. Production (and a prod-like check) runs the same server as a Kubernetes Deployment behind NodePort/Ingress.

| Mode | Command | URL |
|---|---|---|
| Host SPA + HMR (recommended) | `./scripts/dev-ui.sh` | `http://127.0.0.1:8080` |
| In-cluster (production) | `kubectl -n agent-desktop scale deploy/dashboard --replicas=1` | `http://127.0.0.1:8090` (Kind NodePort `30080`) |

Host mode uses your kubeconfig and `kubectl port-forward` for each desktop (noVNC `:6080` **and** Angela `:8091`). Kind still owns host `:8090`, so the local SPA stays on `:8080`. `dev-ui.sh` scales the in-cluster dashboard to 0 so you do not edit one copy and load the other. In-cluster has HMR off (`KUBERNETES_SERVICE_HOST` is set).

## Layout

| Path | What |
|---|---|
| `src/` | Control-room server: Express REST + static (`server.coffee`), kubectl helpers (`k8s.coffee`). Bun.serve on the public port message-pipes WebSockets — `http-proxy` does not complete WS upgrades through Bun's `node:http`. |
| `public/` | SPA: m-js + Phosphor + vendored noVNC. `js/app.js` tiles RFB; isolate-mode chat is `x-component="mjs-chat"` from `public/vendor/m-js-cmp-chat` (`js/chat.js` is the WS store). |
| `agent/` | In-pod Angela harness (`src/server.coffee`). `agl-ai` / `angela` are `link:` deps. |
| `Dockerfile` | Debian bookworm desktop: Xvfb, XFCE, headed browser-use Chromium, x11vnc, noVNC, bun, agent-browser 0.35.1 (`mcp` subcommand). |
| `Dockerfile.dashboard` | Bun Alpine + kubectl; copies `src/` + `public/`. |
| `k8s/` | Namespace, RBAC (dashboard may list pods and scale the StatefulSet), desktop StatefulSet, dashboard Deployment. |
| `kind/cluster.yaml` | Extra port map 30080→8090, kubelet `podPidsLimit: 8192`. |
| `scripts/up.sh` / `down.sh` | Create or delete the whole stack. |
| `scripts/dev-ui.sh` | Host control room on `:8080` with m-js HMR; scales in-cluster dashboard to 0. |
| `scripts/kind.sh` | Kind under `systemd-run --user --scope --property=Delegate=yes`; image load via `ctr import`. |
| `scripts/vendor.sh` | noVNC core + Phosphor into `public/vendor/` (offline dashboard). |
| `scripts/vendor-chat.sh` | Copy `/workspace/m-js-cmp-chat` into `public/vendor/m-js-cmp-chat` (chat UI plugin). Re-run after plugin edits, then HMR/rebuild dashboard. |
| `scripts/vendor-agent.sh` | rsync `/workspace/agl`, `/workspace/angela`, mcp `file-io` / `term-local` into `vendor/` (strips `.env`, tokens, tests, plugins). Host `bun link` of both packages. Copies dad-proxy CA if present. |
| `scripts/entrypoint.sh` | Xvfb → XFCE → x11vnc → websockify → headed browser-use → `bun /opt/agent/src/server.coffee`. Rewires `/workspace/node_modules` after the emptyDir hides the image copy. |

Images: `agent-desktop:latest` (pods), `agent-desktop-ui:latest` (dashboard). Both use `imagePullPolicy: Never`.

## m-js

The control-room SPA is **[m-js](/workspace/m-js/docs/index.html)** (v3: Alpine-style `x-*` on a keyed virtual DOM). Those HTML pages are the **official docs**. New contributors should read them before changing `public/` — how `M.mount` / `M.store` / `M.component` work, which directives have full parity vs trade-offs (`x-ignore`, `x-model` caret, `x-for` keys), and how HMR is supposed to be wired (`/__m_hmr`, `data-hmr-entry`, `window.__M_BOOT__`).

This repo vendors `public/vendor/m.min.js` and, on the host dashboard, injects `public/js/hot-client.js` (same protocol as the docs). Do not treat m-js like Alpine’s in-place effects: a redraw with unchanged state must write nothing; named stores survive hot reload; noVNC canvases live under `x-ignore` so the reconciler does not own those nodes.

Chat UI is **[m-js-cmp-chat](/workspace/m-js-cmp-chat)** (`M.component('mjs-chat')`, sidebar + fullscreen). Edit that repo, then `./scripts/vendor-chat.sh`. Do not fork the markup back into `public/js/components/`. Cowork mounts the same widget against `M.store('cowork')`.

## Linked dependencies

npm `agl-ai@0.1.6` is stale (no `llama-server` provider). Always resolve **agl-ai** from `/workspace/agl` via `bun link`, then **angela** from `/workspace/angela` with `"agl-ai": "link:agl-ai"`.

`scripts/vendor-agent.sh` does the host links and vendors the trees into the desktop image. The image itself `bun link`s `/opt/vendor/agl` and `/opt/vendor/angela` as user `agent`. The pod's `/workspace` is an emptyDir, so `entrypoint.sh` recreates:

```text
/workspace/node_modules/agl-ai  →  /opt/vendor/agl
/workspace/node_modules/angela  →  /opt/vendor/angela
```

plus a tiny `package.json` so `bun` from cwd does not fall through to the npm cache.

Edit agl/angela, re-run `vendor-agent.sh`, rebuild the **desktop** image, and roll the StatefulSet. Dashboard code does not import agl.

MCP servers are vendored at `/opt/mcp` (file-io, term-local). Headed browser-use Chromium is driven by `agent-browser --cdp <url> --headed mcp --tools core` (needs **0.28+**; 0.27 has no `mcp` command). Do not point `AGENT_BROWSER_EXECUTABLE_PATH` at a second Chrome.

## Start / stop the cluster

```sh
cd /workspace/factory/container
./scripts/up.sh          # vendor, build images, create/start Kind, load, apply, wait for desktops
./scripts/dev-ui.sh      # host control room :8080 with HMR (scales deploy/dashboard to 0)
./scripts/down.sh        # kind delete cluster --name agent-desktop
```

`up.sh` is idempotent: existing cluster is started, images are re-imported, manifests re-applied. It leaves `deploy/dashboard` at **0 replicas**. First XFCE + browser boot can take several minutes (`rollout status` timeout 420s).

If `down.sh` reports the cluster missing, Podman 6's label JSON breaks `kind get clusters`. List/delete via the helper:

```sh
source scripts/kind.sh
kind_clusters
kind_run delete cluster --name agent-desktop
```

Or `podman ps -a --filter label=io.x-k8s.kind.cluster`.

`up.sh` also:

- sets the Kind node `pids-limit` to **32768** (rootless default 2048 kills Chromium with pthread errors)
- writes Secret `dad-proxy` / key `api-key` from `DAD_PROXY_API_KEY`, `LLM_PROXY_API_KEY`, or `/workspace/dad-proxy/.env` — **never echo the value**
- maps pasta host IP `169.254.1.2` → `host.containers.internal` / `uber.home` so pods reach dad-proxy. Kind cannot hairpin the host LAN IP.

Without a key, chat will 401 on https inference. The dashboard still tiles VNC.

Scale without rebuilding:

```sh
kubectl -n agent-desktop scale statefulset/desktop --replicas=1
# or the control-room slider (0–8)
```

## Container logs

One container per pod: `desktop` on the StatefulSet, `dashboard` on the Deployment (usually **0 replicas** during host-SPA development). Entrypoint, XFCE, Chromium, and the Angela bun process all share the **desktop** container stdout (tagged `[entrypoint]`, `[agent]`, …). Host SPA logs are the `bun` process running `src/server.coffee`.

```sh
kubectl -n agent-desktop get pods -o wide

# live tail (pick a replica)
kubectl -n agent-desktop logs -f desktop-0 -c desktop
kubectl -n agent-desktop logs -f deploy/dashboard

# all desktop replicas, prefixed by pod name
kubectl -n agent-desktop logs -f -l app=desktop --prefix --timestamps

# previous crash (CrashLoop / OOM)
kubectl -n agent-desktop logs desktop-0 -c desktop --previous
kubectl -n agent-desktop describe pod desktop-0

# last few minutes / last N lines
kubectl -n agent-desktop logs desktop-0 --since=10m --tail=200
```

Angela prints `session=<id>` on ready. Health (model + session id, no secrets):

```sh
kubectl -n agent-desktop exec desktop-0 -- wget -qO- http://127.0.0.1:8091/health
```

Kind node itself (kubelet / image import / PID pressure), not the app:

```sh
source scripts/kind.sh
podman logs "$(kind_node_name agent-desktop)"
```

## Angela session JSON

Harness `projectRoot` is `/workspace` (`ANGELA_PROJECT_ROOT`). Sessions are written **inside the pod** on the emptyDir jail — they are not on the host, and they vanish when the pod is deleted or rolled.

```text
/workspace/.angela/sessions/<id>.json    # metadata only (agent, model, turns, status — no transcript)
/workspace/.angela/sessions/<id>.jsonl   # append-only event log (context window, provider I/O, tools)
```

Session id is the filename. Find it from logs (`[agent] ready … session=`), `/health`, or the chat WS `hello.sessionId`.

```sh
# list
kubectl -n agent-desktop exec desktop-0 -- ls -l /workspace/.angela/sessions/

# metadata
kubectl -n agent-desktop exec desktop-0 -- cat /workspace/.angela/sessions/<id>.json

# event log (one JSON object per line)
kubectl -n agent-desktop exec desktop-0 -- cat /workspace/.angela/sessions/<id>.jsonl
```

Copy out, then inspect on the host:

```sh
mkdir -p tmp/sessions
kubectl -n agent-desktop cp desktop-0:/workspace/.angela/sessions tmp/sessions
jq . tmp/sessions/<id>.json
jq -r '.event_type' tmp/sessions/<id>.jsonl
jq 'select(.event_type=="provider_request" or .event_type=="provider_response")' tmp/sessions/<id>.jsonl
jq 'select(.event_type=="tool_call" or .event_type=="tool_result")' tmp/sessions/<id>.jsonl
```

JSONL wrapper (telemetry on the wrapper, verbatim body in `payload`):

```json
{ "ts": "…", "event_type": "context_window | provider_request | provider_response | tool_call | tool_result | policy | session", "duration_ms": 412.5, "payload": { } }
```

Line order is the event sequence. `event_type: session` is lifecycle (`created`, `turn_complete`, `aborted`).

Do not commit copied sessions — they can contain prompts, tool args, and file contents. `scripts/vendor-agent.sh` already excludes `.angela` when rsyncing the angela **source** tree; that is unrelated to this runtime directory.

## Deploy changes

Pick the smallest rebuild. Kind does not see host `podman build` until you import.

Load helper (do not use `kind load` on this Podman setup):

```sh
source scripts/kind.sh
load_image docker.io/library/IMAGE:latest
```

`up.sh` already sources this and imports both images.

### SPA / control-room server (`public/`, `src/`)

**Day-to-day (recommended):** host process, no image rebuild.

```sh
./scripts/dev-ui.sh          # bun --watch :8080, m-js HMR on /__m_hmr
```

Save files under `public/js`, `public/css`, or `public/index.html`. CSS swaps in place; JS re-runs `window.__M_BOOT__` (named `M.store`s survive). Server CoffeeScript changes restart bun (`--watch`). Do not pin `?v=` query strings on JS — they defeat HMR. Serving `index.html` for missing JS 404s is forbidden (breaks ES module graphs).

`hot-client.js` is injected only in host mode. In-cluster does not connect to `/__m_hmr`.

**Production / in-cluster check:** rebuild the dashboard image and scale the Deployment up.

```sh
podman build -t agent-desktop-ui:latest -f Dockerfile.dashboard .
source scripts/kind.sh
load_image docker.io/library/agent-desktop-ui:latest
kubectl -n agent-desktop scale deploy/dashboard --replicas=1
kubectl -n agent-desktop rollout restart deploy/dashboard
kubectl -n agent-desktop rollout status deploy/dashboard
```

Then `http://127.0.0.1:8090`. Stop the host `dev-ui` process first if you want a single UI. Scale back to 0 when you return to HMR.

### In-pod agent (`agent/src/`, vendored agl/angela/mcp)

```sh
./scripts/vendor-agent.sh
podman build -t agent-desktop:latest -f Dockerfile .
source scripts/kind.sh
load_image docker.io/library/agent-desktop:latest
kubectl -n agent-desktop rollout restart statefulset/desktop
kubectl -n agent-desktop rollout status statefulset/desktop --timeout=420s
```

StatefulSet + `imagePullPolicy: Never` can keep the old image if the tag did not change. If pods do not pick up the import:

```sh
kubectl -n agent-desktop delete pod -l app=desktop
```

`/workspace` is emptyDir — rolling a pod **wipes** jail files. Chromium profile under `$HOME` also dies with the pod.

### Manifests (`k8s/`, `kind/cluster.yaml`)

```sh
kubectl apply -f k8s/namespace.yaml -f k8s/rbac.yaml -f k8s/desktop.yaml -f k8s/dashboard.yaml
```

`kind/cluster.yaml` (port map, `podPidsLimit`) only applies at **create**. To change it: `./scripts/down.sh` then `./scripts/up.sh`. After create, still run `podman update --pids-limit=32768` on the Kind node if Chromium starts dying on threads.

### Full stack

```sh
./scripts/up.sh
```

## Agent / chat notes

- Default model `llama-server:default` via `Agent.factory({ model, base_url, api_key, ca_file })`. URL is `https://host.containers.internal:1234`. CA is `/opt/certs/ca.pem` when vendored from dad-proxy.
- Policy is **ask** + Lucy allowlist, plus `file_io__write_file` and `browser__.*`. Chat Send includes the current allowlist textarea; the shield editor must actually persist (seed once from `hello`, do not clobber on the 3s desktop refresh).
- `MCP_TERM_ALLOW=.*` so term-local does not apply a second jail. The UI allowlist is the gate.
- CONTEXT LOOP builtins (`goto`, `loop_start_marker`, `waypoint`) are stripped after `listToolCatalog`.
- Approvals: broadcast from PolicyEngine `onEvent` only. Duplicate cards with the same id are one approval — Allow/Deny one of them.
- Abort/Stop is **not** queued behind the in-flight chat turn.
- Capture: RFB stays `viewOnly` until the isolated desktop is clicked, so the chat sidebar can take keyboard. Esc → release capture → back to the wall. Clicking the tile image or its margin isolates; there is no separate “open”.
- Desktop refresh every 3s must not rewrite `ui.items` when name/ready/phase/restarts are unchanged (that redraw used to reset the allowlist).
- Chat prompt `/new` (whole message) is a harness command: Angela closes the current session and starts an empty one. It does not call the model. The sidebar clears to “New session.” Rebuild the **desktop** image after changing angela for this to apply in-pod.
- Tile **desktop / log / gauges** toggles are independent. Booting pods force the log pane (kubectl `logs -f`, stick-to-bottom). Gauges scrape `/telem` on the in-pod agent (`/proc`, not the glibc mycloud-probe). In-cluster dashboard needs `pods/log` RBAC.

## Do not

- Put API keys, `.env`, or tokens in chat, docs, or git. `vendor-agent.sh` already excludes them.
- Rewrite dad-proxy. Point at it.
- Use Docker APIs or `kind load docker-image` here.
- Expect npm `agl-ai` to know `llama-server`.
- Emulate a phone viewport when driving the control room — tiles and capture assume a desktop width (the XFCE session is 1280×800).
