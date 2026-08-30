# XFCE workspaces on DISPLAY=:99 (the in-pod Xvfb). xdotool talks to xfwm4
# inside the container — never the host window manager.
# Public ids are workspace-<6 hex> (sha1 of random bytes), persisted so a
# deleted slot is never reused as the same name.
import { createHash, randomBytes } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync, unlinkSync, rmSync } from 'fs'

DISPLAY = process.env.DISPLAY or ':99'
THUMB_DIR = process.env.WS_THUMB_DIR or '/tmp/ws-thumbs'
IDS_DIR = process.env.WS_IDS_DIR or '/workspace/.agent'
IDS_FILE = "#{IDS_DIR}/workspaces.json"
JAILS_ROOT = process.env.ANGELA_JAILS_ROOT or '/workspace/jails'
CDP_PORT_FILE = process.env.BROWSER_USE_CDP_PORT_FILE or '/tmp/browser-use.cdp.port'
MAX_WS = 8
HEX = /^[0-9a-f]{6}$/
WS_NAME = /^workspace-([0-9a-f]{6})$/

try
  mkdirSync THUMB_DIR, { recursive: true }
catch then null

sh = (args) ->
  proc = Bun.spawnSync args,
    stdout: 'pipe'
    stderr: 'pipe'
    env:
      DISPLAY: DISPLAY
      HOME: process.env.HOME or '/home/agent'
      XDG_RUNTIME_DIR: process.env.XDG_RUNTIME_DIR or '/tmp/runtime-agent'
      PATH: process.env.PATH or '/usr/bin:/bin'
  out = new TextDecoder().decode(proc.stdout or '').trim()
  err = new TextDecoder().decode(proc.stderr or '').trim()
  { out, err, code: proc.exitCode }

num = (s, fallback) ->
  n = Number String(s or '').trim()
  if Number.isFinite(n) then n else fallback

shortId = (used) ->
  for _ in [0...24]
    hex = createHash('sha1').update(randomBytes 32).digest('hex')[0...6]
    continue if used?.has hex
    return hex
  throw new Error 'could not allocate workspace id'

export wsName = (hex) -> "workspace-#{hex}"

export hexOf = (id) ->
  s = String(id or '')
  m = s.match WS_NAME
  return m[1] if m
  return s if HEX.test s
  null

# MCP file-io jail / Angela projectRoot / term-local cwd for this screen.
# Named jails/ because it is the file-io root, not a git worktree.
export jailPath = (id) ->
  hex = hexOf id
  return null unless hex
  "#{JAILS_ROOT}/#{wsName hex}"

export ensureJail = (id) ->
  p = jailPath id
  return null unless p
  mkdirSync p, { recursive: true }
  p

export removeJail = (id) ->
  p = jailPath id
  return unless p
  try
    rmSync p, { recursive: true, force: true }
  catch then null

persistCount = (n) ->
  sh ['xfconf-query', '-c', 'xfwm4', '-p', '/general/workspace_count', '-n', '-t', 'int', '-s', String n]
  sh ['xdotool', 'set_num_desktops', String n]

waitMs = (ms) ->
  if typeof Bun isnt 'undefined' and typeof Bun.sleepSync is 'function'
    Bun.sleepSync ms
  else
    Atomics.wait new Int32Array(new SharedArrayBuffer 4), 0, 0, ms

export loadState = ->
  try
    raw = JSON.parse readFileSync IDS_FILE, 'utf8'
    if Array.isArray raw
      slots = (String s for s in raw when HEX.test String s)
      return { slots, rooms: {} }
    slots = (String s for s in (raw?.slots or []) when HEX.test String s)
    rooms = if raw?.rooms and typeof raw.rooms is 'object' then raw.rooms else {}
    cleaned = {}
    for hex, meta of rooms
      continue unless HEX.test hex
      cleaned[hex] = if meta and typeof meta is 'object' then meta else {}
    return { slots, rooms: cleaned }
  catch then null
  { slots: [], rooms: {} }

export saveState = (state) ->
  mkdirSync IDS_DIR, { recursive: true }
  slots = (s for s in (state?.slots or []) when HEX.test s)
  rooms = {}
  for hex, meta of (state?.rooms or {})
    continue unless HEX.test hex
    rooms[hex] = meta if meta and typeof meta is 'object'
  writeFileSync IDS_FILE, JSON.stringify({ slots, rooms }) + '\n'

loadSlots = -> loadState().slots

saveSlots = (slots) ->
  state = loadState()
  keep = new Set slots
  rooms = {}
  for hex, meta of (state.rooms or {})
    rooms[hex] = meta if keep.has hex
  saveState { slots, rooms }

export setRoomMeta = (hex, patch) ->
  h = hexOf hex
  return unless h
  state = loadState()
  cur = state.rooms[h] or {}
  next = {}
  for k, v of cur
    next[k] = v
  for k, v of (patch or {})
    if v is undefined
      delete next[k]
    else
      next[k] = v
  state.rooms[h] = next
  saveState state
  next

export deleteRoomMeta = (hex) ->
  h = hexOf hex
  return unless h
  state = loadState()
  delete state.rooms[h]
  saveState state

syncSlots = (count) ->
  count = Math.max 1, count
  state = loadState()
  slots = state.slots.slice()
  used = new Set slots
  changed = no
  while slots.length < count
    hex = shortId used
    used.add hex
    slots.push hex
    changed = yes
  if slots.length > count
    slots = slots.slice 0, count
    changed = yes
  if changed
    saveSlots slots
  slots

export snapCurrent = ->
  current = num (sh ['xdotool', 'get_desktop']).out, 0
  dest = "#{THUMB_DIR}/#{current}.png"
  try
    unlinkSync dest
  catch then null
  r = sh ['scrot', '--overwrite', dest]
  if r.code isnt 0
    sh ['scrot', dest]
  dest

browserHelper = ->
  candidates = [
    process.env.BROWSER_USE_WINDOW_PY
    "#{process.env.HOME or '/home/agent'}/bin/browser-use-window.py"
    '/usr/local/bin/browser-use-window.py'
  ].filter Boolean
  for py in candidates
    continue unless existsSync py
    return py
  null

runBrowserHelper = (args) ->
  py = browserHelper()
  unless py
    console.error '[workspaces] browser-use window helper missing'
    return { out: '', err: 'missing helper', code: 1 }
  pyBins = ['python3', '/opt/browser-use/venv/bin/python']
  for bin in pyBins
    r = sh [bin, py, args...]
    return r if r.code is 0
  r

export openBrowserOnCurrent = (url = 'about:blank') ->
  r = runBrowserHelper [url]
  if r.code isnt 0
    console.error '[workspaces] browser-use window', r.err or r.out or 'failed'
    return null
  lines = (line.trim() for line in (r.out or '').split '\n' when line.trim())
  lines[lines.length - 1] or null

export closeBrowserTarget = (targetId) ->
  return unless targetId
  r = runBrowserHelper ['--close', String targetId]
  if r.code isnt 0
    console.error '[workspaces] close target', targetId, r.err or r.out or 'failed'
  r.code is 0

cdpHttpBase = ->
  try
    port = String(readFileSync CDP_PORT_FILE, 'utf8').trim()
    return "http://127.0.0.1:#{port}" if /^\d+$/.test port
  catch then null
  "http://127.0.0.1:#{process.env.CDP_PORT or '9222'}"

export listPageTargets = ->
  try
    res = await fetch "#{cdpHttpBase()}/json/list"
    return [] unless res.ok
    body = await res.json()
    items = if Array.isArray body then body else []
    items.filter (t) -> String(t.type or 'page') in ['page', 'tab']
  catch err
    console.error '[workspaces] cdp list', err.message or err
    []

export targetExists = (id) ->
  return false unless id
  pages = await listPageTargets()
  pages.some (p) -> String(p.id or p.targetId or '') is String id

waitForCount = (want, ms = 1500) ->
  deadline = Date.now() + ms
  loop
    { workspaces } = listWorkspaces()
    return workspaces if workspaces.length >= want
    break if Date.now() >= deadline
    waitMs 50
  listWorkspaces().workspaces

pack = (count, current, slots) ->
  state = loadState()
  {
    current: if slots[current]? then wsName slots[current] else current
    workspaces: slots.map (hex, id) ->
      meta = state.rooms[hex] or {}
      {
        id: wsName hex
        name: wsName hex
        current: id is current
        sessionId: meta.sessionId or null
      }
  }

export resolveIndex = (id, workspaces, slots) ->
  s = String(id ? '')
  i = workspaces.findIndex (w) -> w.id is s or w.name is s
  return i if i >= 0
  m = s.match WS_NAME
  if m
    i = slots.indexOf m[1]
    return i if i >= 0
  if HEX.test s
    i = slots.indexOf s
    return i if i >= 0
  n = num s, NaN
  if Number.isFinite(n) and n >= 0 and n < slots.length
    return n
  -1

export resolveName = (id) ->
  listed = listWorkspaces()
  slots = loadState().slots
  idx = resolveIndex id, listed.workspaces, slots
  return null if idx < 0
  listed.workspaces[idx].id

export listWorkspaces = ->
  count = num (sh ['xdotool', 'get_num_desktops']).out, 0
  current = num (sh ['xdotool', 'get_desktop']).out, 0
  if count < 1
    count = 1
    current = 0
  if current < 0 or current >= count
    current = 0
  slots = syncSlots count
  pack count, current, slots

windowIdsOn = (desk) ->
  r = sh ['xdotool', 'search', '--desktop', String(desk), '--name', '.*']
  return [] if r.code isnt 0 or not r.out
  (line.trim() for line in r.out.split '\n' when line.trim())

swapThumbs = (a, b) ->
  return if a is b
  pathA = "#{THUMB_DIR}/#{a}.png"
  pathB = "#{THUMB_DIR}/#{b}.png"
  tmp = "#{THUMB_DIR}/.swap.png"
  aOk = existsSync pathA
  bOk = existsSync pathB
  try
    if aOk and bOk
      renameSync pathA, tmp
      renameSync pathB, pathA
      renameSync tmp, pathB
    else if aOk
      renameSync pathA, pathB
    else if bOk
      renameSync pathB, pathA
  catch err
    console.error '[workspaces] thumb swap', err.message or err

# XFCE only stores a count, so "delete slot i" is: swap i with last, then drop last.
swapSlots = (a, b) ->
  return if a is b
  winsA = windowIdsOn a
  winsB = windowIdsOn b
  for w in winsA
    sh ['xdotool', 'set_desktop_for_window', w, String b]
  for w in winsB
    sh ['xdotool', 'set_desktop_for_window', w, String a]
  swapThumbs a, b

export addWorkspace = ->
  { workspaces } = listWorkspaces()
  if workspaces.length >= MAX_WS
    throw Object.assign new Error("at most #{MAX_WS} workspaces"), { status: 400 }
  snapCurrent()
  next = workspaces.length
  persistCount next + 1
  waitForCount next + 1
  sh ['xdotool', 'set_desktop', String next]
  waitMs 150
  tid = null
  try
    tid = openBrowserOnCurrent 'about:blank'
  catch err
    console.error '[workspaces] browser-use window', err.message or err
  waitMs 250
  snapCurrent()
  listed = listWorkspaces()
  hex = hexOf listed.current
  ensureJail hex if hex
  setRoomMeta hex, { targetId: tid } if hex and tid
  listed.openedTargetId = tid
  listed

export removeWorkspace = (id) ->
  listed = listWorkspaces()
  { workspaces, current } = listed
  if workspaces.length <= 1
    throw Object.assign new Error('cannot remove the last workspace'), { status: 400 }
  slots = loadSlots()
  idx = resolveIndex id, workspaces, slots
  last = workspaces.length - 1
  if idx < 0
    throw Object.assign new Error("workspace #{id} not found"), { status: 404 }
  hex = hexOf current
  currentIdx = if hex then slots.indexOf hex else num current, 0
  currentIdx = 0 if currentIdx < 0
  if idx isnt last
    snapCurrent()
    swapSlots idx, last
    tmp = slots[idx]
    slots[idx] = slots[last]
    slots[last] = tmp
    saveSlots slots
    if currentIdx is last
      sh ['xdotool', 'set_desktop', String idx]
      currentIdx = idx
  droppedHex = loadSlots()[last]
  droppedTarget = (loadState().rooms[droppedHex] or {}).targetId or null
  if currentIdx >= last
    sh ['xdotool', 'set_desktop', String Math.max 0, last - 1]
  persistCount last
  out = listWorkspaces()
  out.dropped = if droppedHex then wsName droppedHex else null
  out.droppedTargetId = droppedTarget
  out

export focusWorkspace = (id) ->
  pauseScan()
  listed = listWorkspaces()
  slots = loadSlots()
  idx = resolveIndex id, listed.workspaces, slots
  if idx < 0
    throw Object.assign new Error("workspace #{id} not found"), { status: 404 }
  snapCurrent()
  sh ['xdotool', 'set_desktop', String idx]
  snapCurrent()
  listWorkspaces()

export thumbFile = (id) ->
  listed = listWorkspaces()
  slots = loadSlots()
  idx = resolveIndex id, listed.workspaces, slots
  return null if idx < 0
  currentIdx = listed.workspaces.findIndex (w) -> w.current
  snapCurrent() if idx is currentIdx
  path = "#{THUMB_DIR}/#{idx}.png"
  file = Bun.file path
  if await file.exists() then { path, file } else null

# Bind this XFCE workspace to a Chromium window (same profile, unique window).
export ensureBrowserWindow = (id) ->
  listed = listWorkspaces()
  slots = loadState().slots
  idx = resolveIndex id, listed.workspaces, slots
  if idx < 0
    throw Object.assign new Error("workspace #{id} not found"), { status: 404 }
  hex = slots[idx]
  meta = (loadState().rooms[hex] or {})
  if meta.targetId and await targetExists meta.targetId
    return meta.targetId
  used = new Set()
  for h, r of (loadState().rooms or {})
    continue if h is hex
    used.add String r.targetId if r?.targetId
  pages = await listPageTargets()
  unbound = pages.find (p) ->
    tid = String p.id or p.targetId or ''
    tid and not used.has tid
  if unbound
    tid = String unbound.id or unbound.targetId
    setRoomMeta hex, { targetId: tid }
    return tid
  currentIdx = listed.workspaces.findIndex (w) -> w.current
  currentIdx = 0 if currentIdx < 0
  if idx isnt currentIdx
    sh ['xdotool', 'set_desktop', String idx]
    waitMs 150
  tid = openBrowserOnCurrent 'about:blank'
  waitMs 200
  if idx isnt currentIdx
    sh ['xdotool', 'set_desktop', String currentIdx]
  setRoomMeta hex, { targetId: tid } if tid
  tid

# Multi-workspace capture scan. XFCE only composites the current slot, so we
# rotate current (REC) and snap thumbs. A single workspace stays put so the
# wall can stream live noVNC. Isolate/focus pins until resumeScan().
SCAN_MS = Number(process.env.WS_SCAN_MS or 5000)
SCAN_MIN_MS = 500
scanning = true
scanLoopStarted = false

dwellMs = (n) ->
  Math.max SCAN_MIN_MS, Math.round(SCAN_MS / Math.max(1, n))

pauseScan = ->
  scanning = false

export resumeScan = ->
  scanning = true
  listWorkspaces()

rotateOnce = ->
  { workspaces } = listWorkspaces()
  n = workspaces.length
  return if n <= 1
  snapCurrent()
  return unless scanning
  idx = workspaces.findIndex (w) -> w.current
  idx = 0 if idx < 0
  next = (idx + 1) % n
  sh ['xdotool', 'set_desktop', String next]
  waitMs 80
  snapCurrent()

export startScanLoop = ->
  return if scanLoopStarted
  scanLoopStarted = true
  scanning = true
  do ->
    loop
      n = 1
      try
        n = listWorkspaces().workspaces.length
      catch then n = 1
      await Bun.sleep dwellMs n
      continue unless scanning
      continue if n <= 1
      try
        rotateOnce()
      catch err
        console.error '[workspaces] scan', err.message or err
