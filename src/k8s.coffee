# Talk to the Kind cluster. In-cluster we hit pod IPs directly.
# From the host we open a kubectl port-forward per desktop.
# Container pods are created one-by-one as container-<6 hex> (sha1 of random
# bytes) so a deleted instance is never reborn under the same name.
import { createHash, randomBytes } from 'node:crypto'
import { snapshotPresent, patchPodForSnapshot, injectSnapshot } from './snapshot.coffee'

NAMESPACE = process.env.NAMESPACE or 'agent-desktop'
APP = process.env.DESKTOP_APP or 'container'
STATEFULSET = process.env.DESKTOP_STATEFULSET or 'container'
# Selkies serves the HTML5 client + H.264/Opus stream on one port.
STREAM_PORT = Number(process.env.SELKIES_PORT or process.env.NOVNC_PORT or 6080)
AGENT_PORT = Number process.env.AGENT_PORT or 8091
IN_CLUSTER = Boolean process.env.KUBERNETES_SERVICE_HOST
MAX_CONTAINERS = 8

forwards = new Map # name -> { port, proc }

shortId = (used) ->
  for _ in [0...24]
    hex = createHash('sha1').update(randomBytes 32).digest('hex')[0...6]
    cand = "container-#{hex}"
    continue if used?.has cand
    return hex
  throw new Error 'could not allocate container id'

run = (args, opts = {}) ->
  spawn =
    stdout: 'pipe'
    stderr: 'pipe'
    env: process.env
  if opts.stdin?
    spawn.stdin = if typeof opts.stdin is 'string'
      new TextEncoder().encode opts.stdin
    else
      opts.stdin
  proc = Bun.spawnSync ['kubectl', args...], spawn
  stdout = new TextDecoder().decode proc.stdout
  stderr = new TextDecoder().decode proc.stderr
  if proc.exitCode isnt 0 and not opts.allowFail
    err = (stderr or stdout or "kubectl #{args.join ' '} failed").trim()
    throw new Error err
  { stdout, stderr, exitCode: proc.exitCode }

runJson = (args) ->
  { stdout } = run args
  JSON.parse stdout

export listDesktops = ->
  data = runJson [
    'get', 'pods'
    '-n', NAMESPACE
    '-l', "app=#{APP}"
    '-o', 'json'
  ]
  items = (data.items or []).filter (pod) -> not pod.metadata?.deletionTimestamp
  live = (pod.metadata.name for pod in items)
  pruneForwards live
  items.map (pod) ->
    conds = pod.status?.conditions or []
    readyCond = conds.find (c) -> c.type is 'Ready'
    name = pod.metadata.name
    ip = pod.status?.podIP or null
    ready = readyCond?.status is 'True' and Boolean ip
    {
      name
      ip
      ready
      phase: pod.status?.phase or 'Unknown'
      node: pod.spec?.nodeName or null
      startedAt: pod.status?.startTime or null
      restarts: (pod.status?.containerStatuses or []).reduce ((n, c) -> n + (c.restartCount or 0)), 0
      url: "/desktops/#{name}/"
      agentUrl: "/desktops/#{name}/agent"
    }

export getDesktop = (name) ->
  (await listDesktops()).find (d) -> d.name is name

export getScale = ->
  items = await listDesktops()
  {
    replicas: items.length
    ready: items.filter((d) -> d.ready).length
    current: items.filter((d) -> d.phase is 'Running').length
  }

podFromTemplate = (name) ->
  sts = runJson [
    'get', 'statefulset', STATEFULSET
    '-n', NAMESPACE
    '-o', 'json'
  ]
  tpl = sts.spec?.template
  unless tpl?.spec?
    throw new Error "statefulset/#{STATEFULSET} has no pod template"
  labels = Object.assign {}, (tpl.metadata?.labels or {}), { app: APP }
  {
    apiVersion: 'v1'
    kind: 'Pod'
    metadata:
      name: name
      namespace: NAMESPACE
      labels: labels
    spec: tpl.spec
  }

export createContainer = ->
  items = await listDesktops()
  if items.length >= MAX_CONTAINERS
    throw Object.assign new Error("at most #{MAX_CONTAINERS} containers"), { status: 400 }
  used = new Set (d.name for d in items)
  name = "container-#{shortId used}"
  pod = podFromTemplate name
  pod = patchPodForSnapshot pod
  run ['apply', '-f', '-'], { stdin: JSON.stringify pod }
  if snapshotPresent()
    try
      await injectSnapshot name
    catch err
      console.error "[snapshot] inject #{name}:", err.message or err
  { name, scale: await getScale() }

export deleteContainer = (name) ->
  unless name
    throw Object.assign new Error('container name required'), { status: 400 }
  desk = await getDesktop name
  unless desk?
    throw Object.assign new Error("container #{name} not found"), { status: 404 }
  run ['delete', 'pod', name, '-n', NAMESPACE, '--wait=false']
  dropForward name
  { name, scale: await getScale() }

export ensureContainers = (n = 1) ->
  n = Math.max 0, Math.min MAX_CONTAINERS, Number(n)
  unless Number.isFinite n
    throw new Error 'count must be a number'
  items = await listDesktops()
  while items.length < n
    await createContainer()
    items = await listDesktops()
  getScale()

export setScale = (replicas) ->
  n = Math.max 0, Math.min MAX_CONTAINERS, Number replicas
  unless Number.isFinite n
    throw new Error 'replicas must be a number'
  items = await listDesktops()
  while items.length < n
    await createContainer()
    items = await listDesktops()
  if items.length > n
    throw Object.assign new Error('delete a specific container; names are unique'), { status: 400 }
  getScale()

parseForwardPorts = (text) ->
  stream = null
  agent = null
  re = /Forwarding from (?:127\.0\.0\.1|\[::1\]):(\d+)\s+->\s+(\d+)/g
  s = String text
  while (m = re.exec s)
    local = Number m[1]
    remote = Number m[2]
    if remote is STREAM_PORT
      stream ?= local
    else if remote is AGENT_PORT
      agent ?= local
  { stream, agent }

startForward = (name) ->
  # Both the Selkies stream and the Angela WS. kubectl prints "Forwarding from" on stderr.
  proc = Bun.spawn [
    'kubectl', 'port-forward'
    '-n', NAMESPACE
    "pod/#{name}"
    ":#{STREAM_PORT}"
    ":#{AGENT_PORT}"
  ],
    stdout: 'pipe'
    stderr: 'pipe'
    env: process.env

  decoder = new TextDecoder()
  buf = ''
  eat = (stream) ->
    return unless stream?
    reader = stream.getReader()
    loop
      { done, value } = await reader.read()
      break if done
      buf += decoder.decode value, { stream: true }

  eat(proc.stdout).catch ->
  eat(proc.stderr).catch ->

  deadline = Date.now() + 8000
  ports = { stream: null, agent: null }
  while Date.now() < deadline
    ports = parseForwardPorts buf
    break if ports.stream? and ports.agent?
    await Bun.sleep 50

  unless ports.stream? and ports.agent?
    try proc.kill()
    throw new Error "port-forward for #{name} did not start:\n#{buf}"

  { proc, port: ports.stream, agentPort: ports.agent }

export resolveTarget = (name) ->
  desk = await getDesktop name
  unless desk?
    throw Object.assign new Error("desktop #{name} not found"), { status: 404 }
  unless desk.ready and desk.ip
    throw Object.assign new Error("desktop #{name} is not ready"), { status: 409 }

  if IN_CLUSTER
    return { host: desk.ip, port: STREAM_PORT, agentPort: AGENT_PORT, desktop: desk }

  existing = forwards.get name
  if existing?.proc
    try
      # Bun subprocess exitCode is null while running
      unless existing.proc.exitCode?
        return { host: '127.0.0.1', port: existing.port, agentPort: existing.agentPort, desktop: desk }
    catch
      forwards.delete name

  { proc, port, agentPort } = await startForward name
  forwards.set name, { proc, port, agentPort }
  { host: '127.0.0.1', port, agentPort, desktop: desk }

export dropForward = (name) ->
  existing = forwards.get name
  return unless existing?
  try existing.proc.kill()
  forwards.delete name

export pruneForwards = (liveNames) ->
  live = new Set liveNames or []
  for name from [...forwards.keys()]
    continue if live.has name
    dropForward name
    console.log "[kind] dropped stale port-forward #{name}"

if import.meta.main
  cmd = process.argv[2] or 'ensure'
  n = Number(process.argv[3] or 1)
  try
    out = switch cmd
      when 'ensure' then await ensureContainers n
      when 'create' then await createContainer()
      when 'scale' then await getScale()
      else
        console.error 'usage: bun src/k8s.coffee ensure [n] | create | scale'
        process.exit 1
        null
    console.log JSON.stringify out if out?
  catch err
    console.error err.message or err
    process.exit 1
