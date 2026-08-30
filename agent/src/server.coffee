# Desktop owner — Angela + cowork tools (file-io, term-local) + agent-browser MCP.
# One Angela session per XFCE workspace; chat WS is scoped to that workspace.
# Browser MCP is pin-tab'd to that workspace's Chromium window (shared profile).

import { providers as aglProviders } from 'agl-ai'
import { sampleTelem } from './telem.coffee'
import {
  listWorkspaces, addWorkspace, removeWorkspace,
  focusWorkspace, thumbFile, resumeScan, startScanLoop,
  setWorkspaceLabel,
} from './workspaces.coffee'
import {
  ensureRoom, destroyRoom, warmupRooms, fetchModels,
  attachClient, detachClient, healthSessions, getRoom,
  handleChat, handleAbort, handleAllowlist, handleModel, handleApproval,
  handleVisible,
} from './rooms.coffee'
import {
  createJob, getJob, listJobs, abortJob, workspaceBusy,
} from './jobs.mjs'

PORT = Number process.env.AGENT_PORT or 8091
MODEL = process.env.AGENT_MODEL or 'llama-server:default'
DAD_URL = process.env.DAD_PROXY_URL or process.env.LLAMA_SERVER_BASE_URL or 'https://host.containers.internal:1234'
DAD_KEY = process.env.DAD_PROXY_API_KEY or process.env.LLM_PROXY_API_KEY or process.env.LLAMA_SERVER_API_KEY or ''

withRoom = (ws, id) ->
  name = ws.data?.workspace or id
  await ensureRoom name

enrichWorkspaces = (listed) ->
  for w in listed.workspaces or []
    room = getRoom w.id
    w.session_id = room?.session?.id or w.sessionId or null
    w.busy = workspaceBusy room
  listed

readJson = (req) ->
  req.json().catch -> {}

Bun.serve
  port: PORT
  hostname: '0.0.0.0'
  idleTimeout: 0
  fetch: (req, server) ->
    url = new URL req.url
    if url.pathname is '/health'
      current = try listWorkspaces().current catch then null
      return Response.json
        ok: true
        agent: true
        model: MODEL
        proxy: DAD_URL
        workspace: current
        session: healthSessions()[current]?.session or null
        workspaces: healthSessions()
    if url.pathname is '/telem'
      try
        return Response.json await sampleTelem()
      catch err
        return Response.json { error: err.message or String(err) }, { status: 500 }
    if url.pathname is '/workspaces' and req.method is 'GET'
      try
        return Response.json enrichWorkspaces listWorkspaces()
      catch err
        return Response.json { error: err.message or String(err) }, { status: 500 }
    if url.pathname is '/workspaces' and req.method is 'POST'
      try
        listed = addWorkspace()
        try
          await ensureRoom listed.current
        catch err
          console.error '[agent] ensure room', listed.current, err.message or err
        return Response.json enrichWorkspaces listWorkspaces()
      catch err
        return Response.json { error: err.message or String(err) }, { status: err.status or 400 }
    if url.pathname is '/workspaces/scan' and req.method is 'POST'
      try
        return Response.json enrichWorkspaces resumeScan()
      catch err
        return Response.json { error: err.message or String(err) }, { status: err.status or 400 }
    wsDel = url.pathname.match /^\/workspaces\/([^/]+)\/?$/
    if wsDel and req.method is 'DELETE'
      try
        listed = removeWorkspace decodeURIComponent wsDel[1]
        if listed.dropped
          try
            await destroyRoom listed.dropped
          catch err
            console.error '[agent] destroy room', listed.dropped, err.message or err
        delete listed.dropped
        delete listed.droppedTargetId
        return Response.json enrichWorkspaces listed
      catch err
        return Response.json { error: err.message or String(err) }, { status: err.status or 400 }
    if wsDel and req.method is 'PATCH'
      try
        body = await readJson req
        listed = setWorkspaceLabel decodeURIComponent(wsDel[1]), body.label
        return Response.json enrichWorkspaces listed
      catch err
        return Response.json { error: err.message or String(err) }, { status: err.status or 400 }
    wsFocus = url.pathname.match /^\/workspaces\/([^/]+)\/focus\/?$/
    if wsFocus and req.method is 'POST'
      try
        return Response.json enrichWorkspaces focusWorkspace decodeURIComponent wsFocus[1]
      catch err
        return Response.json { error: err.message or String(err) }, { status: err.status or 400 }
    wsThumb = url.pathname.match /^\/workspaces\/([^/]+)\/thumb\/?$/
    if wsThumb and req.method is 'GET'
      try
        got = await thumbFile decodeURIComponent wsThumb[1]
        unless got?
          return new Response 'no thumb', { status: 404 }
        return new Response got.file, { headers: { 'content-type': 'image/png', 'cache-control': 'no-store' } }
      catch err
        return Response.json { error: err.message or String(err) }, { status: 500 }
    wsJobAbort = url.pathname.match /^\/workspaces\/([^/]+)\/jobs\/([^/]+)\/abort\/?$/
    if wsJobAbort and req.method is 'POST'
      try
        room = await ensureRoom decodeURIComponent wsJobAbort[1]
        body = await readJson req
        job = await abortJob room, decodeURIComponent(wsJobAbort[2]), body.reason or 'abort'
        return Response.json job
      catch err
        return Response.json { error: err.message or String(err) }, { status: err.status or 400 }
    wsJob = url.pathname.match /^\/workspaces\/([^/]+)\/jobs\/([^/]+)\/?$/
    if wsJob and req.method is 'GET'
      try
        room = await ensureRoom decodeURIComponent wsJob[1]
        job = getJob room, decodeURIComponent wsJob[2]
        unless job?
          return Response.json { error: 'job not found' }, { status: 404 }
        return Response.json job
      catch err
        return Response.json { error: err.message or String(err) }, { status: err.status or 400 }
    wsJobs = url.pathname.match /^\/workspaces\/([^/]+)\/jobs\/?$/
    if wsJobs and req.method is 'GET'
      try
        room = await ensureRoom decodeURIComponent wsJobs[1]
        return Response.json { jobs: listJobs room }
      catch err
        return Response.json { error: err.message or String(err) }, { status: err.status or 400 }
    if wsJobs and req.method is 'POST'
      try
        room = await ensureRoom decodeURIComponent wsJobs[1]
        body = await readJson req
        created = await createJob room,
          goal: body.goal
          task_id: body.task_id or body.taskId
        return Response.json created, { status: 202 }
      catch err
        return Response.json { error: err.message or String(err) }, { status: err.status or 400 }
    upgrade = req.headers.get('upgrade')?.toLowerCase() is 'websocket'
    wsRoom = url.pathname.match /^\/workspaces\/([^/]+)\/ws\/?$/
    if wsRoom and upgrade
      if server.upgrade req, { data: { workspace: decodeURIComponent wsRoom[1] } }
        return undefined
      return new Response 'upgrade failed', { status: 500 }
    if (url.pathname is '/ws' or url.pathname is '/') and upgrade
      current = try listWorkspaces().current catch then null
      if server.upgrade req, { data: { workspace: current } }
        return undefined
      return new Response 'upgrade failed', { status: 500 }
    return new Response 'desktop-agent', { status: 200 }
  websocket:
    open: (ws) ->
      id = ws.data?.workspace
      attachClient ws, id
        .catch (err) ->
          console.error '[agent ws] attach', err.message or err
          try
            ws.send JSON.stringify { type: 'error', error: err.message or String(err) }
          try ws.close()
    message: (ws, raw) ->
      text = if typeof raw is 'string' then raw else new TextDecoder().decode raw
      msg = try JSON.parse text catch then null
      return unless msg and typeof msg is 'object'
      withRoom ws, ws.data?.workspace
        .then (room) ->
          switch msg.type
            when 'chat', 'prompt'
              handleAbort room
              room.runLock = (room.runLock or Promise.resolve())
                .then -> handleChat room, ws, msg
                .catch (err) -> console.error "[agent #{room.name}]", err.message or err
            when 'abort', 'stop' then handleAbort room
            when 'allowlist' then handleAllowlist room, msg, ws
            when 'model'
              room.runLock = (room.runLock or Promise.resolve())
                .then -> handleModel room, msg
                .catch (err) -> console.error "[agent #{room.name}]", err.message or err
            when 'approval' then handleApproval room, msg
            when 'visible' then handleVisible room, msg
            else ws.send JSON.stringify { type: 'error', error: "unknown type #{msg.type}" }
        .catch (err) ->
          try ws.send JSON.stringify { type: 'error', error: err.message or String(err) }
    close: (ws) ->
      detachClient ws
    error: (ws, err) ->
      console.error '[agent ws]', err.message or err
      detachClient ws

try
  aglHref = import.meta.resolve 'agl-ai'
catch
  aglHref = 'unresolved'
console.log "[agent] ws://0.0.0.0:#{PORT}/workspaces/:id/ws  model=#{MODEL} agl=#{aglHref} providers=#{Object.keys(aglProviders or {}).join ','} key=#{if DAD_KEY then 'yes' else 'no'}"
startScanLoop()
# Warm a room per XFCE workspace after the headed browser has had a moment.
setTimeout ->
  warmupRooms()
    .then -> fetchModels()
    .catch (err) ->
      console.error '[agent] warmup failed', err.message or err
, 1500
