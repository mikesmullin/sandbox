# One browser-use Chromium profile snapshot for the control room.
# Capture streams `~/.config/browser-use` out of a live pod; new pods restore
# it before headed Chromium starts (entrypoint waits on BROWSER_SNAPSHOT=1).
import { existsSync, mkdirSync, rmSync, writeFileSync, readFileSync, statSync, renameSync } from 'fs'
import { resolve } from 'path'

NAMESPACE = process.env.NAMESPACE or 'agent-desktop'
SNAP_DIR = resolve import.meta.dir, '../tmp'
SNAP_TAR = "#{SNAP_DIR}/browser-use-snapshot.tgz"
SNAP_META = "#{SNAP_DIR}/browser-use-snapshot.json"
# browser-use copies any "real Chrome" profile into a random
# /tmp/browser-use-user-data-dir-* unless the path already contains that
# prefix. Pin restore here so Chromium actually reads the snapshot.
STABLE_DIR = '/home/agent/.config/browser-use-user-data-dir-live'
READY_MARK = '/tmp/browser-snapshot.ready'

DISCOVER_PY = '''
import glob, pathlib, sys
marker = b"--user-data-dir="
for p in pathlib.Path("/proc").iterdir():
    if not p.name.isdigit():
        continue
    try:
        raw = (p / "cmdline").read_bytes()
    except Exception:
        continue
    if b"chrome" not in raw or marker not in raw:
        continue
    if b"--type=" in raw:
        continue
    rest = raw.split(marker, 1)[1]
    end = len(rest)
    for sep in (bytes([0]), b" "):
        i = rest.find(sep)
        if i >= 0:
            end = min(end, i)
    sys.stdout.write(rest[:end].decode())
    raise SystemExit
hits = sorted(glob.glob("/tmp/browser-use-user-data-dir-*"))
if hits:
    sys.stdout.write(hits[-1])
'''

TAR_EXCLUDES = [
  'SingletonLock'
  'SingletonSocket'
  'SingletonCookie'
  'Default/Cache'
  'Default/Code Cache'
  'Default/GPUCache'
  'ShaderCache'
  'GrShaderCache'
]

kubectl = (args, opts = {}) ->
  spawn =
    stdout: opts.stdout or 'pipe'
    stderr: 'pipe'
    env: process.env
  spawn.stdin = opts.stdin if opts.stdin?
  proc = Bun.spawnSync ['kubectl', args...], spawn
  stdout = if typeof proc.stdout is 'string' then proc.stdout else new TextDecoder().decode(proc.stdout or '')
  stderr = new TextDecoder().decode(proc.stderr or '').trim()
  { stdout, stderr, exitCode: proc.exitCode }

readMetaFile = ->
  try
    raw = JSON.parse readFileSync SNAP_META, 'utf8'
    return raw if raw and typeof raw is 'object'
  catch then null
  null

export snapshotPresent = ->
  existsSync(SNAP_TAR) and statSync(SNAP_TAR).size > 0

export snapshotInfo = ->
  unless snapshotPresent()
    return { present: false }
  st = statSync SNAP_TAR
  meta = readMetaFile() or {}
  {
    present: true
    bytes: st.size
    capturedAt: meta.capturedAt or st.mtime?.toISOString?() or null
    source: meta.source or null
  }

export clearSnapshot = ->
  try rmSync SNAP_TAR, { force: true } catch then null
  try rmSync SNAP_META, { force: true } catch then null
  { present: false }

writeMeta = (patch) ->
  mkdirSync SNAP_DIR, { recursive: true }
  cur = readMetaFile() or {}
  next = Object.assign {}, cur, patch
  writeFileSync SNAP_META, JSON.stringify(next) + '\n'

export waitPodRunning = (name, ms = 90000) ->
  deadline = Date.now() + ms
  loop
    { stdout, exitCode, stderr } = kubectl [
      'get', 'pod', name, '-n', NAMESPACE, '-o', 'json'
    ]
    if exitCode is 0
      pod = JSON.parse stdout
      phase = pod.status?.phase
      cs = pod.status?.containerStatuses or []
      running = cs.some (c) -> Boolean c.state?.running
      return pod if phase is 'Running' and running
      if phase in ['Failed', 'Succeeded']
        throw new Error "pod #{name} #{phase}"
    else if Date.now() + 400 >= deadline
      throw new Error stderr or "pod #{name} not found"
    if Date.now() >= deadline
      throw new Error "pod #{name} did not start running"
    await Bun.sleep 400

discoverProfileDir = (name) ->
  found = kubectl [
    'exec', '-n', NAMESPACE, name, '-c', 'desktop', '--'
    'python3', '-c', DISCOVER_PY
  ]
  dir = (found.stdout or '').trim()
  return dir if dir.startsWith '/'
  STABLE_DIR

POD_TAR = '/tmp/browser-snapshot.tgz'

export captureSnapshot = (name) ->
  unless name
    throw Object.assign new Error('container name required'), { status: 400 }
  mkdirSync SNAP_DIR, { recursive: true }
  srcDir = discoverProfileDir name
  unless srcDir
    throw Object.assign new Error('could not find Chromium user-data-dir'), { status: 409 }
  excludes = []
  for x in TAR_EXCLUDES
    excludes.push '--exclude', x
  packed = kubectl [
    'exec', '-n', NAMESPACE, name, '-c', 'desktop', '--'
    'tar', '-C', srcDir
    '--warning=no-file-changed'
    '--ignore-failed-read'
    excludes...
    '-czf', POD_TAR, '.'
  ]
  # tar exits 1 when files change mid-read (live Chromium).
  if packed.exitCode > 1
    throw Object.assign new Error(packed.stderr or "snapshot tar failed (#{packed.exitCode})"), { status: 502 }
  partial = "#{SNAP_TAR}.partial"
  try rmSync partial, { force: true } catch then null
  copied = kubectl [
    'cp', '-n', NAMESPACE, '-c', 'desktop'
    "#{name}:#{POD_TAR}", partial
  ]
  kubectl [
    'exec', '-n', NAMESPACE, name, '-c', 'desktop', '--'
    'rm', '-f', POD_TAR
  ]
  size = if existsSync partial then statSync(partial).size else 0
  if copied.exitCode isnt 0 or size < 256
    try rmSync partial, { force: true } catch then null
    throw Object.assign new Error(copied.stderr or "snapshot copy failed (#{copied.exitCode}, #{size} bytes from #{srcDir})"), { status: 502 }
  try rmSync SNAP_TAR, { force: true } catch then null
  renameSync partial, SNAP_TAR
  meta =
    source: name
    capturedAt: new Date().toISOString()
    bytes: statSync(SNAP_TAR).size
    profileDir: srcDir
  writeMeta meta
  snapshotInfo()

export injectSnapshot = (name) ->
  unless snapshotPresent()
    return { injected: false }
  await waitPodRunning name
  mkdir = kubectl [
    'exec', '-n', NAMESPACE, name, '-c', 'desktop', '--'
    'mkdir', '-p', STABLE_DIR
  ]
  if mkdir.exitCode isnt 0
    throw Object.assign new Error(mkdir.stderr or 'mkdir snapshot dest failed'), { status: 502 }
  copied = kubectl [
    'cp', '-n', NAMESPACE, '-c', 'desktop'
    SNAP_TAR, "#{name}:#{POD_TAR}"
  ]
  if copied.exitCode isnt 0
    throw Object.assign new Error(copied.stderr or 'snapshot upload failed'), { status: 502 }
  unpacked = kubectl [
    'exec', '-n', NAMESPACE, name, '-c', 'desktop', '--'
    'tar', '-C', STABLE_DIR, '-xzf', POD_TAR
  ]
  kubectl [
    'exec', '-n', NAMESPACE, name, '-c', 'desktop', '--'
    'sh', '-c'
    "rm -f #{POD_TAR} #{STABLE_DIR}/SingletonLock #{STABLE_DIR}/SingletonSocket #{STABLE_DIR}/SingletonCookie; touch #{READY_MARK}"
  ]
  if unpacked.exitCode isnt 0
    throw Object.assign new Error(unpacked.stderr or "snapshot restore failed (#{unpacked.exitCode})"), { status: 502 }
  { injected: true, bytes: statSync(SNAP_TAR).size }

export patchPodForSnapshot = (pod) ->
  return pod unless snapshotPresent()
  spec = pod.spec or {}
  containers = spec.containers or []
  next = containers.map (c) ->
    return c unless c.name is 'desktop'
    env = (e for e in (c.env or []) when e.name isnt 'BROWSER_SNAPSHOT')
    env.push { name: 'BROWSER_SNAPSHOT', value: '1' }
    Object.assign {}, c, { env }
  pod.spec = Object.assign {}, spec, { containers: next }
  pod
