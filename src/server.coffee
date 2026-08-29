import express from 'express'
import httpProxy from 'http-proxy'
import { watch } from 'fs'
import { extname, resolve } from 'path'
import { listDesktops, getDesktop, getScale, setScale, resolveTarget } from './k8s.coffee'
import { attachLogClient, detachLogClient } from './logs.coffee'

PORT = Number process.env.PORT or 8080
PUBLIC_DIR = resolve import.meta.dir, '../public'
IN_CLUSTER = Boolean process.env.KUBERNETES_SERVICE_HOST
HMR = not IN_CLUSTER and process.env.HMR isnt '0'

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

app.get '/api/desktops', (req, res) ->
  try
    [desktops, scale] = await Promise.all [listDesktops(), getScale()]
    res.json { desktops, scale }
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

app.patch '/api/desktops', (req, res) ->
  try
    scale = await setScale req.body?.replicas
    desktops = await listDesktops()
    res.json { scale, desktops }
  catch err
    console.error '[api] scale', err
    res.status(400).json { error: err.message }

app.get '/api/desktops/:name/telem', (req, res) ->
  try
    target = await resolveTarget req.params.name
    r = await fetch "http://#{target.host}:#{target.agentPort or 8091}/telem"
    body = await r.json().catch -> { error: 'bad telem' }
    unless r.ok
      return res.status(r.status).json body
    res.json body
  catch err
    code = err.status or 502
    res.status(code).json { error: err.message }

app.use express.static PUBLIC_DIR, { fallthrough: true, index: false }

# HTTP noVNC assets (debug / iframe fallback). Express strips the mount prefix
# so req.url is already the remainder (e.g. /vnc.html).
app.use '/desktops/:name', (req, res) ->
  name = req.params.name
  resolveTarget name
    .then ({ host, port }) ->
      req.url = '/' if not req.url or req.url is ''
      proxy.web req, res, { target: "http://#{host}:#{port}" }
    .catch (err) ->
      code = err.status or 502
      res.status(code).json { error: err.message }

indexHtml = ->
  html = await Bun.file(resolve PUBLIC_DIR, 'index.html').text()
  if HMR and not html.includes 'hot-client.js'
    snippet = '  <script type="module" src="/js/hot-client.js"></script>\n'
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
# public socket and message-pipes RFB to each pod's websockify.
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
      if url.pathname is '/__m_hmr'
        unless HMR
          return new Response 'hmr off', { status: 404 }
        if req.headers.get('upgrade')?.toLowerCase() is 'websocket'
          if server.upgrade req, { data: { kind: 'hmr' } }
            return undefined
          return new Response 'upgrade failed', { status: 500 }
        return new Response 'hmr websocket', { status: 426 }
      logMatch = url.pathname.match /^\/desktops\/([^/]+)\/logs\/?$/
      if logMatch and req.headers.get('upgrade')?.toLowerCase() is 'websocket'
        name = decodeURIComponent logMatch[1]
        if server.upgrade req, { data: { kind: 'logs', name } }
          return undefined
        return new Response 'upgrade failed', { status: 500 }
      wsMatch = url.pathname.match /^\/desktops\/([^/]+)\/(websockify|agent)\/?$/
      if wsMatch and req.headers.get('upgrade')?.toLowerCase() is 'websocket'
        name = decodeURIComponent wsMatch[1]
        kind = wsMatch[2]
        try
          target = await resolveTarget name
        catch err
          console.error "[ws] #{name}", err.message
          return new Response err.message, { status: err.status or 502 }
        if server.upgrade req, { data: { name, target, kind, queue: [], upstream: null } }
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
      globalThis.fetch "http://127.0.0.1:#{inner}#{url.pathname}#{url.search}", init
    websocket:
      open: (ws) ->
        if ws.data?.kind is 'hmr'
          hmrClients.add ws
          ws.send JSON.stringify { type: 'connected', version: 'm-js-hmr' }
          return
        if ws.data?.kind is 'logs'
          attachLogClient ws.data.name, ws
          return
        { name, target, kind } = ws.data
        upstreamUrl = if kind is 'agent'
          "ws://#{target.host}:#{target.agentPort or 8091}/ws"
        else
          "ws://#{target.host}:#{target.port}/websockify"
        console.log "[ws] #{kind or 'novnc'} #{name} -> #{upstreamUrl}"
        upstream = new WebSocket upstreamUrl
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
  console.log "[control] http://0.0.0.0:#{PORT}  (#{where}, express :#{inner})#{extra}"
