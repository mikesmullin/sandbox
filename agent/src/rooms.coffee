# One Angela harness + chat session per XFCE workspace. Browser MCP is
# agent-browser --session <workspace> --pin-tab against the shared Chromium
# profile, bound to that workspace's window (cookies shared, windows not).
import {
  Angela,
  resolveMcpList,
  buildMcpPresets,
  DEFAULT_LUCY_ALLOWLIST,
  ApprovalQueue,
  resolveContextWindow,
  resolveContextWindowAsync,
} from 'angela'
import {
  listWorkspaces, ensureBrowserWindow, closeBrowserTarget,
  hexOf, setRoomMeta, resolveName, loadState,
  ensureJail, removeJail,
} from './workspaces.coffee'
import { loadJobsIntoRoom, useWorkspacePersist } from './jobs.mjs'

MCP_ROOT = process.env.ANGELA_MCP_ROOT or '/opt/mcp'
GITLAB_URL = process.env.GITLAB_URL or 'http://gitlab'
DEFAULT_MODEL = process.env.AGENT_MODEL or 'llama-server:default'
DAD_URL = process.env.DAD_PROXY_URL or process.env.LLAMA_SERVER_BASE_URL or 'https://host.containers.internal:1234'
DAD_KEY = process.env.DAD_PROXY_API_KEY or process.env.LLM_PROXY_API_KEY or process.env.LLAMA_SERVER_API_KEY or ''
DAD_CA = process.env.DAD_PROXY_CA_FILE or process.env.LLAMA_SERVER_CA_FILE or '/opt/certs/ca.pem'

# Agent.factory({ proxy: 'host:port' }) — every provider:model POSTs here.
dadProxyHostPort = (url = DAD_URL) ->
  s = String(url or '').trim()
  return '' unless s
  try
    u = new URL(if /^[a-z][a-z0-9+.-]*:\/\//i.test(s) then s else "https://#{s}")
    if u.port then "#{u.hostname}:#{u.port}" else u.hostname
  catch
    s.replace(/^https?:\/\//i, '').replace(/\/.*$/, '')

CDP_PORT = String process.env.CDP_PORT or '9222'
CDP_TARGET = String(process.env.AGENT_BROWSER_CDP or CDP_PORT)
DISPLAY = process.env.DISPLAY or ':99'
CONTEXT_LOOP = new Set ['goto', 'loop_start_marker', 'waypoint']

useWorkspacePersist { hexOf, setRoomMeta, loadState }

export allowlistText = """
#{DEFAULT_LUCY_ALLOWLIST}

# file write / edit (coding)
file_io__write_file
file_io__write_file:.*
file_io__edit
file_io__edit:.*

# headed browser-use Chromium (agent-browser MCP)
browser__.*

# real host git/shell (not just-bash overlay)
term_local__exec:.*
""".trim()

export knownModels = [DEFAULT_MODEL]
export contextWindow = Number(resolveContextWindow(DEFAULT_MODEL) or 0) or 32768

rooms = new Map()
ensuring = new Map()

systemPrompt = (jail) -> """
You own this XFCE workspace and its headed Chromium window (already open).
Cookies, history, and logins are shared with other workspaces in this
container (same browser profile). Browser MCP tools are pinned to YOUR
window — do not drive another workspace's window, and do not close the
browser process.

Your file-io jail and term-local cwd is #{jail}. Durable work lives there.
Sibling screens have their own jails under the same /workspace/jails/ volume.
Do not write into /workspace itself.

Use file-io tools under #{jail}: list_dir, read_file (text + images),
write_file, edit, grep, find, stat. Prefer grep/find over shell search.
Use term-local exec for host commands (argv spawn, no shell metacharacters —
pass the binary in `command` and arguments in `args`, set `cwd` when needed).
Do not use term_local__bash — that overlay cannot write the jail (EROFS).
Example: command=git args=["-C","#{jail}","status"].
Use browser MCP tools to drive your window: navigate, snapshot, click,
fill, screenshot. Prefer the already-running window; do not launch a second Chrome.

GitLab is in this cluster at #{GITLAB_URL} (k8s DNS). git clone / push / pull
already authenticate via the credential helper — do not type a password in
chat, and do not echo credentials. Default branch is main. Public projects
under root are fine. If you need multiple checkouts of one repo, run
git worktree add inside the jail. The platform does not create worktrees.

Git flags: this model mangles short flags. Prefer:
  git push origin main
  git commit --file <path>
Do not use -u or -m (they become -1).

Prefer tools over guessing. Keep answers concise.
"""

spawnEnv = (extra = {}) ->
  env =
    DISPLAY: DISPLAY
    HOME: process.env.HOME or '/home/agent'
    XDG_RUNTIME_DIR: process.env.XDG_RUNTIME_DIR or '/tmp/runtime-agent'
    PATH: process.env.PATH or '/usr/bin:/bin'
    AGENT_BROWSER_HEADED: '1'
    AGENT_BROWSER_CDP: CDP_TARGET
    AGENT_BROWSER_PIN_TAB: '1'
  for k, v of process.env
    env[k] = v unless env[k]?
  for k, v of extra
    env[k] = v
  delete env.GITLAB_ROOT_PASSWORD
  delete env.GITLAB_PASSWORD
  delete env.GIT_TOKEN
  env

sh = (args, extraEnv = {}) ->
  proc = Bun.spawnSync args,
    stdout: 'pipe'
    stderr: 'pipe'
    env: spawnEnv extraEnv
  out = new TextDecoder().decode(proc.stdout or '').trim()
  err = new TextDecoder().decode(proc.stderr or '').trim()
  { out, err, code: proc.exitCode }

export broadcastRoom = (room, obj) ->
  return unless room?
  json = JSON.stringify obj
  room.clients.forEach (ws) ->
    try
      ws.send json

export broadcastRoomExcept = (room, obj, exceptWs) ->
  return unless room?
  json = JSON.stringify obj
  room.clients.forEach (ws) ->
    return if exceptWs? and ws is exceptWs
    try
      ws.send json

export broadcastAll = (obj) ->
  rooms.forEach (room) -> broadcastRoom room, obj

cloneTelemetry = (t) ->
  return null unless t and typeof t is 'object'
  try
    structuredClone t
  catch
    Object.assign {}, t

looksLikeProviderDump = (text) ->
  t = String(text or '').trim()
  t.startsWith('{') and /"choices"\s*:/.test(t) and /"usage"\s*:/.test(t)

clipText = (s, n = 8000) ->
  t = String(s or '')
  if t.length > n then t.slice(0, n) else t

clipTail = (s, n = 8000) ->
  t = String(s or '')
  if t.length > n then t.slice(-n) else t

gotoFromMeta = (wrap) ->
  g = wrap?.meta?.goto
  unless g and typeof g is 'object'
    return { enabled: no, label: '' }
  { enabled: Boolean(g.enabled), label: String(g.label or '') }

# Rebuild the sidebar transcript from delta/v1 jsonl (angela SessionStore).
messagesFromLog = (room) ->
  id = room?.session?.id
  store = room?.harness?.sessionStore
  return [] unless id and store?.listEventsFolded
  events = store.listEventsFolded id
  messages = []
  lastGen = null
  for wrap in events
    p = wrap.payload
    if wrap.event_type is 'gen_info' and p
      lastGen = wrap.meta?.telemetry or p
      continue
    continue unless p
    frozen = wrap.meta?.telemetry or null
    if wrap.event_type is 'context_window' and p.role and p.content? and p.kind isnt 'provider_messages_snapshot'
      telemetry = frozen or (if p.role is 'assistant' then lastGen else null)
      messages.push
        id: wrap.event_id or "#{id}-#{messages.length}"
        eventId: wrap.event_id or null
        kind: if p.role is 'user' then 'user' else 'assistant'
        text: String p.content
        visible: wrap.meta?.visible isnt false
        streaming: no
        telemetry: cloneTelemetry telemetry
        goto: gotoFromMeta wrap
    else if (wrap.event_type is 'reasoning' or p.type is 'reasoning') and (p.text or p.content)
      messages.push
        id: wrap.event_id or "#{id}-rs-#{messages.length}"
        eventId: wrap.event_id or null
        kind: 'reasoning'
        text: String(p.text or p.content or '')
        visible: wrap.meta?.visible isnt false
        streaming: no
        telemetry: null
        goto: gotoFromMeta wrap
    else if wrap.event_type is 'error' and (p.message or p.error or p.text)
      errText = String(p.message or p.error or p.text or 'agent error')
      unless errText.startsWith 'Error:'
        errText = "Error: #{errText}"
      messages.push
        id: wrap.event_id or "#{id}-err-#{messages.length}"
        eventId: wrap.event_id or null
        kind: 'error'
        text: errText
        visible: yes
        streaming: no
        telemetry: null
        goto: gotoFromMeta wrap
    else if wrap.event_type is 'tool_call' and p.name
      messages.push
        id: wrap.event_id or "#{id}-tc-#{messages.length}"
        eventId: wrap.event_id or null
        kind: 'tool_call'
        name: p.name
        args: p.args or {}
        explanation: p.explanation or null
        visible: wrap.meta?.visible isnt false
        streaming: no
        telemetry: cloneTelemetry(frozen or lastGen)
        full_chars: p.full_chars
        truncated: p.truncated
        goto: gotoFromMeta wrap
    else if wrap.event_type is 'tool_result' and (p.name or p.text? or p.image)
      messages.push
        id: wrap.event_id or "#{id}-tr-#{messages.length}"
        eventId: wrap.event_id or null
        kind: 'tool_result'
        name: p.name
        ok: p.ok
        denied: p.denied
        text: p.text
        explanation: p.explanation or null
        visible: wrap.meta?.visible isnt false
        streaming: no
        telemetry: cloneTelemetry(frozen or lastGen)
        full_chars: p.full_chars
        truncated: p.truncated
        image: p.image or null
        goto: gotoFromMeta wrap
  messages

liveMessages = (room) ->
  messages = messagesFromLog room
  if room.liveReasoning
    messages.push
      id: "#{room.session?.id or room.name}-live-rs"
      kind: 'reasoning'
      text: room.liveReasoning
      streaming: yes
      visible: yes
      telemetry: null
  if room.liveAssistant
    messages.push
      id: "#{room.session?.id or room.name}-live-asst"
      kind: 'assistant'
      text: room.liveAssistant
      streaming: yes
      visible: yes
      telemetry: null
  pending = try room.approvals?.list?() catch then null
  if Array.isArray pending
    for req in pending
      aid = req.id or req.approvalId
      continue unless aid
      if messages.some((m) -> m.kind is 'approval_needed' and m.approvalId is aid)
        continue
      messages.push
        id: aid
        kind: 'approval_needed'
        approvalId: aid
        name: req.tool or req.name
        args: req.args or {}
        command: req.command or ''
        reason: req.reason or ''
        status: 'pending'
        visible: yes
  if room.error
    errText = String room.error
    unless errText.startsWith 'Error:'
      errText = "Error: #{errText}"
    unless messages.some((m) -> m.kind is 'error' and m.text is errText)
      messages.push
        id: "#{room.session?.id or room.name}-err"
        kind: 'error'
        text: errText
        visible: yes
        streaming: no
        telemetry: null
  messages

tokensOf = (room) ->
  id = room?.session?.id
  meta = try room.harness?.sessionStore?.load id catch then null
  n = Number(meta?.lastPromptTokens ? room.tokensUsed ? 0)
  if Number.isFinite(n) and n > 0 then n else Number(room.tokensUsed or 0) or 0

cwOf = (room) ->
  Number(room.createOpts?.contextWindow or contextWindow or 0) or contextWindow

export helloPayload = (room) ->
  {
    type: 'hello'
    model: room?.model or DEFAULT_MODEL
    models: knownModels
    sessionId: room?.session?.id or null
    workspace: room?.name or null
    allowlist: room?.allowlistText or allowlistText
    contextWindow: cwOf room
  }

export statePayload = (room) ->
  waiting = Boolean room?.waiting or room?.session?.running
  {
    type: 'state'
    model: room?.model or DEFAULT_MODEL
    models: knownModels
    sessionId: room?.session?.id or null
    workspace: room?.name or null
    allowlist: room?.allowlistText or allowlistText
    contextWindow: cwOf room
    tokensUsed: tokensOf room
    waiting: waiting
    phase: if waiting then 'running' else 'ready'
    runStartedAt: if waiting then (room.runStartedAt or null) else null
    error: room?.error or ''
    messages: liveMessages room
  }

seedUi = (room) ->
  room.waiting ?= no
  room.runStartedAt ?= null
  room.tokensUsed ?= 0
  room.error ?= ''
  room.liveAssistant ?= ''
  room.liveReasoning ?= ''
  room

markRunning = (room) ->
  room.waiting = yes
  room.runStartedAt = Date.now()
  room.error = ''
  room.liveAssistant = ''
  room.liveReasoning = ''
  room

markIdle = (room, err = '') ->
  room.waiting = no
  room.runStartedAt = null
  room.liveAssistant = ''
  room.liveReasoning = ''
  room.error = err or ''
  room

export getRoom = (id) ->
  name = resolveName(id) or id
  rooms.get name

pinSessionToTarget = (sessionName, targetId) ->
  return no unless sessionName and targetId
  extra =
    AGENT_BROWSER_SESSION: sessionName
    AGENT_BROWSER_PIN_TAB: '1'
  r = sh [
    'agent-browser'
    '--session', sessionName
    '--cdp', CDP_TARGET
    '--headed'
    '--pin-tab'
    '--json'
    'tab', String targetId
  ], extra
  if r.code isnt 0
    console.error "[rooms] pin #{sessionName} -> #{targetId}: #{r.err or r.out or r.code}"
    return no
  yes

stripContextLoop = (sess) ->
  return if sess._contextLoopOff
  catalog = await sess.listToolCatalog()
  enabled = catalog.map((t) -> t.name).filter (n) ->
    return false if CONTEXT_LOOP.has n
    # CONTEXT LOOP is opt-in MCP; still drop if a preset sneaks in.
    # just-bash OverlayFs cannot write the jail; git must use exec.
    return false if /term_local__bash/i.test n
    # Never let one workspace kill the shared Chromium process.
    if /browser__/i.test(n) and /close/i.test(n) and not /tab/i.test(n)
      return false
    true
  sess.setToolsEnabled enabled
  sess._contextLoopOff = true
  console.log "[agent] #{sess.id or ''} tools=#{enabled.length} context-loop off"

makeOnEvent = (room) ->
  (ev) ->
    type = ev?.type
    return unless type
    if type is 'assistant_delta'
      chunk = ev.text or ''
      room.liveAssistant = (room.liveAssistant or '') + chunk if chunk
      broadcastRoom room, { type, text: chunk }
      return
    if type is 'reasoning_delta'
      chunk = ev.text or ''
      room.liveReasoning = (room.liveReasoning or '') + chunk if chunk
      broadcastRoom room, { type, text: chunk }
      return
    if type is 'tool_delta'
      out = clipTail(ev.output or ev.text or '')
      broadcastRoom room,
        type: 'tool_delta'
        name: ev.name or ev.tool
        server: ev.server
        progressToken: ev.progressToken
        output: out
        text: out
      return
    if type is 'reasoning'
      broadcastRoom room,
        type: 'card'
        card:
          kind: 'reasoning'
          text: ev.text or ev.content or ''
          eventId: ev.event_id or null
          telemetry: cloneTelemetry(ev.telemetry)
          visible: yes
      return
    if type is 'final'
      text = String(ev.result or '')
      if looksLikeProviderDump text then text = ''
      room.liveAssistant = ''
      broadcastRoom room,
        type: 'card'
        card:
          kind: 'assistant'
          text: text
          streaming: no
          eventId: ev.event_id or null
          telemetry: cloneTelemetry(ev.telemetry)
          visible: yes
      return
    if type is 'tool_call'
      room.liveAssistant = ''
      room.liveReasoning = ''
      broadcastRoom room,
        type: 'card'
        card:
          kind: 'tool_call'
          name: ev.name or ev.tool
          args: ev.args or {}
          explanation: ev.explanation or null
          eventId: ev.event_id or null
      return
    if type is 'tool_result'
      broadcastRoom room,
        type: 'card'
        card:
          kind: 'tool_result'
          name: ev.name or ev.tool
          ok: ev.ok isnt false
          denied: Boolean ev.denied
          text: clipText(ev.text or '')
          explanation: ev.explanation or null
          eventId: ev.event_id or null
          full_chars: ev.full_chars
          truncated: ev.truncated
          image: ev.image or null
      return
    if type is 'aborted'
      markIdle room
      broadcastRoom room, { type: 'aborted', reason: ev.reason or 'stop' }
      return
    if type is 'usage' or type is 'gen_info'
      n = Number ev.prompt_tokens
      room.tokensUsed = n if Number.isFinite(n) and n >= 0
      broadcastRoom room,
        type: type
        usage: ev.usage
        prompt_tokens: ev.prompt_tokens
        completion_tokens: ev.completion_tokens
        total_tokens: ev.total_tokens
        tok_per_sec: ev.tok_per_sec
        ttft_ms: ev.ttft_ms
        duration_ms: ev.duration_ms
        finish_reason: ev.finish_reason
        stop_reason: ev.stop_reason
        model: ev.model
        contextWindow: ev.contextWindow or cwOf room
      return
    if type is 'approval_needed'
      broadcastRoom room,
        type: 'approval_needed'
        id: ev.id
        name: ev.tool or ev.name
        args: ev.args or {}
        command: ev.command or ''
        reason: ev.reason or 'not on allowlist'
      return
    if type is 'status'
      broadcastRoom room,
        type: 'status'
        phase: ev.phase
        sessionId: ev.sessionId or room.session?.id
        runStartedAt: room.runStartedAt
        waiting: room.waiting

browserMcp = (wsName) ->
  {
    name: 'browser'
    command: 'agent-browser'
    args: ['--session', wsName, '--cdp', CDP_TARGET, '--headed', '--pin-tab', 'mcp', '--tools', 'core,debug']
    env:
      DISPLAY: DISPLAY
      HOME: process.env.HOME or '/home/agent'
      AGENT_BROWSER_HEADED: '1'
      AGENT_BROWSER_CDP: CDP_TARGET
      AGENT_BROWSER_SESSION: wsName
      AGENT_BROWSER_PIN_TAB: '1'
    onStderr: (chunk) ->
      process.stderr.write "[mcp:browser:#{wsName}] #{chunk}"
  }

termLocalMcp = (jail) ->
  bun = process.execPath
  {
    name: 'term-local'
    command: bun
    args: ["#{MCP_ROOT}/term-local/server.mjs"]
    env:
      MCP_TERM_CWD: jail
      MCP_TERM_JB_ROOT: jail
      MCP_TERM_ALLOW: process.env.MCP_TERM_ALLOW or '.*'
  }

createHarness = (room) ->
  jail = room.jail
  presets = buildMcpPresets MCP_ROOT, { projectRoot: jail }
  mcp = resolveMcpList ['file-io', termLocalMcp(jail), browserMcp room.name], presets
  createOpts = room.createOpts
  createOpts.mcp = mcp
  createOpts.onEvent = makeOnEvent room
  createOpts.onApproval = room.approvals.createApprover()
  harness = await Angela.create createOpts
  harness

bindSession = (room, session) ->
  room.session = session
  session._contextLoopOff = false
  hex = hexOf room.name
  setRoomMeta hex, { sessionId: session.id, targetId: room.targetId } if hex
  session

doEnsure = (name) ->
  existing = rooms.get name
  return existing if existing?.harness and existing?.session

  targetId = await ensureBrowserWindow name
  unless targetId
    console.warn "[rooms] #{name} has no Chromium window yet"

  jail = ensureJail name
  unless jail
    throw Object.assign new Error("workspace #{name} has no jail"), { status: 500 }

  room = existing or {
    name: name
    model: DEFAULT_MODEL
    allowlistText: allowlistText
    clients: new Set()
    approvals: new ApprovalQueue()
    runLock: Promise.resolve()
    harness: null
    session: null
    createOpts: null
    targetId: targetId
    jail: jail
    waiting: no
    runStartedAt: null
    tokensUsed: 0
    error: ''
    liveAssistant: ''
    liveReasoning: ''
    jobs: new Map()
  }
  room.targetId = targetId or room.targetId
  room.jail = jail
  room.clients ?= new Set()
  room.jobs ?= new Map()
  seedUi room
  loadJobsIntoRoom room
  rooms.set name, room

  if targetId
    pinSessionToTarget name, targetId

  unless room.createOpts?
    room.createOpts =
      model: room.model
      proxy: dadProxyHostPort()
      base_url: DAD_URL
      api_key: DAD_KEY
      ca_file: DAD_CA
      contextWindow: contextWindow
      system: systemPrompt jail
      projectRoot: jail
      policyMode: 'ask'
      allowlist: room.allowlistText
      persistSessions: true
      max_turns: 48
      retain_history: true
      stream: true
      parallel_tools: true

  unless room.harness?
    room.harness = await createHarness room
    mcpNames = (room.harness.clients or []).map((c) -> c.name).join ','
    console.log "[agent] room=#{name} jail=#{room.jail} model=#{room.model} ctx=#{contextWindow} proxy=#{DAD_URL} mcp=#{mcpNames or '(none)'} target=#{room.targetId or '?'}"

  unless room.session?
    hex = hexOf name
    meta = if hex then (loadState().rooms[hex] or null) else null
    resumed = no
    if meta?.sessionId
      try
        session = await room.harness.session.open meta.sessionId
        resumed = yes
      catch err
        console.warn "[agent] resume #{name} #{meta.sessionId}: #{err.message or err}"
    unless resumed
      session = await room.harness.session.create { title: name }
    bindSession room, session
    console.log "[agent] room=#{name} session=#{room.session.id}#{if resumed then ' (resumed)' else ''}"

  room

export ensureRoom = (id) ->
  name = resolveName id
  unless name
    throw Object.assign new Error("workspace #{id} not found"), { status: 404 }
  hit = rooms.get name
  return hit if hit?.harness and hit?.session
  pending = ensuring.get name
  unless pending?
    pending = doEnsure name
    ensuring.set name, pending
  try
    await pending
  finally
    ensuring.delete name if ensuring.get(name) is pending
  rooms.get name

export destroyRoom = (id) ->
  name = resolveName(id) or id
  room = rooms.get name
  targetId = room?.targetId
  if room?
    try
      room.approvals.clear 'deny'
    catch then null
    if room.session?.running
      try
        await room.session.abort 'workspace removed'
      catch then null
    if room.harness?
      try
        await room.harness.close()
      catch then null
    for ws from room.clients
      try ws.close()
      catch then null
    rooms.delete name
  closeBrowserTarget targetId if targetId
  removeJail name
  yes

enqueue = (room, fn) ->
  room.runLock = (room.runLock or Promise.resolve()).then(fn).catch (err) ->
    console.error "[agent #{room.name}]", err.message or err
  room.runLock

export handleChat = (room, ws, data) ->
  content = String(data.content or '').trim()
  unless content
    ws.send JSON.stringify { type: 'error', error: 'empty prompt' }
    return
  await ensureRoom room.name
  if data.allowlist != null
    handleAllowlist room, { text: String(data.allowlist) }, ws
  isNew = /^\/new$/i.test content
  unless isNew
    await stripContextLoop room.session
  if room.session.running
    try
      await room.session.abort 'superseded'
  unless isNew
    markRunning room
    broadcastRoom room, { type: 'user', text: content }
    broadcastRoom room,
      type: 'status'
      phase: 'running'
      sessionId: room.session?.id
      runStartedAt: room.runStartedAt
      waiting: yes
  try
    result = await room.session.run prompt: content
    if result?.command is 'new' and result.session?
      bindSession room, result.session
      markIdle room
      broadcastRoom room,
        type: 'session'
        command: 'new'
        sessionId: room.session.id
        previousId: result.previousId
        workspace: room.name
      broadcastRoom room, helloPayload room
      broadcastRoom room, statePayload room
      broadcastRoom room, { type: 'done' }
      return
  catch err
    unless err?.aborted
      markIdle room, err.message or String(err)
      broadcastRoom room, { type: 'error', error: err.message or String(err) }
      broadcastRoom room, { type: 'done' }
      return
  markIdle room
  broadcastRoom room, { type: 'done' }

export handleAbort = (room) ->
  return unless room?.session?
  try
    await room.session.abort 'user stop'
  markIdle room

export handleAllowlist = (room, msg, ws) ->
  text = if msg.text != null then String(msg.text) else ''
  room.allowlistText = text
  room.harness?.policy?.setAllowlist text
  if room.session?.id and room.harness?.sessionStore?.updateMeta
    try
      room.harness.sessionStore.updateMeta room.session.id, { allowlist: text }
  payload =
    type: 'allowlist'
    text: text
    overridden: Boolean msg.overridden
  if ws? then broadcastRoomExcept room, payload, ws else broadcastRoom room, payload

export handleModel = (room, msg) ->
  spec = String(msg.model or '').trim()
  return unless spec
  room.model = spec
  room.createOpts.model = spec if room.createOpts?
  try
    liveCw = Number await resolveContextWindowAsync spec, { force: true }
    if liveCw > 0
      # keep local copy on the room's opts; global fallback stays for hello of other rooms
      room.createOpts.contextWindow = liveCw if room.createOpts?
  catch
    syncCw = Number(resolveContextWindow(spec) or 0)
    room.createOpts.contextWindow = syncCw if room.createOpts? and syncCw > 0
  if room.session?.running
    try
      await room.session.abort 'model change'
  if room.harness?
    session = await room.harness.session.create { title: room.name }
    bindSession room, session
  markIdle room
  broadcastRoom room, { type: 'model', model: room.model, contextWindow: cwOf room }
  broadcastRoom room, helloPayload room
  broadcastRoom room, statePayload room

export handleApproval = (room, msg) ->
  id = String(msg.id or '')
  decision = msg.decision or msg.action or 'deny'
  room?.approvals?.resolve id, decision
  broadcastRoom room, { type: 'approval', id, decision }

export handleVisible = (room, msg) ->
  eventId = String(msg.eventId or msg.event_id or '')
  return unless eventId
  vis = Boolean msg.visible
  store = room.harness?.sessionStore
  sess = room.session
  unless store?.setEventVisible and sess?.id
    return
  result = store.setEventVisible sess.id, eventId, vis
  return unless result
  try
    sess.setContextVisible? result.eventIds, vis
  broadcastRoom room,
    type: 'visible'
    eventId: eventId
    eventIds: result.eventIds or [eventId]
    visible: vis

export attachClient = (ws, id) ->
  room = await ensureRoom id
  seedUi room
  room.clients.add ws
  ws.data.workspace = room.name
  ws.send JSON.stringify helloPayload room
  ws.send JSON.stringify statePayload room
  room

export detachClient = (ws) ->
  name = ws.data?.workspace
  return unless name
  room = rooms.get name
  room?.clients.delete ws

export healthSessions = ->
  out = {}
  rooms.forEach (room, name) ->
    out[name] =
      session: room.session?.id or null
      targetId: room.targetId or null
      jail: room.jail or null
      model: room.model
      clients: room.clients.size
  out

export warmupRooms = ->
  { workspaces } = listWorkspaces()
  for w in workspaces
    try
      await ensureRoom w.id
    catch err
      console.error "[agent] warmup #{w.id}", err.message or err

export fetchModels = ->
  try
    res = await fetch "#{DAD_URL.replace /\/$/, ''}/v1/models",
      headers:
        Authorization: "Bearer #{DAD_KEY}"
      tls:
        rejectUnauthorized: false
    return unless res.ok
    body = await res.json()
    ids = (body.data or []).map((m) -> m.id).filter Boolean
    extra = ids.map (id) ->
      if String(id).includes ':' then id else "llama-server:#{id}"
    merged = [DEFAULT_MODEL, extra...]
    uniq = []
    seen = new Set()
    for m in merged
      continue if seen.has m
      seen.add m
      uniq.push m
    if uniq.length
      knownModels.splice 0, knownModels.length, uniq...
      broadcastAll { type: 'models', models: knownModels }
  catch err
    console.error '[agent] models', err.message or err
