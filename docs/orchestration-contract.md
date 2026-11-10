# Sandbox2 Orchestration API — machine contract (v1)

Machine-facing HTTP API for creating and managing sandbox2 desktops
programmatically. **Consumed by AJCS** (the job controller, batch 3.3 —
"Node integration: sandbox2 orchestration-API client") per
`../psicom/MASTER_PLAN.md` §3.2/§7.1: AJCS treats sandbox2 as a satellite
behind this stable HTTP contract — no raw CLI access, no internals. This
batch is plan §7.1 "Phase 2 — sandbox2 orchestration API", batch 2.1.

Implemented in `web/src/api/orchestration.mjs` (+ `orchestration-validate.mjs`,
`orchestration-volumes.mjs`, `orchestration-reconcile.mjs`, registered in
`web/server.mjs`). Reuses the existing container helpers in
`web/src/api/containers.mjs` (CLI runner, HMAC token scheme, image name).

## Base URL & conventions

- **Loopback-only.** The server binds `127.0.0.1` (c-server refuses other
  hosts). Start with `cd web && bun run server.mjs` — default port **3000**
  (`PORT` env overrides; the README's ":8006" is c-server's standalone default).
- All requests/responses are JSON (`application/json`). No auth on this
  control plane — same trust model as the existing `/api/*` routes
  (single-user loopback; do not expose this port).
- Errors always use the envelope `{ "error": { "code", "message", "details"? } }`.
- Route registration note: this API is registered **before** the `/api/`
  catch-all in `server.mjs` — c-server dispatches in registration order.

## Lifecycle state machine

```
                 ┌────────────────────────────────────────────┐
 POST ──► creating ──► starting ──► cloning ──► ready        │
              │           │ (no repos)     │                  │
              │           │                ▼                  │
              │           │   [poll: /health serving]         │
              │           ▼                                   │
              └────────► error ◄── boot/create/start failure │
                             │ (self-heals to ready on       │
                             ▼  reconcile if daemon serves) │
                          deleted ◄── DELETE (terminal)     │
```

- `creating` — volumes ensured, `container create` running
- `starting` — container starting; no repos → skips straight to readiness
- `cloning` — `git clone` running inside the guest (skipped when `repos: []`)
- `ready` — spacesd `/health` answered 204 (implies `/mcp` reachable on the
  same port)
- `stopped` — container exists but is not running (observed via CLI
  reconcile, e.g. `container stop` run outside this API)
- `error` — **added terminal** (not in the original happy-path list): a
  create/start/readiness failure. Kept visible in GET responses until DELETE
  (diagnostics first); self-heals to `ready` on reconcile if the daemon
  starts serving later. `error.code` ∈ `create_failed | start_failed |
  volume_failed | readiness_timeout | pipeline_error`.
- `deleted` — appears only in the DELETE response body; the sandbox then
  disappears from GET responses (deleted is terminal, record pruned).

Every response includes `state` plus a `transitions` history
(`[{ state, at }]`) in detail/202 bodies.

Note on field naming: the batch sketch listed `status`; this API uses
`state` to match the existing `/api/containers` shape.

## Endpoints

### POST /api/orchestration/sandboxes — create a sandbox

Asynchronous by design (clone + boot can take minutes; HTTP requests must
not): returns **202 Accepted** immediately with the initial record; the
lifecycle advances in the background — poll GET until `state: "ready"`.

Request body (all fields optional; empty body = bare sandbox):

```jsonc
{
  "repos":    [{ "url": "https://github.com/octocat/Hello-World.git", "ref": "master" }],
  "volumes":  [{ "name": "job-artifacts", "mount": "/artifacts", "mode": "rw" },
               { "type": "bind", "path": "/tmp/run-42/evidence", "mount": "/evidence", "mode": "ro" }],
  "resources": { "cpus": 4, "memory": "2048M" }
}
```

- `repos[].ref` — branch or tag (passed to `git clone -b`); omit for the
  remote default branch. Arbitrary SHAs are not supported.
- `volumes[]` — TYPED (see Volumes semantics below): `type: 'volume'`
  (default) needs `name` + `mount`; `type: 'bind'` needs `path` (absolute
  host path) + `mount`. `mode` is `ro` | `rw`, default `rw`, for both.
- `resources.cpus` — integer 1–32 (default 4); `resources.memory` —
  `"2048M"`/`"2G"` style, max 64G (default `2048M`).

```bash
curl -s -X POST http://127.0.0.1:3000/api/orchestration/sandboxes \
  -H 'content-type: application/json' \
  -d '{"repos":[{"url":"https://github.com/octocat/Hello-World.git","ref":"master"}],
       "volumes":[{"name":"job-artifacts","mount":"/artifacts","mode":"rw"}]}'
```

202 response (verified live; `token` included — you created it, you get it):

```json
{
  "id": "sandbox2-ddf94de9",
  "state": "creating",
  "mcpPort": 57677,
  "quicPort": 57678,
  "execPort": 57679,
  "mcpUrl": "http://127.0.0.1:57677/mcp",
  "execUrl": "http://127.0.0.1:57679/mcp",
  "repos": [{ "url": "https://github.com/octocat/Hello-World.git", "ref": "master", "cloned": false }],
  "createdAt": "2026-10-10T19:31:47.964Z",
  "image": "alpine-desktop:spacesd",
  "cpus": 4,
  "memory": "2048M",
  "volumes": [{ "type": "volume", "name": "job-artifacts", "mount": "/artifacts", "mode": "rw", "created": false },
              { "type": "bind", "path": "/tmp/run-42/evidence", "mount": "/evidence", "mode": "ro", "created": false }],
  "token": "64d75d7e…",
  "transitions": [{ "state": "creating", "at": "2026-10-10T19:31:47.964Z" }],
  "updatedAt": "2026-10-10T19:31:47.964Z",
  "error": null
}
```

`volumes[].created` is authoritative once the sandbox leaves `creating`
(`true` = we created the volume now, `false` = it already existed). For
**bind** entries it is **always `false`** — a host path is not a volume this
API creates or owns; the directory must already exist on the host and is
never removed by us (see Volumes semantics). `type` is carried on every
volume entry (additive, contract §15); bind entries additionally carry
`path`. Legacy records persisted before binds read as `type: "volume"`.

`execPort`/`execUrl` point at **execd**, the guest exec MCP server (batch
EXEC-2; contract `execd-contract.md`) — publish-mapped at create exactly like
the spacesd ports. Records created before execd landed carry `execPort: null`
(and `execUrl: null`) — consumers must tolerate the absence.

### GET /api/orchestration/sandboxes — list

Lists sandboxes **created through this API** (the legacy `/api/containers`
list remains the SPA's view of all desktops — orchestration sandboxes appear
on both; the wall is a handy human debugging surface).

```bash
curl -s http://127.0.0.1:3000/api/orchestration/sandboxes
```

```json
{
  "sandboxes": [
    {
      "id": "sandbox2-ddf94de9",
      "state": "ready",
      "mcpPort": 57677,
      "quicPort": 57678,
      "execPort": 57679,
      "mcpUrl": "http://127.0.0.1:57677/mcp",
      "execUrl": "http://127.0.0.1:57679/mcp",
      "repos": [{ "url": "https://github.com/octocat/Hello-World.git", "ref": "master", "cloned": true, "path": "/home/desktop/repos/Hello-World" }],
      "volumes": [{ "type": "volume", "name": "job-artifacts", "mount": "/artifacts", "mode": "rw", "created": true },
                  { "type": "bind", "path": "/tmp/run-42/evidence", "mount": "/evidence", "mode": "ro", "created": false }],
      "createdAt": "2026-10-10T19:31:47.964Z"
    }
  ]
}
```

**No token in list responses, ever** — only the detail endpoint returns it.

### GET /api/orchestration/sandboxes/:id — detail

List-item shape **plus** `token`, `image`, `cpus`, `memory`, `volumes`,
`transitions`, `updatedAt`, `error`. 404 (not_found envelope) when unknown
or already deleted.

```bash
curl -s http://127.0.0.1:3000/api/orchestration/sandboxes/sandbox2-ddf94de9
```

The detail `token` authenticates the **data plane**:

```bash
curl -s -X POST http://127.0.0.1:57677/mcp \
  -H "authorization: Bearer $TOKEN" \
  -H 'content-type: application/json' -H 'accept: application/json, text/event-stream' \
  -d '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-03-26","capabilities":{},"clientInfo":{"name":"ajcs","version":"0"}}}'
# 200 with the right token, 401 with a wrong one (verified live)
```

### DELETE /api/orchestration/sandboxes/:id — stop + delete

Stops and removes the container (join-any-pipeline first). Responds
`200 { id, state: "deleted", volumes: [...] }`; a second DELETE (or an
unknown id) responds `404`. "not found" from the CLI (e.g. someone deleted
it via `container rm`) is treated as success — deletion is the goal.

**Volume semantics: named volumes persist; host bind paths are NEVER touched.**
Deleting a sandbox never deletes volumes; reclaim them explicitly with
`container volume delete <name>` when the artifacts are no longer needed.
Bind entries appear in the response with their `path` and `persisted: true`
in the data-outlives-the-sandbox sense: the host directory was never
sandbox-owned, and delete stops/removes ONLY the container — it never
removes or modifies host paths (verified live).

```bash
curl -s -X DELETE http://127.0.0.1:3000/api/orchestration/sandboxes/sandbox2-ddf94de9
# → {"id":"sandbox2-ddf94de9","state":"deleted",
#    "volumes":[{"type":"volume","name":"job-artifacts","mount":"/artifacts","mode":"rw","persisted":true}]}
```

### GET /api/orchestration/healthz — service health

```bash
curl -s http://127.0.0.1:3000/api/orchestration/healthz
# → {"ok":true,"ready":true,"service":"sandbox2-orchestration","tracked":0}
```

(The server-level `/healthz` from c-server also exists.)

## Error model

`{ "error": { "code", "message", "details"? } }` — all verified live:

| HTTP | code | example |
|---|---|---|
| 400 | `unknown_field` | `{"error":{"code":"unknown_field","message":"Unknown field(s): foo","details":{"fields":["foo"]}}}` |
| 400 | `invalid_field` | `{"error":{"code":"invalid_field","message":"Invalid request body","details":{"errors":["repos[0].url must be an http(s)/git/ssh URL or scp-style spec","volumes[1].name duplicates volumes[0].name ('ok')","volumes[0].path must be an absolute host path without spaces, ':' or ',' (and not '/')"]}}}` |
| 400 | `invalid_json` / `invalid_body` | malformed JSON / non-object JSON |
| 404 | `not_found` | `{"error":{"code":"not_found","message":"No such sandbox: sandbox2-nope0"}}` |
| 405 | `method_not_allowed` | `{"error":{"code":"method_not_allowed","message":"Use GET or POST"}}` (with `Allow` header) |
| 413 | `body_too_large` | body > 256 KB |
| 502 | `upstream_error` | `container rm` failed for a non-not-found reason |
| 500 | `internal_error` | unexpected failure |

Validation is polite: every bad field is reported in one response so AJCS
fixes requests in a single round-trip.

## Port & token conventions

- Per sandbox, allocated dynamically at create (bind-:0-and-close on
  loopback, same trick as the legacy helper):
  - `<mcpPort>:3211/tcp` — spacesd (MCP `/mcp`, gRPC-Web, viewer, media)
  - `<quicPort>:3212/udp` — spacesd QUIC media (native clients only)
  - `<execPort>:3213/tcp` — execd, the guest exec MCP server (batch EXEC-2;
    see `execd-contract.md` — surfaced to callers through the driver facade
    `…/:id/exec/*`, see `mcp-driver-contract.md`)
- Guest eth0 IPs (192.168.64.x) are **not routable from the host**; host
  clients always use `127.0.0.1:<mcpPort>` (or `: <execPort>` for exec). The
  guest-internal URLs are unchanged: spacesd serves `/mcp` on **3211** and
  execd on **3213** inside the guest regardless of the host-side mapping.
- Token: `HMAC-SHA256(web/.cua-secret, containerId)` — deterministic, so it
  survives server restarts without a store, and is recomputed on demand.
  Injected into the container as `CUA_ENV_TOKEN` at create; never persisted
  in the state file; **never returned in list responses**; returned by the
  detail endpoint (and the 202 create response) for the caller that created
  the sandbox.
- Data-plane auth on `/mcp`: `Authorization: Bearer <token>` (the gRPC-Web
  plane uses `x-cua-env-authorization: Bearer <token>` — see
  `web/src/api/spacesd.mjs`).

## Repos semantics

- Cloned **inside the guest** after start (`git` is baked into the image),
  sequentially, into **`/home/desktop/repos/<name>`** (name derived from the
  URL basename, sanitized to `[A-Za-z0-9._-]`, `-2` suffixed on collision).
  `repos[].path` carries the guest-absolute path for later stages.
- **Clones run as the `desktop` user** (`container exec -u desktop` with
  `HOME=/home/desktop` so git finds its global config) — NOT root. This fixed
  the smoke's invisibility bug: `/root` is 0700 and invisible to the session
  user (the agent only survived it via discovered NOPASSWD sudo). The
  entrypoint pre-creates `/home/desktop/repos` (desktop-owned) and writes
  `/home/desktop/.gitconfig` (`user.name`/`user.email`/`init.defaultBranch`),
  so agents never juggle `-c user.name/email` flags.
- Clones are prompt-proofed (`GIT_TERMINAL_PROMPT=0` + null askpass) and
  bounded by a 180 s wall-clock per exec — a hung clone records as a failed
  clone instead of wedging the pipeline.
- The repo **URLs are unchanged** by this fix — only the in-guest destination
  and exec user moved from `/root` + root to `/home/desktop` + desktop.
- A failed clone does **not** fail the sandbox — it becomes `ready` with
  `repos[i].cloned: false` and `repos[i].error` (trimmed CLI stderr). AJCS
  decides per-repo.
- Transient "container not running" right after start is retried a few
  times (`container start` returns before init accepts execs).
- **Network caveat:** the guest can reach the internet and the host bridge
  IP `192.168.64.1`, but **not the host's loopback** — a repo URL like
  `http://127.0.0.1:…` (e.g. a loopback-only AVCS `b-gitserve`) will fail
  inside the guest. Either bind the git service on `192.168.64.1` too, or
  use a publicly reachable URL.
- Private repos need credentials embedded in the URL (e.g.
  `https://user:token@host/…`) or a credential helper in the guest. Note:
  URLs are echoed/stored verbatim in responses and the state file — prefer
  not embedding long-lived secrets.

## Volumes semantics

`volumes[]` entries are **typed** (idea #22 / RCA-1, psicom MASTER_PLAN
§7.3): `type: 'volume'` (default) or `type: 'bind'`. Both accept `mode`
(`ro` | `rw`, default `rw`).

### Named volumes — `type: 'volume'` (default)

- Schema: `{ "name", "mount", "mode" }` — `name` must match
  `[A-Za-z0-9][A-Za-z0-9_.-]{0,63}`. An explicit `type: "volume"` is
  accepted and recommended for self-describing payloads.
- Ensured idempotently at create (Apple's CLI errors "already exists" for
  pre-existing volumes — treated as success; `created: false` → `true` in
  responses).
- Persist across sandbox delete (and across server restarts) until
  `container volume delete <name>`. Use them for cross-stage/cross-sandbox
  shared state (artifacts, caches).

### Host-path bind mounts — `type: 'bind'`

- Schema: `{ "type": "bind", "path", "mount", "mode" }` — `path` is the
  HOST-absolute directory (relative paths are rejected; so are spaces,
  `:`, and `,` — the latter would corrupt the comma-separated `--mount`
  format — and `/` itself). The directory must already exist on the host;
  it is NOT created, written, or removed by this API.
- **Execution:** `container create --mount
  type=bind,source=<path>,target=<mount>[,readonly]` — `mode: 'ro'`
  appends `,readonly`, `mode: 'rw'` omits it. All volume options ride
  BEFORE the image (OPTIONS-BEFORE-TARGET — the same lesson as the exec
  `GIT_TERMINAL_PROMPT` fix). Named volumes keep `-v name:mount:mode`.
- **Semantics: a bind is a view of a host-owned directory mounted into the
  guest — not persistent storage this API owns.** `created` is always
  `false` for binds (no volume lifecycle), and sandbox DELETE never
  touches the host path (it stops/removes only the container).
- **Duplicate-mount rejection spans kinds:** the same `mount` on a named
  volume AND a bind (or two binds) is rejected at validation — Apple's
  create fails with "The storage device attachment is invalid" for
  duplicate attachments regardless of kind. Duplicate `name`s stay a
  volume-only rule (binds have no name).
- **The evidence hand-off use case (idea #22 / RCA-1, for the
  scr-rca-hourly v2 layout):** a HOST stage (e.g. `collect`) writes its
  evidence directory; the following agent-stage sandbox mounts it
  READ-ONLY: `volumes: [{ "type": "bind", "path":
  "/abs/run/evidence", "mount": "/evidence", "mode": "ro" }]`. The guest
  can read everything and cannot alter the evidence; host tooling keeps
  full control. Write the run's durable record host-side — the guest (and
  the bind) die with the sandbox, the host dir does not.
- **Verified live (2026-10-11, container CLI 1.5.0, `alpine-desktop:spacesd`):**
  RO bind → guest `mount` shows `virtiofs on /evidence type virtiofs
  (ro,relatime)`; `cat` of a host canary file works through the exec
  facade; `echo x > /evidence/blocked.txt` fails with "Read-only file
  system" (exit 1) and no file appears host-side; the same path mounted
  `rw` accepts a guest write that lands on the host byte-for-byte; after
  both sandboxes are DELETEd the host canary is byte-identical
  (sha256-verified) and `container inspect` shows the mounts with
  `options: ["ro"]` vs `options: []`. `container inspect <id>` reports
  binds under `configuration.mounts` as
  `{ destination, source, options, type: { virtiofs: {} } }`.
- Guest-side ownership note (observed): the exec facade's bash runs as the
  `desktop` user and Apple maps host ownership into the guest so that
  user sees/reads the mounted files; make the host dir group/other-writable
  (e.g. `chmod 0777`) when a guest `rw` write must land from a differently
  mapped user — `ro` enforcement is at the virtiofs mount layer and does
  not depend on host permissions.

## Restart & reconcile behavior

- State lives in `web/tmp/orchestration-state.json` (gitignored; tokens
  never persisted). On server restart, records reload and are reconciled
  against the container CLI: running + `/health` ok → `ready`; running +
  not serving → `starting`; stopped → `stopped`; missing → pruned
  (externally deleted) — except `error` records, kept for diagnostics until
  DELETE. If `container ls` itself fails, last-known state is served and
  nothing is pruned.
- `container ls` omits stopped containers, so stopped-vs-deleted is
  distinguished via `container inspect`.

## AJCS integration note (batch 3.3)

Suggested flow per job stage: `POST` (repos = stage inputs, volume = stage
artifacts) → poll `GET /sandboxes/:id` until `ready` (or `error`) → read
`mcpUrl` + `token` from the detail → drive the guest (deterministic MCP
driver = batch 2.2, or a pi agent session) → `DELETE` at stage end (artifacts
stay in the named volume; reclaim with `container volume delete` when the
run is archived). Treat `id` as opaque; treat `state`/`error.code` as the
machine-readable outcomes; `transitions` is for logs/debugging.

**Evidence hand-off across stages (idea #22 / RCA-1):** when a stage runs on
the HOST (e.g. a `collect` shell stage), it writes its outputs into a
per-run host directory; the following agent-stage sandbox mounts that
directory READ-ONLY via a bind volume (`type: 'bind'`, `mode: 'ro'`) — see
Volumes semantics. AJCS keeps the durable record host-side (the guest is
transient; the bind disappears with it, the host dir does not). Named
volumes remain the tool for cross-stage state that must SURVIVE sandbox
recycling; binds are the tool for host-owned evidence a guest must read but
never modify.

## Known limitations (v1)

- Create is async (202 + poll) — no synchronous wait mode.
- No per-clone timeout; a hung clone is bounded by DELETE (stop kills the
  exec) rather than by a timer.
- No auth on the control plane (loopback trust model, same as `/api/*`).
- Repo refs are branch/tag names only (`git clone -b`); no SHA/PR refs.
- Guest cannot reach host-loopback services (see Repos semantics).
- Deleting a sandbox does not delete its named volumes (by design) and
  never touches bind host paths (by design — binds are host-owned views,
  not API-managed storage).
- Bind `path`s are not created, validated-for-existence, or cleaned up by
  the API — the caller owns the host directory lifecycle; a missing source
  surfaces as a create-time CLI failure (`create_failed`).

## Delta — the `backref` field (2026-10-14; SANDBOX-LINK wave, idea: 3-way doubly-linked chips)

The create payload gains an OPTIONAL `backref` object — a caller-owned
human-facing cross-reference (who spawned this sandbox, and where to go back
to). The orchestration plane treats it as OPAQUE data: it never acts on it,
never follows its url, and its only behaviors are validate → store → echo.

```json
POST /api/orchestration/sandboxes
{
  "repos": [],
  "volumes": [],
  "backref": {
    "system": "ajcs",
    "kind": "run",
    "id": "54",
    "label": "scr-smoke #2",
    "url": "http://127.0.0.1:8483/runs/54"
  }
}
```

Field rules (validated at create; a malformed `backref` is a `400
validation_error` like every other bad field):

- `backref` — optional object. Absent ⇒ the record carries no backref and
  every echo omits the field (never `null` — absence is the shape).
- `system` — required string, `[a-z][a-z0-9_-]*`, ≤ 32 chars (e.g. `ajcs`).
- `kind` — required string, `[a-z][a-z0-9_-]*`, ≤ 32 chars (e.g. `run`).
- `id` — required string, 1–128 chars, no whitespace (opaque caller id).
- `label` — required string, 1–128 chars (the chip's display text).
- `url` — required string, must be an `http(s)://` URL, ≤ 2048 chars.
- Unknown fields inside `backref` are rejected (same politeness as the rest
  of the validator — every bad field reported in one response).

Echo surfaces:

- `POST` (202), `GET …/sandboxes` (list items) and `GET …/sandboxes/{id}`
  (detail) each gain `backref` on records that carry one (verbatim as
  stored). List items already omit `token`; `backref` is non-secret and
  rides list responses too — the SPA's box wall renders the back-link chip
  straight off its existing `/api/containers` poll.

`/api/containers` join (the SPA's own poll): items whose id matches a
persisted orchestration record gain the same `backref` object. CLI-derived
boxes with no orchestration record are unchanged (no backref key).

AJCS stamps it at provision time (`system: 'ajcs'`, `kind: 'run'`, the run
id, a `{job} #{number}` label, and the deep link into the ajcs a-ui) —
see the ajcs developer contract's SANDBOX-LINK delta. The reverse chip on
the sandbox wall reads exactly this field.
