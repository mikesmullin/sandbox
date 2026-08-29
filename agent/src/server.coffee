# Desktop owner — Angela + cowork tools (file-io, term-local) + agent-browser MCP.
# Chat clients speak JSON over WebSocket on /ws; inference goes to dad-proxy
# via Agent.factory({ model: 'llama-server:default', base_url, api_key, ca_file }).

import {
  Angela,
  resolveMcpList,
  buildMcpPresets,
  DEFAULT_LUCY_ALLOWLIST,
  ApprovalQueue,
  resolveContextWindow,
  resolveContextWindowAsync,
} from 'angela'
import { providers as aglProviders } from 'agl-ai'
import { sampleTelem } from './telem.coffee'

PORT = Number process.env.AGENT_PORT or 8091
PROJECT_ROOT = process.env.ANGELA_PROJECT_ROOT or '/workspace'
MCP_ROOT = process.env.ANGELA_MCP_ROOT or '/opt/mcp'
MODEL = process.env.AGENT_MODEL or 'llama-server:default'
DAD_URL = process.env.DAD_PROXY_URL or process.env.LLAMA_SERVER_BASE_URL or 'https://host.containers.internal:1234'
DAD_KEY = process.env.DAD_PROXY_API_KEY or process.env.LLM_PROXY_API_KEY or process.env.LLAMA_SERVER_API_KEY or ''
DAD_CA = process.env.DAD_PROXY_CA_FILE or process.env.LLAMA_SERVER_CA_FILE or '/opt/certs/ca.pem'
CDP_PORT = String process.env.CDP_PORT or '9222'
CDP_TARGET = String(process.env.AGENT_BROWSER_CDP or CDP_PORT)
DISPLAY = process.env.DISPLAY or ':99'

clients = new Set()
harness = null
session = null
connecting = null
createOpts = null
runLock = Promise.resolve()
approvals = new ApprovalQueue()
CONTEXT_LOOP = new Set ['goto', 'loop_start_marker', 'waypoint']
allowlistText = """
#{DEFAULT_LUCY_ALLOWLIST}

# file write (coding)
file_io__write_file
file_io__write_file:.*

# headed browser-use Chromium (agent-browser MCP)
browser__.*
""".trim()
knownModels = [MODEL]
contextWindow = Number(resolveContextWindow(MODEL) or 0) or 32768

broadcast = (obj) ->
  json = JSON.stringify obj
  clients.forEach (ws) ->
    try
      ws.send json

helloPayload = ->
  {
    type: 'hello'
    model: MODEL
    models: knownModels
    sessionId: session?.id or null
    allowlist: allowlistText
    contextWindow: contextWindow
  }

fetchModels = ->
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
    merged = [MODEL, extra...]
    uniq = []
    seen = new Set()
    for m in merged
      continue if seen.has m
      seen.add m
      uniq.push m
    knownModels = uniq if uniq.length
  catch err
    console.error '[agent] models', err.message or err

SYSTEM = '''
You own this Linux desktop. You are a coding agent with a real XFCE session,
Thunar, a terminal, and a headed browser-use Chromium already open (CDP on localhost).

Use file-io tools to read and write files under /workspace.
Use term-local exec for shell commands (argv spawn, no shell metacharacters —
pass the binary in `command` and arguments in `args`).
Use browser MCP tools to drive the visible browser: navigate, snapshot, click,
fill, screenshot. Prefer the already-running browser-use window; do not launch a second one.

Prefer tools over guessing. Keep answers concise. Durable work lives in /workspace.
'''

stripContextLoop = (sess) ->
  return if sess._contextLoopOff
  catalog = await sess.listToolCatalog()
  enabled = catalog.map((t) -> t.name).filter (n) -> not CONTEXT_LOOP.has n
  sess.setToolsEnabled enabled
  sess._contextLoopOff = true
  console.log "[agent] tools=#{enabled.length} context-loop off"

connectHarness = ->
  connecting ?= connectHarnessOnce()
  connecting

connectHarnessOnce = ->
  return harness if harness?
  presets = buildMcpPresets MCP_ROOT, { projectRoot: PROJECT_ROOT }
  # UI allowlist (angela PolicyEngine) is the real gate. Do not also jail
  # term-local with the preset MCP_TERM_ALLOW (echo/ls/pwd only).
  bun = process.execPath
  termLocal =
    name: 'term-local'
    command: bun
    args: ["#{MCP_ROOT}/term-local/server.mjs"]
    env:
      MCP_TERM_CWD: PROJECT_ROOT
      MCP_TERM_JB_ROOT: PROJECT_ROOT
      MCP_TERM_ALLOW: process.env.MCP_TERM_ALLOW or '.*'
  browserMcp =
    name: 'browser'
    command: 'agent-browser'
    args: ['--cdp', CDP_TARGET, '--headed', 'mcp', '--tools', 'core']
    env:
      DISPLAY: DISPLAY
      HOME: process.env.HOME or '/home/agent'
      AGENT_BROWSER_HEADED: '1'
      AGENT_BROWSER_CDP: CDP_TARGET
    onStderr: (chunk) ->
      process.stderr.write "[mcp:browser] #{chunk}"
  mcp = resolveMcpList ['file-io', termLocal, browserMcp], presets

  try
    liveCw = Number await resolveContextWindowAsync MODEL, { force: true }
    contextWindow = liveCw if liveCw > 0
  catch err
    console.error '[agent] context window', err.message or err

  createOpts =
    model: MODEL
    base_url: DAD_URL
    api_key: DAD_KEY
    ca_file: DAD_CA
    contextWindow: contextWindow
    system: SYSTEM
    mcp: mcp
    projectRoot: PROJECT_ROOT
    policyMode: 'ask'
    allowlist: allowlistText
    onApproval: approvals.createApprover()
    persistSessions: true
    max_turns: 32
    retain_history: true
    stream: true
    parallel_tools: true
    onEvent: (ev) ->
      type = ev?.type
      return unless type
      if type is 'assistant_delta' or type is 'reasoning_delta'
        broadcast { type, text: ev.text or '' }
        return
      if type is 'tool_call'
        broadcast
          type: 'card'
          card:
            kind: 'tool_call'
            name: ev.name or ev.tool
            args: ev.args or {}
            explanation: ev.explanation or null
        return
      if type is 'tool_result'
        broadcast
          type: 'card'
          card:
            kind: 'tool_result'
            name: ev.name or ev.tool
            ok: ev.ok isnt false
            text: String(ev.text or '').slice 0, 8000
        return
      if type is 'aborted'
        broadcast { type: 'aborted', reason: ev.reason or 'stop' }
        return
      if type is 'usage' or type is 'gen_info'
        broadcast
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
          contextWindow: ev.contextWindow or contextWindow
        return
      if type is 'approval_needed'
        broadcast
          type: 'approval_needed'
          id: ev.id
          name: ev.tool or ev.name
          args: ev.args or {}
          command: ev.command or ''
          reason: ev.reason or 'not on allowlist'
        return
      if type is 'status'
        broadcast { type: 'status', phase: ev.phase, sessionId: ev.sessionId }
  harness = await Angela.create createOpts
  session = await harness.session.create { title: 'desktop' }
  mcpNames = (harness.clients or []).map((c) -> c.name).join ','
  fetchModels()
    .then -> broadcast { type: 'models', models: knownModels }
    .catch ->
  console.log "[agent] ready model=#{MODEL} ctx=#{contextWindow} proxy=#{DAD_URL} session=#{session.id} mcp=#{mcpNames or '(none)'}"
  harness

enqueue = (fn) ->
  runLock = runLock.then(fn).catch (err) ->
    console.error '[agent]', err.message or err
  runLock

handleChat = (ws, data) ->
  content = String(data.content or '').trim()
  unless content
    ws.send JSON.stringify { type: 'error', error: 'empty prompt' }
    return
  await connectHarness()
  if data.allowlist != null
    handleAllowlist { text: String(data.allowlist) }
  isNew = /^\/new$/i.test content
  unless isNew
    await stripContextLoop session
  if session.running
    try
      await session.abort 'superseded'
  broadcast { type: 'status', phase: 'running' } unless isNew
  try
    result = await session.run prompt: content
    if result?.command is 'new' and result.session?
      session = result.session
      session._contextLoopOff = false
      broadcast
        type: 'session'
        command: 'new'
        sessionId: session.id
        previousId: result.previousId
      broadcast helloPayload()
      broadcast { type: 'done' }
      return
  catch err
    unless err?.aborted
      broadcast { type: 'error', error: err.message or String(err) }
  broadcast { type: 'done' }

handleAbort = ->
  return unless session?
  try
    await session.abort 'user stop'

handleAllowlist = (msg) ->
  text = if msg.text != null then String(msg.text) else ''
  allowlistText = text
  harness?.policy?.setAllowlist text

handleModel = (msg) ->
  spec = String(msg.model or '').trim()
  return unless spec
  MODEL = spec
  createOpts.model = spec if createOpts?
  try
    liveCw = Number await resolveContextWindowAsync spec, { force: true }
    contextWindow = liveCw if liveCw > 0
  catch
    syncCw = Number(resolveContextWindow(spec) or 0)
    contextWindow = syncCw if syncCw > 0
  createOpts.contextWindow = contextWindow if createOpts?
  if session?.running
    try
      await session.abort 'model change'
  if harness?
    session = await harness.session.create { title: 'desktop' }
    session._contextLoopOff = false
  broadcast helloPayload()

handleApproval = (msg) ->
  id = String(msg.id or '')
  decision = msg.decision or msg.action or 'deny'
  approvals.resolve id, decision

Bun.serve
  port: PORT
  hostname: '0.0.0.0'
  idleTimeout: 0
  fetch: (req, server) ->
    url = new URL req.url
    if url.pathname is '/health'
      return Response.json
        ok: true
        agent: true
        model: MODEL
        proxy: DAD_URL
        session: session?.id or null
    if url.pathname is '/telem'
      try
        return Response.json await sampleTelem()
      catch err
        return Response.json { error: err.message or String(err) }, { status: 500 }
    if (url.pathname is '/ws' or url.pathname is '/') and
        req.headers.get('upgrade')?.toLowerCase() is 'websocket'
      if server.upgrade req
        return undefined
      return new Response 'upgrade failed', { status: 500 }
    return new Response 'desktop-agent', { status: 200 }
  websocket:
    open: (ws) ->
      clients.add ws
      ws.send JSON.stringify helloPayload()
    message: (ws, raw) ->
      text = if typeof raw is 'string' then raw else new TextDecoder().decode raw
      msg = try JSON.parse text catch then null
      return unless msg and typeof msg is 'object'
      switch msg.type
        when 'chat', 'prompt'
          handleAbort()
          enqueue -> handleChat ws, msg
        when 'abort', 'stop' then handleAbort()
        when 'allowlist' then handleAllowlist msg
        when 'model' then enqueue -> handleModel msg
        when 'approval' then handleApproval msg
        else ws.send JSON.stringify { type: 'error', error: "unknown type #{msg.type}" }
    close: (ws) ->
      clients.delete ws
    error: (ws, err) ->
      console.error '[agent ws]', err.message or err
      clients.delete ws

try
  aglHref = import.meta.resolve 'agl-ai'
catch
  aglHref = 'unresolved'
console.log "[agent] ws://0.0.0.0:#{PORT}/ws  model=#{MODEL} agl=#{aglHref} providers=#{Object.keys(aglProviders or {}).join ','} key=#{if DAD_KEY then 'yes' else 'no'}"
# Warm MCP + Angela after the headed browser has had a moment.
setTimeout ->
  connectHarness().catch (err) ->
    console.error '[agent] warmup failed', err.message or err
, 1500
