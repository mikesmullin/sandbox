# Talk to the Kind cluster. In-cluster we hit pod IPs directly.
# From the host we open a kubectl port-forward per desktop.

NAMESPACE = process.env.NAMESPACE or 'agent-desktop'
APP = process.env.DESKTOP_APP or 'desktop'
STATEFULSET = process.env.DESKTOP_STATEFULSET or 'desktop'
NOVNC_PORT = Number process.env.NOVNC_PORT or 6080
AGENT_PORT = Number process.env.AGENT_PORT or 8091
IN_CLUSTER = Boolean process.env.KUBERNETES_SERVICE_HOST

forwards = new Map # name -> { port, proc }

run = (args, opts = {}) ->
  proc = Bun.spawnSync ['kubectl', args...],
    stdout: 'pipe'
    stderr: 'pipe'
    env: process.env
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
  items = data.items or []
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
      url: "/desktops/#{name}/websockify"
      agentUrl: "/desktops/#{name}/agent"
    }

export getDesktop = (name) ->
  (await listDesktops()).find (d) -> d.name is name

export getScale = ->
  data = runJson [
    'get', 'statefulset', STATEFULSET
    '-n', NAMESPACE
    '-o', 'json'
  ]
  {
    replicas: data.spec?.replicas ? 0
    ready: data.status?.readyReplicas ? 0
    current: data.status?.currentReplicas ? 0
  }

export setScale = (replicas) ->
  n = Math.max 0, Math.min 8, Number replicas
  unless Number.isFinite n
    throw new Error 'replicas must be a number'
  run [
    'scale', "statefulset/#{STATEFULSET}"
    "--replicas=#{n}"
    '-n', NAMESPACE
  ]
  getScale()

parseForwardPorts = (text) ->
  novnc = null
  agent = null
  re = /Forwarding from (?:127\.0\.0\.1|\[::1\]):(\d+)\s+->\s+(\d+)/g
  s = String text
  while (m = re.exec s)
    local = Number m[1]
    remote = Number m[2]
    if remote is NOVNC_PORT
      novnc ?= local
    else if remote is AGENT_PORT
      agent ?= local
  { novnc, agent }

startForward = (name) ->
  # Both noVNC and the Angela WS. kubectl prints "Forwarding from" on stderr.
  proc = Bun.spawn [
    'kubectl', 'port-forward'
    '-n', NAMESPACE
    "pod/#{name}"
    ":#{NOVNC_PORT}"
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
  ports = { novnc: null, agent: null }
  while Date.now() < deadline
    ports = parseForwardPorts buf
    break if ports.novnc? and ports.agent?
    await Bun.sleep 50

  unless ports.novnc? and ports.agent?
    try proc.kill()
    throw new Error "port-forward for #{name} did not start:\n#{buf}"

  { proc, port: ports.novnc, agentPort: ports.agent }

export resolveTarget = (name) ->
  desk = await getDesktop name
  unless desk?
    throw Object.assign new Error("desktop #{name} not found"), { status: 404 }
  unless desk.ready and desk.ip
    throw Object.assign new Error("desktop #{name} is not ready"), { status: 409 }

  if IN_CLUSTER
    return { host: desk.ip, port: NOVNC_PORT, agentPort: AGENT_PORT, desktop: desk }

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
