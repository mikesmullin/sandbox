# execd — guest exec MCP server (machine contract, v0.2)

A small MCP server **inside the sandbox image** exposing THREE tools — `bash`,
`read`, `write` — with **pi-harness semantics** (pi-coding-agent
`dist/core/tools/{bash,read,write}.js`).
It is the agent's real hands; spacesd `/mcp` (59 GUI tools) remains the
observation surface. Motivation: the smoke live-fire proved agents CANNOT
use the GUI terminal efficiently (no exec tool; AT-SPI exposes no terminal
text; background keyboard delivery unavailable) — see
`../psicom/MASTER_PLAN.md` journal 2026-10-11.

Implemented in `desktop/execd/index.mjs` (Bun, ~shipped in the image at
`/opt/execd/index.mjs`), started by `desktop/entrypoint.sh` **as the
`desktop` user, after `desktop.env` is written** — children inherit the
session env (DISPLAY, DBUS_SESSION_BUS_ADDRESS, XDG_RUNTIME_DIR) naturally.
Guest port **3213** (3211 = spacesd, 3212 = QUIC).

0.2 adds a second transport, **stdio** (see *Transport: stdio (0.2)* below):
the SAME three-tool server over stdin/stdout, so the HOST (AJCS HOST agent
stages) can spawn it as its own child — no ports, no bearer token, no
host-daemon lifecycle to own. serverInfo stays **0.2.0** (a transport, not a
new tool set).

## Tool: `bash` — pi parity (unchanged in 0.2)

```
name: "bash"
inputSchema: {
  command: string            (required — shell command to execute)
  timeout?: number           (SECONDS, optional, NO default timeout; max 2^31/1000-1)
  cwd?: string               (optional working directory; default /home/desktop)
}
result.content[0].text  — bounded output view (see truncation) or error text
result.structuredContent: {
  output: string             (combined stdout+stderr, bounded 1 MiB for programmatic callers)
  truncated: boolean
  full_output_path?: string  (guest path of the FULL output file, present only when truncated)
  exit_code: number          (128+sig convention on signal death)
  wall_time_seconds: number
}
result.isError: true        — when exit_code !== 0, timeout, or spawn failure (mirrors pi: an
                              error result for the model; the CALL still succeeded at transport level)
```

Execution semantics (copied from pi):

- **One-shot** `spawn(bash, ['-c', command])` — stdin `'ignore'`; no persistent
  session; each call is independent (pi parity).
- **`detached: true`** — the child is its own process-group leader; on timeout
  or shutdown the **whole group** is SIGKILLed (`process.kill(-pid, 'SIGKILL')`
  — pi's `killProcessTree`). A timed-out command kills its descendants; nothing
  outlives the call except explicitly-daemonized survivors.
- **Timeout**: optional per-call SECONDS; **no default** (composes with AJCS
  per-step budgets — no enforced defaults, per no-retry doctrine §4). On
  timeout: group-killed, `isError: true`, text appends
  `Command timed out after N seconds`, partial output included.
- **Output accumulation**: stdout+stderr interleaved in arrival order
  (same as pi: both piped to one accumulator). Bounded view =
  **last 2000 lines / 50 KB** (pi `DEFAULT_MAX_LINES`/`DEFAULT_MAX_BYTES`):
  head+tail with a `…N chars truncated…` elision marker; when truncated the
  FULL output streams to a guest temp file (`/tmp/execd-output-*.txt`) and
  `full_output_path` is returned. The agent can `head/tail/grep` it with a
  follow-up `bash` call.
- **Exit codes**: child exit code verbatim; killed-by-signal → `128 + signal`.
  Non-zero → `isError: true` + text appends `Command exited with code N`.
- **cwd**: optional; the default resolves via the chain **`args.cwd` →
  `EXECD_DEFAULT_CWD` → `os.homedir()` → `/home/desktop`** (0.2: the homedir
  rung is new for host-spawned stdio — in-guest the desktop user's homedir IS
  `/home/desktop`, so guest behavior is unchanged; AJCS sets
  `EXECD_DEFAULT_CWD`; a bare host-spawned stdio process falls back to the
  spawning user's home); a nonexistent cwd is a clean
  tool error (`Working directory does not exist: <path>` — pi parity).
- **env**: the execd process env (session env, inherited from the entrypoint)
  + per-call nothing (v0 keeps the surface minimal).

## Tools: `read` + `write` — pi parity (0.2)

Server version bumps to **0.2.0**; `tools/list` → exactly
`[bash, read, write]` (bash keeps index 0). Path resolution for both tools
uses the SAME default-cwd chain as bash (`args.cwd` does not exist on these
tools → `EXECD_DEFAULT_CWD` → `os.homedir()` → `/home/desktop`) with pi
`resolveToCwd`
semantics: unicode-space normalization (`\u00A0`, `\u2000–\u200A`, `\u202F`,
`\u205F`, `\u3000` → space), `@` prefix strip, `~` / `~/…` expansion
(`os.homedir()` of the execd process — the `desktop` user in-guest),
`file://` URL conversion, then `path.resolve` against the default cwd (NO
realpath — resolved ≠ physical). Extra/unknown arguments are ignored (pi
parity — schemas validate declared params only).

### `read`

```
name: "read"
inputSchema: {
  path: string              (required — "Path to the file to read (relative or absolute)")
  offset?: number           ("Line number to start reading from (1-indexed)")
  limit?: number            ("Maximum number of lines to read")
}
result.content[0].text  — file text (bounded, see below) or the raw error message
result.structuredContent (success only): {
  path: string               (resolved ABSOLUTE path — pi resolveToCwd output, not realpathed)
  total_lines: number        (text.split('\n').length — a trailing newline contributes a
                              phantom final element; pi arithmetic, kept EXACTLY)
  truncated: boolean         (truncateHead fired: >2000 lines or >50KB in the selected window)
  size_bytes: number         (file size in bytes)
}
result.isError: true + NO structuredContent — access/read failures carry the RAW error
  message (e.g. "ENOENT: no such file or directory, access '/x'", "EACCES: …",
  "EISDIR: illegal operation on a directory, read")
```

Semantics (copied from pi read.js):

- **Read variants** (`resolveReadPathAsync` parity): when the resolved path
does not exist, try pi's macOS fallbacks IN ORDER — AM/PM
narrow-no-break-space (`\u202F` before ` AM.`/` PM.`), NFD normalization,
curly quote (`'` → `\u2019`), NFD+curly — and use the first that exists;
else keep the resolved path (the error then names it).
- **Access check**: `access(path, R_OK)` first; failure → isError + raw
message. Read/decode failures surface the same way (directories pass the
access check and fail the read with EISDIR).
- **Line arithmetic (pi EXACT)**: `allLines = text.split('\n')`;
`offset` is 1-indexed (`startLine = offset ? max(0, offset-1) : 0`).
`offset` beyond EOF → isError, text EXACTLY
`Offset <offset> is beyond end of file (<allLines.length> lines total)` —
a trailing newline counts ("a\nb\n" → 3 lines).
- **limit honored first** (window slice), then `truncateHead`
(2000 lines / 50 KB, keep HEAD, never partial lines).
- **Continuation notices (pi EXACT formats)**:
  - lines-truncated: `\n\n[Showing lines S-E of T. Use offset=N to continue.]`
  - bytes-truncated: `\n\n[Showing lines S-E of T (50.0KB limit). Use offset=N to continue.]`
  - first selected line alone exceeds 50 KB:
    `[Line N is <size>, exceeds 50.0KB limit. Use bash: sed -n 'Np' <original path arg> | head -c 51200]`
  - user `limit` stopped early with more content:
    `\n\n[<remaining> more lines in file. Use offset=N to continue.]`
- **Images (v0: NO processing)**: magic-byte detection only — png
`\x89PNG`, jpeg `\xFF\xD8\xFF`, gif `GIF87a`/`GIF89a`, webp
`RIFF....WEBP`, bmp `BM` prefix (pi's fuller BMP/IHDR validation is
v0-skipped; a TEXT file beginning "BM" is misdetected — documented cost).
Result is `isError: false` with text
`Read image file [<mime>] — binary image preview not supported by execd read v0 (<size> bytes). Use bash (e.g. base64/file) if you need its bytes.`
and structuredContent `{ path, total_lines: 0, truncated: false, size_bytes }`.

### `write`

```
name: "write"
inputSchema: {
  path: string              (required — "Path to the file to write (relative or absolute)")
  content: string           (required — "Content to write to the file")
}
result.content[0].text  — `Successfully wrote to <ORIGINAL path arg>` (pi wording)
result.structuredContent (success only): {
  path: string               (resolved ABSOLUTE path)
  bytes_written: number      (utf-8 byte length of content)
  created_dirs: boolean      (recursive mkdir created anything: true, else false)
}
result.isError: true + NO structuredContent — raw error message (e.g.
  parent path exists as a file → "ENOTDIR: not a directory, mkdir '…'" on
  linux; Bun-on-macOS reports "EEXIST: file already exists, mkdir '…'" for
  the same situation — the invariant is isError + RAW message)
```

Semantics (copied from pi write.js):

- **resolveToCwd** (NO read variants); `mkdir -p` parent (recursive,
`created_dirs` = mkdir returned a path); overwrite always (`writeFile`).
- **Per-path mutation queue** (`withFileMutationQueue` parity): writes to the
SAME resolved path (realpath key when it exists, resolved path when missing)
serialize — each chains on the previous promise; DIFFERENT paths run in
parallel. A failing write releases the queue (`finally`).

## Transport & auth

- **Streamable-HTTP JSON-RPC at `POST /mcp`** — the same minimal subset our
  mcp-driver already speaks: `initialize` (protocolVersion `2025-03-26`),
  `notifications/initialized` (202, empty), `tools/list`, `tools/call`.
  Plain-JSON responses (`Accept: application/json` suffices); SSE never
  required. **Stateless** — no session ids, no cookies (per-request
  handshake, identical to the mcp-driver contract).
- **Auth: `Authorization: Bearer <CUA_ENV_TOKEN>`** — the same per-sandbox
  token spacesd uses (HMAC-SHA256(web/.cua-secret, containerId), injected at
  create). 401 `missing or invalid bearer token` otherwise. Trust model
  unchanged: the token already grants full GUI control; arbitrary guest shell
  is no escalation. Bind **0.0.0.0:3213** in-guest (required for the Apple
  publish mapping to reach it; loopback exposure is enforced host-side by
  `-p` publishing).
- Errors follow the sandbox2 envelope style at the JSON-RPC layer: unknown
  tool → `-32601`; missing/malformed params → `-32602`; internal spawn crash →
  `isError: true` result (never a hung request; every request answers).

## Transport: stdio (0.2)

The same three-tool server (serverInfo **0.2.0**, same dispatch semantics,
same tool registry — zero tool-semantics drift) also speaks
**newline-delimited JSON-RPC 2.0 over stdin/stdout** so the HOST can spawn it
as its own child for HOST agent stages.

- **Activation**: CLI flag `--stdio` OR env `EXECD_TRANSPORT=stdio`. Absent
  both → the streamable-HTTP server EXACTLY as before (byte-identical boot
  line, auth, behavior). `PORT`/hostname args are ignored in stdio mode —
  **no HTTP listener is bound at all**.
- **Framing**: read stdin line by line; each COMPLETE line (terminated `\n`)
  is one JSON-RPC 2.0 message; responses go to stdout as ONE line each —
  `JSON.stringify(body)` (never embedded newlines) + `\n`.
  **One-line-response invariant**: every response contains exactly one `\n`
  and it is terminal. Blank (whitespace-only) lines are skipped silently; a
  partial trailing line waits for the rest of the line and at EOF is
  discarded — incomplete input never emits.
- **Dispatch**: the SAME dispatchRpc semantics as HTTP — initialize
  (stateless handshake answer, protocolVersion `2025-03-26`, serverInfo
  0.2.0, same instructions string), `notifications/initialized` →
  **NO output at all** (notification-silence invariant — true for every
  notification), `tools/list` → `[bash, read, write]`, `tools/call` → result
  or JSON-RPC error with the SAME codes: unknown tool `-32601`, bad params
  `-32602`, malformed JSON `-32700` / bad envelope `-32600`, crashing
  handler `-32603` INTERNAL_ERROR (the pipe must never hang).
- **Concurrency**: lines may arrive while an earlier tools/call is still
  running (pi can issue parallel tool calls) — dispatch is asynchronous;
  each response is written when its own result settles (interleaved
  completion order is legal; the JSON-RPC `id` pairs each response). A
  strictly-serial loop is a BUG (one slow bash call would wedge the session).
  In flight is capped at **8**; lines beyond the cap queue FIFO.
- **Auth: NONE** in stdio mode — the pipe is the trust boundary (parent and
  child share a process tree; there is no reachable network surface).
- **Lifecycle**: stdin EOF → `stop()` (group-kill any tracked children) →
  exit 0. SIGTERM/SIGINT → the same stop + exit 0 (same shutdown as HTTP).
  Responses for calls still in flight at EOF are discarded (the reader is
  gone).
- **Logs: stderr ONLY** — boot line
  `[execd] stdio mode — newline-delimited JSON-RPC on stdin/stdout`;
  stdout carries NOTHING but response lines.

`startExecdStdio()` in `index.mjs` (next to `startExecd`) returns
`{ handleLine, run, stop }`: `handleLine(text) → Promise<string|null>` is the
per-line dispatcher the loop uses (in-process-testable: returns the response
line — `JSON.stringify(body)` + `\n` — or null for silence); `run()` is the
real stdin loop (framing, ≤8-in-flight FIFO pump, EOF → stop → exit 0);
`stop()` group-kills tracked children. Options `{ token, tmpdir }` are
accepted for call-site symmetry and ignored (no auth; temp files honor
`EXECD_TMPDIR` as before).

## initialize (0.2)

`serverInfo: { name: 'execd', version: '0.2.0' }`; `instructions`:
"Three tools: bash, read, write — one-shot shell execution and file
primitives in the sandbox (pi-harness semantics). Stateless server: perform
the initialize handshake per request."

## Orchestration API integration (batch 2.1 surface changes)

- `POST /api/orchestration/sandboxes` and GET list/detail responses gain
  **`execPort`** (+ `execUrl` = `http://127.0.0.1:<execPort>/mcp`) — published
  at create alongside mcpPort (`-p <execPort>:3213`, same bind-:0-and-close
  host-port allocation). Records created before this change have
  `execPort: null` — consumers must tolerate absence (see AJCS note).
- **Clone semantics CHANGED (fixes the desktop-user invisibility bug):**
  repos clone as the **`desktop` user** (`container exec -u desktop`) into
  **`/home/desktop/repos/<name>`** (was `/root/repos/<name>` — 0700 root,
  invisible to the session user; the smoke agent only survived via
  discovered NOPASSWD sudo). `repos[].path` carries the new guest path.
  The entrypoint pre-creates `/home/desktop/repos` (desktop-owned).
- Git identity pre-provisioned: the entrypoint writes
  `/home/desktop/.gitconfig` — `user.name = psicom-<containerId-prefix>`,
  `user.email = psicom@localhost`, `init.defaultBranch = main` — so agents
  never juggle `-c user.name/email` flags (they may still override per-command).
- DELETE/stop/reconcile behavior unchanged (execd dies with the container).

## mcp-driver facade (batch 2.2 surface addition)

Sibling endpoints proxy the exec surface (same minting/gating as the GUI
facade — unknown id 404, not-ready 409, token minted internally, never
returned):

```
GET  /api/orchestration/sandboxes/:id/exec/tools       → proxy of execd tools/list
POST /api/orchestration/sandboxes/:id/exec/tools/bash  → proxy of tools/call {arguments:{command,...}}
POST /api/orchestration/sandboxes/:id/exec/rpc         → arbitrary JSON-RPC passthrough (escape hatch)
```

`MCP_DRIVER_TIMEOUT_MS` applies unchanged; 504 = outcome unknown
(a timed-out exec may still have executed — non-idempotent, no blind retry).

## AJCS integration (batch 3.3 surface changes)

- sandbox2 client: create/detail plumbing carries `execPort`/`execUrl` →
  `sandboxRef` gains `execUrl` (null when the sandbox predates execd).
- `runShellStep`: when `sandboxRef.execUrl` is present, call execd's `bash`
  DIRECTLY via the exec facade (no discovery — it is our own server with a
  known tool). Fallback when absent: the existing GUI-surface discovery
  (`EXEC_TOOL_EXACT`/regex over spacesd tools) unchanged — images without
  execd keep their honest-failure path.
- pi launcher (`runPiAgent`): new optional `execUrl` param; when present the
  child's `mcp.json` gains a second server entry —

  ```jsonc
  "exec": { "url": "<execUrl>",
            "headers": { "Authorization": "Bearer ${PI_MCP_BEARER_TOKEN}" },
            "exposure": "direct",
            "description": "sandbox2 execd — the agent's shell (pi bash semantics)" }
  ```

  pi names MCP tools `mcp__<server>__<tool>` → the agent sees
  **`mcp__exec__bash`** (the GUI tools remain `mcp__cua-driver__*`).
- Agentfile render context (§17) gains the **`sandbox`** branch — the
  normalized Agentfile sandbox at registration time, with clone paths
  precomputed by the loader using the SAME convention as the orchestration
  API (`/home/desktop/repos/<basename-sanitized>`, `-2` collision suffix):

  ```yaml
  system_prompt: |
    Your repo clone is at <%= sandbox.repos.0.path %>.
  ```

  Array numeric-index access works with the existing dotted-path grammar
  (`'0' in [...]` → true); key names with dashes are NOT path-addressable —
  single-repo stages (the dominant case) use `repos.0.path`.

## Jobfile `shell:` steps

Unchanged shape (`shell: <command string>`); they now EXECUTE for real
against execd's bash via the driver (output journaled, truncated 2000 chars;
non-zero exit fails the stage per the spine rule).

## Testing

- execd unit tests (bun test): happy path, timeout group-kill, truncation +
  temp file, exit codes (0/1/signal), cwd default/missing, auth 401, MCP
  handshake subset (initialize/list/call, unknown tool -32601, bad params
  -32602).
- stdio tests (bun test, two layers):
  - **In-process** (`startExecdStdio().handleLine` — no child): initialize
    answer shape; `notifications/initialized` → null (no output);
    `tools/list` = [bash, read, write]; tools/call bash (`echo hi` → exit 0),
    read (a tmp file), write (a tmp file); unknown tool → -32601; bad params
    → -32602; malformed JSON line → -32700; blank lines silent; concurrent
    dispatch (a `sleep 0.3` bash and an `echo fast` issued together — the
    fast response settles FIRST, proving non-serial dispatch; ids pair);
    one-line-response invariant asserted on every response (exactly one
    `\n`, terminal).
  - **Child-spawn integration (REAL pipe)**: `bun <repo>/desktop/execd/index.mjs
    --stdio` — initialize → tools/list → a write → a read-back of what write
    created → bash `rm` of it → stdin end → exit code 0 within a bounded
    window; stderr carried the boot line; stdout carried ONLY JSON lines
    (every line parses; no partial tail, no stray lines); no HTTP listener
    (`PORT` set + ignored → connect refused). `EXECD_TRANSPORT=stdio` env
    equivalent (initialize only). Bounded-concurrency probe: 8 slow + 2 fast
    concurrent calls all answered, ids paired. HTTP regression: no flag/env
    → the HTTP server boots, `/healthz` answers, SIGTERM exits 0.
  - **resolveCwd chain**: `EXECD_DEFAULT_CWD` unset → bash `pwd` = homedir;
    set → wins (in-process, both transports share the chain).
- read tests: full file, offset+limit windows, all three truncation-notice
  formats (>2000-line file and >50KB file), offset-beyond-EOF exact message,
  missing file isError, image-magic detection note, relative path + default
  cwd, `~` expansion, AM/PM + curly-quote read variants.
- write tests: new file with auto parents, overwrite, same-path concurrent
  serialization (5 concurrent writes, no corruption), relative path, ENOTDIR
  error.
- wiring tests: tools/list order + schemas, -32601 unknown tool, -32602
  malformed params for read and write.
- orchestration tests: execPort allocated/published/recorded; facade proxy
  (tools + call + rpc); clone path/user.
- AJCS tests: sandboxRef.execUrl plumbing; runShellStep via exec facade
  (hermetic seam); fallback discovery preserved; render context sandbox
  injection (`<%= sandbox.repos.0.path %>` renders the precomputed path).
- Live smoke (opt-in, NOT in bun test — see the mcp-driver busy-wait open
  issue): image rebuild + real sandbox + bash date → file → commit → push.

## Limitations (v0)

- Foreground one-shot only; no persistent sessions, no streaming updates
  (deferred: `bash_bg`/`bash_wait`, pi interactive-shell lineage — add when a
  job needs a long-lived server).
- No per-call env injection (v0).
- `read` v0 does NOT process images (no photon in execd): images are detected
  and reported as text notes; no resize, no image blocks, no vision payloads.
- execd availability is best-effort like spacesd: if the process dies, exec
  calls fail (`upstream_error` at the facade) — recreate the stage sandbox.
