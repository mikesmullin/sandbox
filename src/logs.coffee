# Shared kubectl logs -f per desktop pod. Clients attach over the dashboard WS.

NAMESPACE = process.env.NAMESPACE or 'agent-desktop'
CONTAINER = process.env.DESKTOP_CONTAINER or 'desktop'
TAIL = Number process.env.LOG_TAIL or 200
MAX = 500

follows = new Map() # name -> { proc, clients, lines, timer }

parseLine = (raw) ->
  s = String(raw or '').replace /\r$/, ''
  return null unless s
  m = s.match /^(\d{4}-\d{2}-\d{2}T[0-9:.+-]+Z)\s+(.*)$/
  if m
    iso = m[1]
    hh = iso.slice 11, 19
    return { t: iso, ts: hh, line: m[2] }
  { t: '', ts: '', line: s }

broadcast = (slot, obj) ->
  json = JSON.stringify obj
  dead = []
  slot.clients.forEach (ws) ->
    try
      ws.send json
    catch
      dead.push ws
  slot.clients.delete c for c in dead
  null

startFollow = (name, slot) ->
  return if slot.proc?
  proc = Bun.spawn [
    'kubectl', 'logs', '-f'
    '-n', NAMESPACE
    '--timestamps'
    "--tail=#{TAIL}"
    '--pod-running-timeout=2m'
    "pod/#{name}"
    '-c', CONTAINER
  ],
    stdout: 'pipe'
    stderr: 'pipe'
    env: process.env
  slot.proc = proc
  pushRow = (raw) ->
    row = parseLine raw
    return unless row?
    slot.lines.push row
    slot.lines.shift() while slot.lines.length > MAX
    broadcast slot, { type: 'line', ...row }
  eat = (stream) ->
    return unless stream?
    decoder = new TextDecoder()
    buf = ''
    reader = stream.getReader()
    loop
      { done, value } = await reader.read()
      break if done
      buf += decoder.decode value, { stream: true }
      loop
        i = buf.indexOf '\n'
        break if i < 0
        pushRow buf.slice 0, i
        buf = buf.slice i + 1
    pushRow buf if buf.trim()
  Promise.all([
    eat(proc.stdout).catch(->)
    eat(proc.stderr).catch(->)
  ]).then ->
    slot.proc = null
    return if slot.clients.size is 0
    slot.timer = setTimeout ->
      startFollow name, slot
    , 1500
  console.log "[logs] follow #{name}"

export attachLogClient = (name, ws) ->
  slot = follows.get name
  unless slot?
    slot = { proc: null, clients: new Set(), lines: [], timer: null }
    follows.set name, slot
  slot.clients.add ws
  for row in slot.lines
    try ws.send JSON.stringify { type: 'line', ...row }
  try ws.send JSON.stringify { type: 'hello', name, n: slot.lines.length }
  startFollow name, slot
  slot

export detachLogClient = (name, ws) ->
  slot = follows.get name
  return unless slot?
  slot.clients.delete ws
  return if slot.clients.size > 0
  clearTimeout slot.timer if slot.timer?
  try slot.proc?.kill()
  follows.delete name
  console.log "[logs] stop #{name}"
