# Contributing

Cluster name `agent-desktop`, namespace `agent-desktop`. Provider is **Podman**, not Docker (`KIND_EXPERIMENTAL_PROVIDER=podman`).

**Control room (SPA) is optional in-cluster.** Recommended for active development: run it on the host so m-js HMR reloads `public/` JS/CSS without rebuilding an image. Production (and a prod-like check) runs the same server as a Kubernetes Deployment behind NodePort/Ingress.

| Mode | Command | URL |
|---|---|---|
| Host SPA + HMR (recommended) | `./scripts/dev-ui.sh` | `http://127.0.0.1:8080` |
| In-cluster (production) | `kubectl -n agent-desktop scale deploy/dashboard --replicas=1` | `http://127.0.0.1:8090` (Kind NodePort `30080`) |

Host mode uses your kubeconfig and `kubectl port-forward` for each desktop (Selkies stream `:6080` **and** Angela `:8091`). Kind still owns host `:8090`, so the local SPA stays on `:8080`. `dev-ui.sh` scales the in-cluster dashboard to 0 so you do not edit one copy and load the other. In-cluster has HMR off (`KUBERNETES_SERVICE_HOST` is set).

## Layout

| Path | What |
|---|---|
| `src/` | Control-room server: Express REST + static (`server.coffee`), kubectl helpers (`k8s.coffee`), browser-use snapshot (`snapshot.coffee`). Bun.serve on the public port message-pipes WebSockets — `http-proxy` does not complete WS upgrades through Bun's `node:http`. |
| `public/` | SPA: m-js + Phosphor. `js/app.js` tiles scrot thumbnails and, in isolate view, embeds the Selkies client in an `<iframe>` (`src=/desktops/:name/`); isolate-mode chat is `x-component="mjs-chat"` from `public/vendor/m-js-cmp-chat` (`js/chat.js` is the WS store). |
| `agent/` | In-pod Angela harness (`src/server.coffee`). `agl-ai` / `angela` are `link:` deps. |
| `Dockerfile` | Debian bookworm desktop: Xvfb, XFCE, headed browser-use Chromium, PulseAudio, Selkies (pip venv at `/opt/selkies`: `selkies` + `pixelflux` + `pcmflux`), bun, agent-browser 0.35.1 (`mcp` subcommand), plus current git/gh/pyenv/python/uv/node/npm/rust/go/zig/ruby (`scripts/install-devtools.sh`). |
| `patches/selkies-start-video.patch` | Makes the non-shared WebSocket client request its initial video stream; remove after the pinned Selkies revision includes the upstream fix. |
| `Dockerfile.dashboard` | Bun Alpine + kubectl; copies `src/` + `public/`. |
| `k8s/` | Namespace, RBAC (dashboard may list/create/delete pods and read the StatefulSet template), desktop StatefulSet (template only, 0 replicas), dashboard Deployment, GitLab CE (`gitlab.yaml`, ClusterIP on `http://gitlab`). |
| `kind/cluster.yaml` | Extra port map 30080→8090, kubelet `podPidsLimit: 8192`. |
| `scripts/up.sh` / `down.sh` | Create or delete the whole stack. |
| `scripts/dev-ui.sh` | Host control room on `:8080` with m-js HMR; scales in-cluster dashboard to 0. |
| `scripts/kind.sh` | Kind under `systemd-run --user --scope --property=Delegate=yes`; image load via `ctr import`. |
| `scripts/vendor.sh` | Phosphor icons into `public/vendor/` (offline dashboard). No VNC client is vendored — the Selkies client is served from the pod. |
| `scripts/vendor-chat.sh` | Copy `/workspace/m-js-cmp-chat` into `public/vendor/m-js-cmp-chat` (chat UI plugin). Re-run after plugin edits, then HMR/rebuild dashboard. |
| `scripts/vendor-agent.sh` | rsync `/workspace/agl`, `/workspace/angela`, mcp `file-io` / `term-local` into `vendor/` (strips `.env`, tokens, tests, plugins). Host `bun link` of both packages. Copies dad-proxy CA if present. |
| `scripts/vendor-nvidia.sh` | Copy host NVIDIA userspace (`/usr/lib64/libnvidia*`, Vulkan/EGL ICD JSON) into `vendor/nvidia` (gitignored). Re-run after driver updates. |
| `scripts/entrypoint.sh` | Xvfb → XFCE → PulseAudio (null sink) → Selkies (`--subfolder=/desktops/$POD`) → headed browser-use → `bun /opt/agent/src/server.coffee`. Rewires `/workspace/node_modules` after the emptyDir hides the image copy. |
| `scripts/install-devtools.sh` | Build-time install of current git, gh, pyenv+CPython+pip, uv, Node/npm, bun, rustup, Go, Zig, Ruby. Re-run only via desktop image rebuild. |

Images: `agent-desktop:latest` (pods), `agent-desktop-ui:latest` (dashboard). Both use `imagePullPolicy: Never`.

The lightweight ARM64 build still includes Git, GitHub CLI, GCC/G++, Make,
CMake, Python/pip/uv, Node/npm, Bun, Rust/Cargo, Go, Zig, Ruby, and common
network diagnostics (`ping`, `dig`, `nslookup`, `traceroute`, `ip`, `ss`,
`netcat`, `tcpdump`, `nmap`, `lsof`, `jq`, and `rsync`). It skips only the slow
from-source upgrades performed by `INSTALL_FULL_DEVTOOLS=1`.

`copilot:gpt-5.6-luna` uses non-streaming inference because the Copilot Responses
route rejects streaming requests. Model changes rebind the active Angela agent
in place so its connected MCP clients and tool catalog are reused.

GPU: Kind's node is privileged, so it already sees host `/dev/nvidia*` and `/dev/dri`. Desktop pods mount those devices and run privileged so the device cgroup allows them. NVIDIA userspace is copied from the host by `vendor-nvidia.sh` into the image (`/opt/nvidia`). Several pods share the same GPU (time-sliced; no VRAM isolation). Re-run `vendor-nvidia.sh` after a driver update, then rebuild the **desktop** image. Host has no `nvidia-ctk` CDI here — we do not use `--device nvidia.com/gpu=all`.

On macOS, Podman exposes a virtual `/dev/dri` device through the VM and kind,
but Mesa identifies it as `llvmpipe` (`Accelerated: no`, Vulkan device type
CPU). This is software rendering, not Apple GPU/Metal passthrough. Real GPU
forwarding therefore requires a Linux host with supported DRM or NVIDIA devices.

## m-js

The control-room SPA is **[m-js](/workspace/m-js/docs/index.html)** (v3: Alpine-style `x-*` on a keyed virtual DOM). Those HTML pages are the **official docs**. New contributors should read them before changing `public/` — how `M.mount` / `M.store` / `M.component` work, which directives have full parity vs trade-offs (`x-ignore`, `x-model` caret, `x-for` keys), and how HMR is supposed to be wired (`/__m_hmr`, `data-hmr-entry`, `window.__M_BOOT__`).

This repo vendors `public/vendor/m.min.js` and, on the host dashboard, injects `public/js/hot-client.js` (same protocol as the docs). Do not treat m-js like Alpine’s in-place effects: a redraw with unchanged state must write nothing; named stores survive hot reload. The isolate-view Selkies `<iframe>` src is per-container, so switching workspaces in the same pod does not reload it (the agent `focus` POST flips the X display); log panes live under `x-ignore` so the reconciler does not own those nodes.

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

MCP servers are vendored at `/opt/mcp` (file-io, term-local). **Do not vendor `mcp/sandbox`** — ada's coordinator MCP stays on the host. Headed browser-use Chromium is driven by `agent-browser --session <workspace-id> --cdp <url> --headed --pin-tab mcp --tools core,debug` (`core` is navigation/snapshot/eval; `debug` is console/errors/trace). Needs **0.34+** for `--pin-tab`; 0.27 has no `mcp` command. Do not point `AGENT_BROWSER_EXECUTABLE_PATH` at a second Chrome. Do not run xdotool/xfconf against the host display — XFCE workspaces live on the pod's `DISPLAY=:99`.

Job HTTP (ada spawn/wait/cancel) lives on the in-pod agent next to `/workspaces`:

```
POST /workspaces/:id/jobs          202 { task_id, workspace_id, session_id, status }
GET  /workspaces/:id/jobs
GET  /workspaces/:id/jobs/:task_id
POST /workspaces/:id/jobs/:task_id/abort
```

Dashboard proxies the same paths under `/api/desktops/:name/...`. Rebuild the **desktop** image after agent job-API edits. Host SPA (`dev-ui.sh`) picks up dashboard proxy edits without an image rebuild.

## Start / stop the cluster

```sh
cd /workspace/factory/sandbox
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
- writes Secret `gitlab` / `root-password` (random 20-char, or `GITLAB_ROOT_PASSWORD`) and applies `k8s/gitlab.yaml`. `scripts/gitlab-seed.sh` writes `tmp/gitlab_password.md` (gitignored) and enables git-over-HTTP password auth, public default visibility, and dark UI. Desktop git stores HTTP creds from the Secret so clone/push/pull never prompt. Browse GitLab at `http://gitlab`. **Never echo the password from `kubectl` or logs.** No PAT.
- writes Secret `github-ssh` from gitignored `secrets/github-ssh/` (`id_ed25519`, `.pub`, `known_hosts`) when that private key exists. Desktop pods mount it at `/opt/github-ssh`; entrypoint copies into `~/.ssh` and rewrites `https://github.com` → `git@github.com`. **Never echo the private key.** New containers only — rolling a pod still wipes `/workspace`.

Without a key, chat will 401 on https inference. The dashboard still tiles the desktops.

Scale without rebuilding: `+ container` / `− container` in the control room (0–8). Pods are named `container-<6 hex>` (sha1 of random bytes) so a deleted instance is never recreated under the same name. Do not scale the StatefulSet — it is only a pod template (`replicas: 0`).

## Container logs

One process container per pod: `desktop` inside uniquely named pods (`container-<6 hex>`, label `app=container`). The dashboard Deployment is usually **0 replicas** during host-SPA development. Entrypoint, XFCE, the headed browser, and the Angela bun process all share the **desktop** container stdout (tagged `[entrypoint]`, `[agent]`, …). Host SPA logs are the `bun` process running `src/server.coffee`.

```sh
kubectl -n agent-desktop get pods -o wide
POD=$(kubectl -n agent-desktop get pods -l app=container -o jsonpath='{.items[0].metadata.name}')

# live tail (pick a replica)
kubectl -n agent-desktop logs -f "$POD" -c desktop
kubectl -n agent-desktop logs -f deploy/dashboard

# all container replicas, prefixed by pod name
kubectl -n agent-desktop logs -f -l app=container --prefix --timestamps

# previous crash (CrashLoop / OOM)
kubectl -n agent-desktop logs "$POD" -c desktop --previous
kubectl -n agent-desktop describe pod "$POD"

# last few minutes / last N lines
kubectl -n agent-desktop logs "$POD" --since=10m --tail=200
```

Angela prints `session=<id>` on ready. Health (model + session id, no secrets):

```sh
kubectl -n agent-desktop exec "$POD" -- wget -qO- http://127.0.0.1:8091/health
```

Kind node itself (kubelet / image import / PID pressure), not the app:

```sh
source scripts/kind.sh
podman logs "$(kind_node_name agent-desktop)"
```

## Angela session JSON

Each XFCE workspace has its own file-io jail. Harness `projectRoot` is `/workspace/jails/<workspace-id>/` (`ANGELA_JAILS_ROOT`). Sessions are written **inside the pod** on that emptyDir jail — they are not on the host, and they vanish when the pod is deleted or rolled.

```text
/workspace/jails/workspace-<hex>/.angela/sessions/<id>.json    # metadata only (agent, model, turns, status — no transcript)
/workspace/jails/workspace-<hex>/.angela/sessions/<id>.jsonl   # append-only event log (context window, provider I/O, tools)
```

Session id is the filename. Find it from logs (`[agent] ready … session=`), `/health` (`workspaces.<name>.jail`), or the chat WS `hello.sessionId`.

```sh
POD=$(kubectl -n agent-desktop get pods -l app=container -o jsonpath='{.items[0].metadata.name}')
JAIL=$(kubectl -n agent-desktop exec "$POD" -- wget -qO- http://127.0.0.1:8091/health | jq -r '.workspaces | to_entries[0].value.jail')

# list
kubectl -n agent-desktop exec "$POD" -- ls -l "$JAIL/.angela/sessions/"

# metadata
kubectl -n agent-desktop exec "$POD" -- cat "$JAIL/.angela/sessions/<id>.json"

# event log (one JSON object per line)
kubectl -n agent-desktop exec "$POD" -- cat "$JAIL/.angela/sessions/<id>.jsonl"
```

Copy out, then inspect on the host:

```sh
mkdir -p tmp/sessions
kubectl -n agent-desktop cp "$POD":"$JAIL/.angela/sessions" tmp/sessions
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
# Podman often tags `localhost/IMAGE:latest`; Kind import wants docker.io/library/.
podman tag localhost/IMAGE:latest docker.io/library/IMAGE:latest 2>/dev/null || true
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
kubectl -n agent-desktop rollout restart statefulset/container
kubectl -n agent-desktop rollout status statefulset/container --timeout=420s
```

StatefulSet + `imagePullPolicy: Never` can keep the old image if the tag did not change. If pods do not pick up the import:

```sh
kubectl -n agent-desktop delete pod -l app=container
```

`/workspace` is emptyDir — rolling a pod **wipes** jail files. Chromium profile under `$HOME` also dies with the pod.

### Manifests (`k8s/`, `kind/cluster.yaml`)

```sh
kubectl apply -f k8s/namespace.yaml -f k8s/rbac.yaml -f k8s/desktop.yaml -f k8s/dashboard.yaml -f k8s/gitlab.yaml
```

GitLab emptyDir keeps repos until that Deployment is recreated. Rolling a **desktop** pod still wipes `/workspace` (including `/workspace/jails/`). Re-seed after GitLab is Ready: `./scripts/gitlab-seed.sh` (refreshes `tmp/gitlab_password.md` from the Secret).

`kind/cluster.yaml` (port map, `podPidsLimit`) only applies at **create**. To change it: `./scripts/down.sh` then `./scripts/up.sh`. After create, still run `podman update --pids-limit=32768` on the Kind node if Chromium starts dying on threads.

### Full stack

```sh
./scripts/up.sh
```

## Agent / chat notes

- Default model `llama-server:default` via `Agent.factory({ model, proxy, api_key, ca_file })`. `proxy` is `host:port` (dad-proxy; `https://host.containers.internal:1234`). Every `provider:model` (including `xai:grok-4.6`) POSTs OpenAI chat completions to that gateway with the full model id — native xAI/Anthropic clients are not used in-pod. CA is `/opt/certs/ca.pem` when vendored from dad-proxy. Model/allowlist/abort are per workspace session.
- Chat WS is the source of truth for that workspace: every browser that opens the same `/desktops/:pod/workspaces/:id/agent` socket sees the same transcript, allowlist, model, run/stopwatch, and approvals. Join sends `hello` then a `state` snapshot (history rebuilt from angela `delta/v1` jsonl). Submitted prompts (`user`) and live `allowlist` / `status` / deltas fan out to all clients. The composer textarea is local until Send — do not sync in-progress typing. Seed allowlist from `hello`/`state` once; the desktop refresh must still not rewrite `ui.items` (that used to clobber the shield).
- Live angela events the sidebar must understand: `assistant_delta`, `reasoning_delta`, `tool_delta` (MCP `notifications/progress` — snapshot of merged stdout, not a token append), `card` (`tool_call` / `tool_result` / `reasoning` / `assistant` from angela `final`), `approval_needed`, `status`, `done`, `visible` (eye toggle). `final` is how non-streaming (or tool-then-text) turns get an assistant bubble — do not wait only on deltas. Tool-result `image` is `{ mimeType, bytes }` metadata, not the base64 payload. Client `{ type: 'visible', eventId, visible }` writes angela `setEventVisible` + `setContextVisible` (tool_call/tool_result pair together) and fans out `{ type: 'visible', eventIds, visible }`.
- Policy is **ask** + Lucy allowlist (includes `file_io__grep` / `file_io__find`), plus `file_io__write_file`, `file_io__edit`, `term_local__exec:.*`, and `browser__.*`. Chat Send includes the current allowlist textarea.
- `MCP_TERM_ALLOW=.*` so term-local does not apply a second jail. The UI allowlist is the gate.
- CONTEXT LOOP (`goto`, `loop_start_marker`, `waypoint`) is an opt-in angela MCP preset, not a builtin. This harness does not load `context-loop`; `stripContextLoop` still drops those names plus `term_local__bash` and `browser__close` after `listToolCatalog`.
- Approvals: broadcast from PolicyEngine `onEvent` only. Duplicate cards with the same id are one approval — Allow/Deny one of them.
- Abort/Stop is **not** queued behind the in-flight chat turn. It also cancels in-flight MCP `tools/call` (sends `notifications/cancelled` and rejects the pending promise) so a blocking `term_local__exec` cannot hold `runLock`. term-local SIGTERM/SIGKILL the child.
- Mouse input: the isolate view is the Selkies HTML5 client in an `<iframe allow="fullscreen; clipboard-read; clipboard-write; gamepad; autoplay">`. Ordinary clicks and movement use visible absolute-pointer mode. The toolbar **mouse lock** and **Ctrl+Shift+X** are reserved for relative gaming input, where the browser cursor is intentionally hidden. Hold **Esc** to leave gaming mode; a plain **Esc** (not pointer-locked) or the toolbar **wall** button returns to the wall. Clicking a workspace thumbnail isolates; there is no separate “open”.
- Hash router (`M.Router.setMode('hash')`): wall is `#/` (or empty); isolate-mode is `#/c/:container/w/:workspace`. Isolate pushes a history entry; Esc / wall / browser Back return to the wall; Forward restores the last workspace. Refresh keeps the hash. Do not remount the App on `Router.onChange` — that would reload the Selkies iframe.
- Clipboard: handled by the Selkies client itself (two-way text, secure-context/localhost). No RFB clipboard bridge in the SPA anymore. Restart the **desktop** image after changing the Selkies launch flags.
- Audio: PulseAudio runs headless in the pod with a `module-null-sink` named `stream`. The laptop-tools template currently disables Selkies audio while its web client initializes an invalid decoder configuration before applying server settings. No physical audio device.
- Desktop refresh every 3s must not rewrite `ui.items` when name/ready/phase/restarts are unchanged (that redraw used to reset the allowlist).
- Each XFCE workspace has its own Angela session, chat socket (`/desktops/:pod/workspaces/:id/agent` → in-pod `/workspaces/:id/ws`), and file-io jail (`/workspace/jails/workspace-<hex>/` = Angela `projectRoot` / `MCP_FILE_ROOT` / `MCP_TERM_CWD`). `/new` starts a new Angela session for **that** workspace only (same Chromium window). Rebuild the **desktop** image after changing angela for this to apply in-pod.
- Git author is **per container**, set once in `~/.gitconfig` from the pod hostname (`user.email = container-<podhex>@home.local`). No workspace id in the email. GitLab is cluster-local; git CLI uses the credential helper (UI password is host `tmp/gitlab_password.md`, not chat). GitHub push uses Secret `github-ssh` (host `secrets/github-ssh/`, gitignored) mounted at `/opt/github-ssh`. Prefer `git push origin main` and `git commit --file …` — this model mangles `-u` / `-m` into `-1`. Do not auto-`git init` / clone / worktree on `+ workspace`; Angela decides inside the jail.
- Browser: one headed browser-use Chromium (shared cookies/history). Each workspace owns a distinct window; agent-browser MCP uses `--session <workspace-id> --pin-tab` so one session cannot drive another workspace's window. Do not call `agent-browser close` (that kills the shared browser).
- Tile **desktop / log / gauges** toggles are independent. Booting pods force the log pane (kubectl `logs -f`, stick-to-bottom). Gauges scrape `/telem` on the in-pod agent (`/proc`, not the glibc mycloud-probe). In-cluster dashboard needs `pods/log` RBAC.
- Browser-use **Snapshot** (toolbar, when a container tile is selected) tars the live Chromium `--user-data-dir` (cookies/logins; browser-use otherwise copies into a random `/tmp/browser-use-user-data-dir-*`). One snapshot at a time, stored as `tmp/browser-use-snapshot.tgz`. New `+ container` pods restore it into `~/.config/browser-use-user-data-dir-live` before Chromium starts (that path name stops browser-use from copying to `/tmp` again). **Clear Snapshot** deletes the tarball. In-cluster dashboard needs `pods/exec` RBAC. Rebuild the **desktop** image after changing the headed launcher.

## Do not

- Put API keys, `.env`, or tokens in chat, docs, or git. `vendor-agent.sh` already excludes them. GitLab's password is `tmp/gitlab_password.md` (gitignored) — do not echo it from `kubectl` or chat.
- Create per-container GitLab users, deploy keys, or SSH `authorized_keys` round-trips.
- Inject GitLab session cookies into browser-use. Log in by hand.
- Rewrite dad-proxy. Point at it.
- Use Docker APIs or `kind load docker-image` here.
- Expect npm `agl-ai` to know `llama-server`.
- Emulate a phone viewport when driving the control room — tiles and capture assume a desktop width (the XFCE session is 1280×800).
