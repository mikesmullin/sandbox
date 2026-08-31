import express from 'express'
import httpProxy from 'http-proxy'
import { watch } from 'fs'
import { extname, resolve } from 'path'
import { importSPKI, jwtVerify } from 'jose'
import { listDesktops, getDesktop, getScale, setScale, createContainer, deleteContainer, resolveTarget, dropForward } from './k8s.coffee'
import { snapshotInfo, captureSnapshot, clearSnapshot } from './snapshot.coffee'
import { attachLogClient, detachLogClient } from './logs.coffee'

PORT = Number process.env.PORT or 8080
PUBLIC_DIR = resolve import.meta.dir, '../public'
IN_CLUSTER = Boolean process.env.KUBERNETES_SERVICE_HOST
HMR = not IN_CLUSTER and process.env.HMR isnt '0'
BASE_PATH = String(process.env.BASE_PATH or '').trim().replace(/\/+$/, '')
BASE_PATH = '' if BASE_PATH is '/'
unless BASE_PATH is '' or BASE_PATH.startsWith '/'
  throw new Error 'BASE_PATH must be empty or start with /'

AUTH_COOKIE_NAME = process.env.AUTH_COOKIE_NAME or 'sretools_session'
AUTH_ISSUER = process.env.AUTH_JWT_ISSUER or 'dev-sretools-auth'
AUTH_AUDIENCE = process.env.AUTH_JWT_AUDIENCE or 'dev-sretools-apps'
authPublicKey = String(process.env.AUTH_JWT_PUBLIC_KEY or '').trim()
if not authPublicKey and process.env.AUTH_JWT_PUBLIC_KEY_FILE
  authPublicKey = String(await Bun.file(process.env.AUTH_JWT_PUBLIC_KEY_FILE).text()).trim()
authKey = if authPublicKey then await importSPKI(authPublicKey, 'EdDSA') else null

stripBasePath = (pathname) ->
  return pathname unless BASE_PATH
  return '/' if pathname is BASE_PATH
  return pathname.slice(BASE_PATH.length) if pathname.startsWith "#{BASE_PATH}/"
  null

cookieValue = (req, name) ->
  for part in String(req.headers.get('cookie') or '').split ';'
    i = part.indexOf '='
    continue if i < 0
    return part.slice(i + 1).trim() if part.slice(0, i).trim() is name
  ''

requireAuth = (req, originalPath) ->
  return null unless authKey
  token = cookieValue req, AUTH_COOKIE_NAME
  try
    await jwtVerify token, authKey,
      issuer: AUTH_ISSUER
      audience: AUTH_AUDIENCE
      algorithms: ['EdDSA']
    null
  catch
    acceptsHtml = req.method is 'GET' and String(req.headers.get('accept') or '').includes 'text/html'
    unless req.headers.get('upgrade') or not acceptsHtml
      return Response.redirect "/login?redirect=#{encodeURIComponent originalPath}", 302
    Response.json { error: 'Unauthorized' }, { status: 401 }

app = express()
app.disable 'x-powered-by'
app.use express.json()

proxy = httpProxy.createProxyServer
  ws: true
  changeOrigin: true
  xfwd: true
  timeout: 0
  proxyTimeout: 0

proxy.on 'error', (err, req, res) ->
  console.error "[proxy] #{req?.url or ''} #{err.message}"
  if res and not res.headersSent and typeof res.writeHead is 'function'
    res.writeHead 502, { 'content-type': 'application/json' }
    res.end JSON.stringify { error: err.message }
  else if res?.destroy
    res.destroy()

app.get '/api/health', (req, res) ->
  res.json
    ok: true
    inCluster: IN_CLUSTER
    hmr: HMR
    ns: process.env.NAMESPACE or 'agent-desktop'

fallbackWs = -> [{ id: 'workspace', name: 'workspace', current: true }]

attachWorkspaces = (desk) ->
  unless desk.ready
    desk.workspaces = fallbackWs()
    return desk
  try
    target = await resolveTarget desk.name
    ac = new AbortController()
    t = setTimeout (-> ac.abort()), 1500
    r = await fetch "http://#{target.host}:#{target.agentPort or 8091}/workspaces",
      signal: ac.signal
    clearTimeout t
    body = await r.json().catch -> {}
    desk.workspaces = body.workspaces or fallbackWs()
  catch
    desk.workspaces = fallbackWs()
  desk

agentUnreachable = (err) ->
  msg = String err?.message or err
  /socket connection was closed|ECONNRESET|ECONNREFUSED|Connection ended|Unable to connect/i.test msg

fetchAgent = (target, path, opts = {}) ->
  init =
    method: opts.method or 'GET'
  init.signal = opts.signal if opts.signal?
  headers = {}
  if opts.headers
    for k, v of opts.headers
      headers[k] = v if v?
  if opts.body?
    headers['content-type'] or= 'application/json'
    init.body = if typeof opts.body is 'string' then opts.body else JSON.stringify opts.body
  init.headers = headers if Object.keys(headers).length
  fetch "http://#{target.host}:#{target.agentPort or 8091}#{path}", init

agentFetchOpts = (req, opts = {}) ->
  method = opts.method or req.method
  body = opts.body
  if body is undefined and method not in ['GET', 'HEAD', 'DELETE']
    body = if req.body? then req.body else {}
  out = { method, signal: opts.signal }
  out.body = body if body isnt undefined and method not in ['GET', 'HEAD', 'DELETE']
  out

proxyAgent = (req, res, path, opts = {}) ->
  name = req.params.name
  fetchOpts = agentFetchOpts req, opts
  target = await resolveTarget name
  r = null
  try
    r = await fetchAgent target, path, fetchOpts
  catch err
    if IN_CLUSTER or not agentUnreachable err
      throw Object.assign err, { status: 502 }
    console.warn "[api] agent #{name}#{path} dead forward, retrying"
    dropForward name
    target = await resolveTarget name
    r = await fetchAgent target, path, fetchOpts
  unless opts.raw
    body = await r.json().catch -> { error: 'bad agent response' }
    return res.status(r.status).json body
  buf = Buffer.from await r.arrayBuffer()
  res.status(r.status)
  r.headers.forEach (v, k) ->
    return if k in ['transfer-encoding', 'connection']
    res.setHeader k, v
  res.end buf

app.get '/api/desktops', (req, res) ->
  try
    [desktops, scale] = await Promise.all [listDesktops(), getScale()]
    desktops = await Promise.all desktops.map attachWorkspaces
    res.json { desktops, scale, snapshot: snapshotInfo() }
  catch err
    console.error '[api] list', err
    res.status(500).json { error: err.message }

app.get '/api/desktops/:name', (req, res) ->
  try
    desk = await getDesktop req.params.name
    unless desk?
      return res.status(404).json { error: 'not found' }
    res.json desk
  catch err
    res.status(500).json { error: err.message }

app.post '/api/desktops', (req, res) ->
  try
    created = await createContainer()
    desktops = await Promise.all (await listDesktops()).map attachWorkspaces
    res.json { container: created, scale: created.scale, desktops, snapshot: snapshotInfo() }
  catch err
    console.error '[api] create', err
    res.status(err.status or 400).json { error: err.message }

app.delete '/api/desktops/:name', (req, res) ->
  try
    deleted = await deleteContainer req.params.name
    desktops = await Promise.all (await listDesktops()).map attachWorkspaces
    res.json { container: deleted, scale: deleted.scale, desktops, snapshot: snapshotInfo() }
  catch err
    console.error '[api] delete', err
    res.status(err.status or 400).json { error: err.message }

app.patch '/api/desktops', (req, res) ->
  try
    scale = await setScale req.body?.replicas
    desktops = await Promise.all (await listDesktops()).map attachWorkspaces
    res.json { scale, desktops, snapshot: snapshotInfo() }
  catch err
    console.error '[api] scale', err
    res.status(400).json { error: err.message }

app.get '/api/snapshot', (req, res) ->
  res.json snapshotInfo()

app.post '/api/snapshot', (req, res) ->
  try
    name = String(req.body?.container or req.body?.name or '').trim()
    unless name
      return res.status(400).json { error: 'container name required' }
    desk = await getDesktop name
    unless desk?
      return res.status(404).json { error: "container #{name} not found" }
    unless desk.ready
      return res.status(409).json { error: "container #{name} is not ready" }
    snap = await captureSnapshot name
    res.json snap
  catch err
    console.error '[api] snapshot capture', err
    res.status(err.status or 500).json { error: err.message }

app.delete '/api/snapshot', (req, res) ->
  try
    res.json clearSnapshot()
  catch err
    res.status(500).json { error: err.message }

app.get '/api/desktops/:name/telem', (req, res) ->
  try
    await proxyAgent req, res, '/telem'
  catch err
    code = err.status or 502
    res.status(code).json { error: 'agent not reachable' }

app.get '/api/desktops/:name/workspaces', (req, res) ->
  try
    await proxyAgent req, res, '/workspaces'
  catch err
    code = err.status or 502
    res.status(code).json { error: 'agent not reachable' }

app.post '/api/desktops/:name/workspaces', (req, res) ->
  try
    await proxyAgent req, res, '/workspaces', { method: 'POST' }
  catch err
    code = err.status or 502
    res.status(code).json { error: 'agent not reachable' }

app.post '/api/desktops/:name/workspaces/scan', (req, res) ->
  try
    await proxyAgent req, res, '/workspaces/scan', { method: 'POST' }
  catch err
    code = err.status or 502
    res.status(code).json { error: 'agent not reachable' }

app.delete '/api/desktops/:name/workspaces/:id', (req, res) ->
  try
    await proxyAgent req, res, "/workspaces/#{encodeURIComponent req.params.id}", { method: 'DELETE' }
  catch err
    code = err.status or 502
    res.status(code).json { error: 'agent not reachable' }

app.patch '/api/desktops/:name/workspaces/:id', (req, res) ->
  try
    await proxyAgent req, res, "/workspaces/#{encodeURIComponent req.params.id}", { method: 'PATCH' }
  catch err
    code = err.status or 502
    res.status(code).json { error: 'agent not reachable' }

app.post '/api/desktops/:name/workspaces/:id/focus', (req, res) ->
  try
    await proxyAgent req, res, "/workspaces/#{encodeURIComponent req.params.id}/focus", { method: 'POST' }
  catch err
    code = err.status or 502
    res.status(code).json { error: 'agent not reachable' }

app.get '/api/desktops/:name/workspaces/:id/thumb', (req, res) ->
  try
    await proxyAgent req, res, "/workspaces/#{encodeURIComponent req.params.id}/thumb", { raw: true }
  catch err
    code = err.status or 502
    res.status(code).json { error: 'agent not reachable' }

jobPath = (req, extra = '') ->
  ws = encodeURIComponent req.params.id
  base = "/workspaces/#{ws}/jobs"
  return base unless extra
  "#{base}/#{extra}"

app.get '/api/desktops/:name/workspaces/:id/jobs', (req, res) ->
  try
    await proxyAgent req, res, jobPath req
  catch err
    code = err.status or 502
    res.status(code).json { error: 'agent not reachable' }

app.post '/api/desktops/:name/workspaces/:id/jobs', (req, res) ->
  try
    await proxyAgent req, res, jobPath(req), { method: 'POST' }
  catch err
    code = err.status or 502
    res.status(code).json { error: 'agent not reachable' }

app.get '/api/desktops/:name/workspaces/:id/jobs/:task_id', (req, res) ->
  try
    await proxyAgent req, res, jobPath req, encodeURIComponent req.params.task_id
  catch err
    code = err.status or 502
    res.status(code).json { error: 'agent not reachable' }

app.post '/api/desktops/:name/workspaces/:id/jobs/:task_id/abort', (req, res) ->
  try
    await proxyAgent req, res, jobPath(req, "#{encodeURIComponent req.params.task_id}/abort"), { method: 'POST' }
  catch err
    code = err.status or 502
    res.status(code).json { error: 'agent not reachable' }

app.use express.static PUBLIC_DIR, { fallthrough: true, index: false }

# Selkies HTML5 client + assets. Selkies runs with SELKIES_SUBFOLDER=/desktops/<pod>
# so every route it emits is prefixed. Express strips the mount prefix from req.url,
# so forward req.originalUrl (which keeps /desktops/<name>/...) to match the subfolder.
app.use '/desktops/:name', (req, res) ->
  name = req.params.name
  resolveTarget name
    .then ({ host, port }) ->
      req.url = req.originalUrl
      proxy.web req, res, { target: "http://#{host}:#{port}" }
    .catch (err) ->
      code = err.status or 502
      res.status(code).json { error: err.message }

indexHtml = ->
  html = await Bun.file(resolve PUBLIC_DIR, 'index.html').text()
  baseHref = "#{BASE_PATH or ''}/"
  html = html.replace '<!-- base-path -->', "<base href=\"#{baseHref}\">"
  if HMR and not html.includes 'hot-client.js'
    snippet = '  <script type="module" src="js/hot-client.js"></script>\n'
    html = html.replace '</body>', "#{snippet}</body>"
  html

app.use (req, res, next) ->
  return next() if req.path.startsWith '/api/' or req.path.startsWith '/desktops/'
  # Missing JS/CSS/wasm must 404. Serving index.html here makes ES module
  # graphs fail with an opaque "Failed to fetch dynamically imported module".
  if extname req.path
    res.status(404).type('text/plain').send 'not found'
    return
  indexHtml()
    .then (html) -> res.type('html').send html
    .catch next

# Bun's node:http polyfill does not complete WebSocket upgrades through
# http-proxy. Express handles REST + static on loopback; Bun.serve is the
# public socket and message-pipes each pod's Selkies + agent WebSockets.
hmrClients = new Set()

broadcastHmr = (relPath) ->
  rel = String(relPath or '').replace(/\\/g, '/').replace /^\.?\//, ''
  return unless rel
  payload = JSON.stringify { type: 'change', path: "/#{rel}" }
  n = 0
  for sock from hmrClients
    try
      sock.send payload
      n++
    catch then null
  console.log "[hmr] #{rel} → #{n} client(s)"
  null

if HMR
  debounces = new Map()
  debounce = (key, ms, fn) ->
    clearTimeout debounces.get key
    debounces.set key, setTimeout fn, ms
  try
    watch PUBLIC_DIR, { recursive: true }, (event, fname) ->
      return unless fname?
      rel = String(fname).replace /\\/g, '/'
      return if rel is 'js/hot-client.js' or rel.startsWith 'vendor/'
      ext = extname(rel).toLowerCase()
      return unless ext in ['.js', '.mjs', '.css', '.html']
      debounce "hmr:#{rel}", 50, -> broadcastHmr rel
    console.log "[hmr] watching #{PUBLIC_DIR}"
  catch err
    console.warn "[hmr] watch failed: #{err.message}"

expressServer = app.listen 0, '127.0.0.1', ->
  inner = expressServer.address().port
  where = if IN_CLUSTER then 'in-cluster' else 'host'
  Bun.serve
    port: PORT
    hostname: '0.0.0.0'
    idleTimeout: 0
    fetch: (req, server) ->
      url = new URL req.url
      originalPath = url.pathname + url.search
      pathname = stripBasePath url.pathname
      return new Response 'not found', { status: 404 } unless pathname?
      if BASE_PATH and url.pathname is BASE_PATH
        return Response.redirect "#{url.origin}#{BASE_PATH}/", 308
      unless pathname is '/api/health'
        authResponse = await requireAuth req, originalPath
        return authResponse if authResponse
      if pathname is '/__m_hmr'
        unless HMR
          return new Response 'hmr off', { status: 404 }
        if req.headers.get('upgrade')?.toLowerCase() is 'websocket'
          if server.upgrade req, { data: { kind: 'hmr' } }
            return undefined
          return new Response 'upgrade failed', { status: 500 }
        return new Response 'hmr websocket', { status: 426 }
      logMatch = pathname.match /^\/desktops\/([^/]+)\/logs\/?$/
      if logMatch and req.headers.get('upgrade')?.toLowerCase() is 'websocket'
        name = decodeURIComponent logMatch[1]
        if server.upgrade req, { data: { kind: 'logs', name } }
          return undefined
        return new Response 'upgrade failed', { status: 500 }
      wsRoom = pathname.match /^\/desktops\/([^/]+)\/workspaces\/([^/]+)\/agent\/?$/
      if wsRoom and req.headers.get('upgrade')?.toLowerCase() is 'websocket'
        name = decodeURIComponent wsRoom[1]
        workspace = decodeURIComponent wsRoom[2]
        try
          target = await resolveTarget name
        catch err
          console.error "[ws] #{name} #{workspace}", err.message
          return new Response err.message, { status: err.status or 502 }
        if server.upgrade req, { data: { name, target, kind: 'agent', workspace, queue: [], upstream: null } }
          return undefined
        return new Response 'upgrade failed', { status: 500 }
      wsMatch = pathname.match /^\/desktops\/([^/]+)\/agent\/?$/
      if wsMatch and req.headers.get('upgrade')?.toLowerCase() is 'websocket'
        name = decodeURIComponent wsMatch[1]
        try
          target = await resolveTarget name
        catch err
          console.error "[ws] #{name}", err.message
          return new Response err.message, { status: err.status or 502 }
        if server.upgrade req, { data: { name, target, kind: 'agent', workspace: null, queue: [], upstream: null } }
          return undefined
        return new Response 'upgrade failed', { status: 500 }
      # Selkies opens WebSocket(s) under its subfolder (signaling + media). We do
      # not know the exact suffix, so catch every upgrade under /desktops/<name>/
      # the explicit matchers above did not claim and pipe the WHOLE path to the pod.
      selkiesMatch = pathname.match /^\/desktops\/([^/]+)\/(.+)$/
      if selkiesMatch and req.headers.get('upgrade')?.toLowerCase() is 'websocket'
        name = decodeURIComponent selkiesMatch[1]
        try
          target = await resolveTarget name
        catch err
          console.error "[ws] selkies #{name}", err.message
          return new Response err.message, { status: err.status or 502 }
        proto = req.headers.get 'sec-websocket-protocol'
        data = { name, target, kind: 'selkies', path: pathname + url.search, proto, workspace: null, queue: [], upstream: null }
        upOpts = { data }
        # Echo the negotiated subprotocol so the browser accepts the handshake.
        upOpts.headers = { 'Sec-WebSocket-Protocol': proto.split(',')[0].trim() } if proto
        if server.upgrade req, upOpts
          return undefined
        return new Response 'upgrade failed', { status: 500 }
      headers = new Headers
      req.headers.forEach (value, key) ->
        return if key in ['connection', 'keep-alive', 'transfer-encoding']
        headers.set key, value
      headers.set 'host', "127.0.0.1:#{inner}"
      init =
        method: req.method
        headers: headers
        redirect: 'manual'
      unless req.method in ['GET', 'HEAD']
        init.body = req.body
        init.duplex = 'half'
      globalThis.fetch "http://127.0.0.1:#{inner}#{pathname}#{url.search}", init
    websocket:
      open: (ws) ->
        if ws.data?.kind is 'hmr'
          hmrClients.add ws
          ws.send JSON.stringify { type: 'connected', version: 'm-js-hmr' }
          return
        if ws.data?.kind is 'logs'
          attachLogClient ws.data.name, ws
          return
        { name, target, kind, workspace } = ws.data
        upstreamUrl = if kind is 'selkies'
          "ws://#{target.host}:#{target.port}#{ws.data.path}"
        else if kind is 'agent'
          if workspace
            "ws://#{target.host}:#{target.agentPort or 8091}/workspaces/#{encodeURIComponent workspace}/ws"
          else
            "ws://#{target.host}:#{target.agentPort or 8091}/ws"
        else
          "ws://#{target.host}:#{target.port}/"
        console.log "[ws] #{kind} #{name}#{if workspace then ':' + workspace else ''} -> #{upstreamUrl}"
        upstream = if ws.data.proto
          new WebSocket upstreamUrl, ws.data.proto.split(',').map (p) -> p.trim()
        else
          new WebSocket upstreamUrl
        ws.data.upstream = upstream
        unless kind is 'agent'
          upstream.binaryType = 'arraybuffer'
        upstream.addEventListener 'open', ->
          for frame in ws.data.queue
            upstream.send frame
          ws.data.queue = []
        upstream.addEventListener 'message', (ev) ->
          try ws.send ev.data
        upstream.addEventListener 'close', (ev) ->
          try ws.close ev.code, ev.reason
        upstream.addEventListener 'error', (ev) ->
          console.error "[ws] upstream #{name}", ev.message or ev
          try ws.close()
      message: (ws, msg) ->
        return if ws.data?.kind is 'hmr' or ws.data?.kind is 'logs'
        upstream = ws.data.upstream
        if upstream?.readyState is WebSocket.OPEN
          upstream.send msg
        else
          ws.data.queue.push msg
      close: (ws) ->
        if ws.data?.kind is 'hmr'
          hmrClients.delete ws
          return
        if ws.data?.kind is 'logs'
          detachLogClient ws.data.name, ws
          return
        try ws.data.upstream?.close()
      error: (ws, err) ->
        if ws.data?.kind is 'hmr'
          hmrClients.delete ws
          return
        if ws.data?.kind is 'logs'
          detachLogClient ws.data.name, ws
          return
        console.error "[ws] client #{ws.data?.name}", err?.message or err
        try ws.data.upstream?.close()
  extra = if HMR then "  hmr ws://127.0.0.1:#{PORT}/__m_hmr" else ''
  console.log "[control] http://0.0.0.0:#{PORT}#{BASE_PATH or '/'}  (#{where}, express :#{inner})#{extra}"
