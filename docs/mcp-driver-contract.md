# Sandbox2 MCP driver — machine contract (v1)

Deterministic, LLM-free tool execution for **AJCS** (the job controller):
an HTTP façade over a sandbox's spacesd `/mcp` (Streamable-HTTP JSON-RPC)
endpoint. This is plan §7.1 "Phase 2", **batch 2.2**, built on the sandbox
lifecycle + token conventions of `orchestration-contract.md` (batch 2.1 —
read that first; this document does not restate the lifecycle).

**ONE driver mechanism, two callers.** Both speak to the same sandbox `/mcp`:

```
agent session (pi)  ── LLM-decided calls ──────►  POST 127.0.0.1:<mcpPort>/mcp
AJCS (Jobfile)      ── Jobfile-decided calls ──►  /api/orchestration/…/mcp/*   ──►  (this driver) ──►  spacesd /mcp
AJCS (Jobfile)      ── shell/exec steps ───────►  /api/orchestration/…/exec/*  ──►  (this driver) ──►  execd /mcp (guest :3213)
```

Implemented in `web/src/api/mcp-driver.mjs`, registered in `web/server.mjs`
ahead of the orchestration entry and the `/api/` catch-all (its route match
claims only `/api/orchestration/sandboxes/:id/{mcp,exec}/*`; every other
orchestration path falls through to the 2.1 handler unchanged).

## Determinism contract

- **No conversation, no sampling, no LLM.** The driver never generates
  content; it relays one JSON-RPC request and returns one JSON-RPC response.
  One HTTP call = one MCP operation.
- **Stateless.** The driver holds NO session state beyond the HTTP request:
  no session table, no cookies, no per-sandbox MCP handles. Two identical
  requests are independent.
- **Initialize handshake is per-request** (not cached per sandbox). Each
  driver request performs: `initialize` → (if the server issued an
  `Mcp-Session-Id`) `notifications/initialized` → the operation; the session
  id is then dropped. **Why per-request:** (a) the objective requires zero
  session state beyond the HTTP request; (b) spacesd revokes transport
  sessions on `daemon_restart`/`session_end` (visible in its
  `enforcement_adapters` metadata), so a cached session id would need
  invalidation + fallback re-init logic anyway; (c) the cost is 2–3 extra
  loopback POSTs (~sub-millisecond each) — negligible next to tool execution;
  (d) it works identically against stateless servers (spacesd today) and
  spec-strict stateful ones.
- **No internal retries.** `tools/call` is not idempotent (a silent retry
  could double-fire a click); the driver sends the operation exactly once.
  Retrying is the CALLER's decision — see "Timeouts & idempotency".

### Live-verified spacesd behavior (2026-10-10, `alpine-desktop:spacesd`)

Probed against a real ready sandbox (two sandboxes, full handshake matrix):

| Probe | Result |
|---|---|
| `tools/list` with NO initialize | **200** with `result.tools` — spacesd does not require initialize, and issues `Mcp-Session-Id` on every POST |
| `initialize` | 200 (`protocolVersion`, `capabilities`, `serverInfo`, `instructions`) + `Mcp-Session-Id` |
| `notifications/initialized` | **202**, empty body |
| `tools/call` (list_apps) | 200, `result.content[]` + `result.structuredContent` |
| unknown TOOL (`definitely_not_a_tool`) | 200 with `result.isError: true`, content `Permission denied: tool … has no reviewed risk classification`, `structuredContent.code: "permission_denied"` |
| schema-violating arguments (`click` with `{}`) | 200 with `result.isError: true`, `structuredContent.code: "tool_invocation_failure"` |
| unknown METHOD (`driver/bogus`) | 200 with JSON-RPC **error** `-32601 "Unknown method: …"` |
| `tools/call` missing tool name | 200 with JSON-RPC **error** `-32602 "Invalid params: missing tool name"` |
| wrong bearer token | **401** `missing or invalid bearer token` |
| `GET /mcp` | **405** (POST-only transport) |
| `Accept: application/json` alone | 200 — plain-JSON responses; SSE is never required in Accept |

Tool surface: **59 tools**, all GUI/browser automation + observation
(`list_apps`, `list_windows`, `click`, `type_text`, `press_key`, `hotkey`,
`scroll`, `clipboard_*`, `get_accessibility_tree`, `get_desktop_state`,
`browser_*`, `start/stop_recording`, session tools, …). Each carries
`annotations` (`readOnlyHint`, `idempotentHint`, `destructiveHint`),
`risk`, and `capabilities` metadata — the driver passes all of it through
verbatim (AJCS should read `annotations.idempotentHint` to set retry policy).
**spacesd itself ships no exec/shell tool in this build** — images WITH
execd serve the shell through the sibling exec facade below; for
execd-disabled images the GUI-surface note in the AJCS integration section
remains the legacy fallback.

## Endpoints

All under the 2.1 base (`http://127.0.0.1:3000`, loopback-only, JSON in/out,
no auth on the control plane — same trust model as batch 2.1). The driver
mints the per-sandbox data-plane token itself (`HMAC(web/.cua-secret, id)`,
recomputed per request); **the caller never sees or handles a token**.

Gate (all endpoints, both facades): unknown id → `404 not_found`; record
state ≠ `ready` → `409 sandbox_not_ready`; a ready-recorded sandbox whose
`/health` stopped serving → `409` with `details.healthOk: false` (poll the
2.1 `GET detail`, which reconciles state). The exec facade adds one gate
check: a record with `execPort: null` (pre-execd record or execd-disabled
image) → `409 sandbox_not_ready` with `details.execUnavailable: true`,
checked before the health probe. Gate errors are returned BEFORE body
validation (resource-first precedence).

### GET /api/orchestration/sandboxes/:id/mcp/tools

Proxy of `tools/list`. Returns the tool descriptors verbatim (name,
description, inputSchema — plus annotations/outputSchema/risk/capabilities
when the server provides them).

```bash
curl -s http://127.0.0.1:3000/api/orchestration/sandboxes/sandbox2-ddf94de9/mcp/tools
```

```jsonc
{
  "ok": true,
  "tools": [
    {
      "name": "list_apps",
      "description": "List Linux apps — both currently running and installed-but-not-running…",
      "inputSchema": { "type": "object", "properties": { "session": { "type": "string" } }, "additionalProperties": false },
      "annotations": { "readOnlyHint": true, "idempotentHint": true, "destructiveHint": false, "openWorldHint": false },
      "risk": { "class": "r2", "enforcement": "active" },
      "capabilities": ["app.list"]
    }
    // … 58 more in the current image
  ]
}
```

(Trimmed for readability; the driver does not filter or reshape tool
objects. An empty `tools: []` is a valid 200.)

### POST /api/orchestration/sandboxes/:id/mcp/tools/:name

Proxy of `tools/call`. Body: `{ "arguments": { … } }` — `arguments` optional
(defaults `{}`); no other top-level fields.

- **Tool error** (`result.isError: true`) → **HTTP 200** `{ok:true, result:{…}}`
  — the CALL succeeded; the TOOL may have failed. Inspect `result.isError` /
  `result.structuredContent`.
- **JSON-RPC refusal** (unknown tool name, malformed params — server answers
  with an `error` object) → **400 `upstream_rejected`** with the protocol
  error passed through in `details.jsonrpc` (caller-fixable).

```bash
curl -s -X POST http://127.0.0.1:3000/api/orchestration/sandboxes/sandbox2-ddf94de9/mcp/tools/list_apps \
  -H 'content-type: application/json' -d '{}'
```

```jsonc
// 200 (verified live; trimmed)
{
  "ok": true,
  "result": {
    "content": [{ "type": "text", "text": "✅ Found 21 app(s): 20 running, 1 installed-not-running.\n- start-desktop (pid 1)…" }],
    "isError": false,
    "structuredContent": { "apps": [{ "name": "start-desktop", "pid": 1, "running": true, "active": false, "windows": [] /* … */ }] }
  }
}
```

Tool-name constraint: `^[A-Za-z0-9._-]{1,128}$` (URL-expressible). Anything
exotic → use `/mcp/rpc`. Bad name → `400 invalid_field` before any upstream
traffic. Names may be percent-encoded (`/mcp/tools/%6C%69%73%74%5F%61%70%70%73`).

## Exec facade — guest execd (batch EXEC-2)

The sibling facade targets **execd** (`record.execPort` → guest **:3213**),
the one-tool guest exec MCP server documented in `execd-contract.md` — the
agent's real hands; spacesd stays the observation surface. Same determinism
contract, same per-request handshake (execd speaks the same minimal
JSON-RPC subset), same token minting (the guest validates the SAME
`CUA_ENV_TOKEN` spacesd uses), same `MCP_DRIVER_TIMEOUT_MS` deadline — only
the upstream port and error labels differ (`execd unreachable: …`).

```
GET  /api/orchestration/sandboxes/:id/exec/tools       proxy of execd tools/list
POST /api/orchestration/sandboxes/:id/exec/tools/bash  proxy of tools/call {arguments:{command,…}}
POST /api/orchestration/sandboxes/:id/exec/rpc         arbitrary JSON-RPC passthrough (escape hatch)
```

### GET /api/orchestration/sandboxes/:id/exec/tools

Proxy of execd `tools/list` — exactly one tool today, passed through
verbatim:

```jsonc
{
  "ok": true,
  "tools": [{
    "name": "bash",
    "description": "Run a shell command inside the sandbox (pi bash semantics)",
    "inputSchema": { "type": "object", "properties": {
      "command": { "type": "string" }, "timeout": { "type": "number" }, "cwd": { "type": "string" }
    }, "required": ["command"] }
  }]
}
```

### POST /api/orchestration/sandboxes/:id/exec/tools/bash

Proxy of `tools/call` for the one tool; body `{ "arguments": { … } }` —
`arguments` optional (defaults `{}`); no other top-level fields.

```bash
curl -s -X POST http://127.0.0.1:3000/api/orchestration/sandboxes/sandbox2-ddf94de9/exec/tools/bash \
  -H 'content-type: application/json' \
  -d '{"arguments":{"command":"cd ~/repos/Hello-World && git status --short","timeout":30}}'
```

```jsonc
// 200 — pi-parity result (see execd-contract.md for the full schema):
{
  "ok": true,
  "result": {
    "content": [{ "type": "text", "text": " M notes.md\n" }],
    "structuredContent": { "output": " M notes.md\n", "truncated": false,
                           "exit_code": 0, "wall_time_seconds": 0.08 },
    "isError": false
  }
}
```

Same HTTP-200-for-tool-error rule as the GUI facade: a non-zero exit, a
group-killed timeout, or a missing cwd arrives as `result.isError: true` +
`structuredContent.exit_code` — the CALL succeeded, the COMMAND failed. A
**504 is genuinely unknown-outcome** (the request was delivered; a timed-out
exec may still have executed) — never blind-retry shell steps.

### POST /api/orchestration/sandboxes/:id/exec/rpc

Same escape-hatch semantics as `/mcp/rpc` against execd: notifications →
**202** `{ok:true}`; `initialize`/`notifications/initialized` skip the
driver's handshake; a JSON-RPC error → **400 `upstream_rejected`** with
`details.jsonrpc` passthrough.

### Sandbox readiness vs execd liveness

The exec gate still proves the SANDBOX via spacesd `/health` (one guest, one
liveness signal, probed on `record.mcpPort` as for the GUI facade). If
execd itself dies while spacesd stays healthy, the facade answers **502
`upstream_error`** ("execd unreachable") — execd is best-effort like
spacesd; recreate the stage sandbox.

### POST /api/orchestration/sandboxes/:id/mcp/rpc

Escape hatch: arbitrary JSON-RPC passthrough for methods the dedicated
endpoints don't model. Body:

```jsonc
{
  "method": "tools/call",           // required: string, non-empty, no whitespace, ≤200 chars
  "params": { … },                  // optional; passed through VERBATIM (omitted stays omitted)
  "id": "job-stage-1-call-7"        // optional: number|string; default 1; null → JSON-RPC notification
}
```

- Request → **200** `{ok:true, result:{…}}`; JSON-RPC error → **400
  `upstream_rejected`** (details.jsonrpc passthrough).
- Notification (no `id`, or explicit `"id": null`, or any
  `notifications/*` method — those are always forwarded without an id) →
  forwarded as a JSON-RPC notification → **202** `{ok:true}`.
- `initialize` / `notifications/initialized` are passed through WITHOUT the
  driver's own handshake (the caller is managing the handshake itself).

```bash
curl -s -X POST http://127.0.0.1:3000/api/orchestration/sandboxes/sandbox2-ddf94de9/mcp/rpc \
  -H 'content-type: application/json' \
  -d '{"method":"tools/call","params":{"name":"get_screen_size","arguments":{}},"id":"stage2-probe"}'
```

## Error model

Same envelope as batch 2.1: `{ "error": { "code", "message", "details"? } }`.

| HTTP | code | when |
|---|---|---|
| 400 | `invalid_json` / `invalid_body` | malformed / non-object JSON body |
| 400 | `unknown_field` | body has fields outside the endpoint's schema (`details.fields`) |
| 400 | `invalid_field` | bad tool name / `arguments` not an object / rpc `method`+`params`+`id` violations (`details.errors`) |
| 400 | `upstream_rejected` | spacesd answered the operation with a JSON-RPC error (`details.jsonrpc.{code,message}`) — caller-fixable |
| 404 | `not_found` | unknown sandbox id or unknown sub-resource |
| 405 | `method_not_allowed` | wrong method (+ `Allow` header) |
| 409 | `sandbox_not_ready` | record state ≠ ready, ready-recorded but `/health` not serving (`details.{sandboxId,state,healthOk?}`), or exec facade on a pre-execd record (`details.execUnavailable: true`) |
| 413 | `body_too_large` | body > 256 KB |
| 502 | `upstream_error` | upstream unreachable / non-200 / unparseable / 401 on the minted token (secret rotated after create → recreate the sandbox) — `details.{sandboxId,state,method}`; error text names the daemon (spacesd or execd) |
| 504 | `upstream_timeout` | operation exceeded the deadline — **outcome unknown** (see below) |
| 500 | `internal_error` | unexpected failure |

## Timeouts & idempotency

- `MCP_DRIVER_TIMEOUT_MS` env — **overall upstream budget per driver request**
  (handshake + operation), default **30000 ms**. Exceeding it → `504
  upstream_timeout` (`details.method`).
- **On 504 the tool may still have executed** — the request was delivered and
  the answer was lost. AJCS must NOT blind-retry non-idempotent tools after a
  504; reconcile via a read-only tool or recreate the stage.
- Retry policy signal: `GET …/mcp/tools` returns each tool's
  `annotations.idempotentHint` / `readOnlyHint` verbatim — consult them
  before re-issuing a failed call. Read-only+idempotent tools may be retried;
  others need stage-level recovery.
- Driver-side sequencing is at-most-once per HTTP request (no internal
  retries); the handshake is idempotent per request by construction.

## Security

- The data-plane token is minted internally per request
  (`containers.containerToken`) and sent as `Authorization: Bearer …` to
  spacesd only. It is **never** persisted, logged, or included in any
  response/error body (covered by tests).
- Loopback-only, no control-plane auth — identical trust model to 2.1; do
  not expose the port.

## AJCS integration note — "traditional" stage (Jobfile-driven)

Suggested per-stage flow (batch 3.3 consumes this):

1. `POST /api/orchestration/sandboxes` (stage inputs as repos, artifacts as
   named volume) → poll `GET /sandboxes/:id` until `ready`/`error`.
2. `GET …/mcp/tools` once per stage to discover the tool surface (AJCS may
   cache the descriptors for the duration of the STAGE — the driver itself
   caches nothing).
3. Drive the stage: one `POST …/mcp/tools/:name` per Jobfile-decided action,
   inspecting `result.isError` per call.
4. `DELETE /sandboxes/:id` at stage end (named volumes persist).

**Jobfile `shell:` steps** map to the guest shell through the **exec
facade**: `POST …/exec/tools/bash` with `{ "arguments": { "command": "…",
"cwd": "…", "timeout": N } }` — execd-enabled images serve `bash` there
(batch EXEC-2; the per-request handshake, minted token, and deadline all
apply unchanged). For sandboxes with `execPort: null` the facade answers 409
`execUnavailable` and the legacy fallback applies — one honest caveat
verified live on 2026-10-10: **the execd-less `alpine-desktop:spacesd` GUI
surface ships NO exec/shell tool** (all 59 spacesd tools are
GUI/browser/observation):

- The closest primitive is `launch_app` (`launch_path` + `additional_arguments`
  — "spawned directly via the system shell" per its schema), but it returns no
  stdout/exit-code, so it is fire-and-forget: usable for "start the server,
  then verify with get_desktop_state/list_apps", not for capturing command output.
- Guest-side shell that AJCS needs in that legacy case (git cloning etc.)
  runs through the 2.1 create-pipeline (`container exec` inside the
  lifecycle), not through MCP.
- The GUI facade stays deliberately tool-agnostic: if a custom MCP server is
  ever baked into an image WITHOUT execd, a `shell: "…"` step maps 1:1 to
  `POST …/mcp/tools/<exec-tool>` with
  `{ "arguments": { "command": "…", "cwd": "…" } }` — no driver change — and
  `/mcp/rpc` covers any other future method in the meantime.

## Known limitations (v1)

- Driver scope is sandboxes created through the 2.1 orchestration API (state
  file); legacy `/api/containers` desktops are not drivable (404).
- Gate uses the persisted record + a `/health` probe (1s), not a full CLI
  reconcile — a record can be briefly stale right after external
  `container stop`/`rm`; the next 2.1 `GET detail` reconciles it.
- Responses are plain JSON; an SSE-framed reply is parsed defensively, but
  streaming (progress notifications mid-call) is not surfaced.
- `notifications` via `/mcp/rpc` are fire-and-forget (202); no delivery ack.
- **OPEN ISSUE — live-smoke busy-wait under `bun test` (for the integrator):**
  running the opt-in live smoke (`MCP_DRIVER_LIVE=1 bun test
  test/mcp-driver.test.mjs`) hung with ~98.5% CPU for ~4.5 min and had to be
  killed. Evidence gathered from the abandoned run's persisted state file:
  the 2.1 pipeline itself COMPLETED — `creating 19:48:46 → starting
  19:48:47 → ready 19:48:53` (≈7 s) — so the readiness poll
  (`web/src/api/orchestration.mjs:315` `awaitReadiness`, 500 ms timer sleep
  via `sleep(BOOT_POLL_MS)`, bounded by `BOOT_DEADLINE_MS`) and the test's
  own poll loop (`web/test/mcp-driver.test.mjs:464-472`, 1 s timer sleep)
  are NOT spin loops; "missing sleep between readiness polls" is disproven
  by the record. The hang+CPU burn started AFTER `ready`, in the test's
  observation loop or the driver's first real `fetch` to spacesd — both
  plain bun-`fetch` paths that provably worked seconds earlier during the
  pipeline's probes, so the prime suspect is a bun-test-runtime quirk (fetch
  + AbortController + keep-alive under the harness); the driver's 30 s
  deadline should have converted a hung fetch into a 504 but did not, which
  points at the abort signal not unsticking bun's fetch, or the hang sitting
  in the orchestration GET path (whose `container ls` spawn has no deadline).
  The "state file stayed empty" observation was a path mix-up: the test
  redirects `ORCHESTRATION_STATE_FILE` to a mkdtemp dir
  (`/var/folders/.../mcp-driver-test-tQMHcG/state.json`), which DID contain
  the ready `sandbox2-d0ca0c36` record. Bun's test-timeout kill also skipped
  the live smoke's `finally` teardown, which is how the stray container
  escaped (manually removed after the fact). Recommended follow-ups: run the
  live smoke as a plain `bun run`/node script instead of inside `bun test`,
  and/or `sample` the bun process during a reproduction; keep the smoke
  opt-in until resolved. The mocked suite (default) is unaffected.
- All other 2.1 limitations (async create, no control-plane auth, guest
  loopback isolation, persistent named volumes) apply unchanged.
