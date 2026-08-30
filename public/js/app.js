import M from '/vendor/m.min.js'
import { chat } from './chat.js'
import {
  telem,
  wantDesktop, wantLog, wantGauges,
  toggleDesktop, toggleLog, toggleGauges,
  syncLogStreams, syncGauges, onLogScroll, stickLogs, resetLogClients,
  cpuLabel, ramLabel, diskLabel, netLabel, diskIoLabel,
} from './logs.js'

const CHAT_OPEN_KEY = 'agent-desktop.chatOpen'
const CHAT_WIDTH_KEY = 'agent-desktop.chatWidth'
const CHAT_WIDTH_MIN = 240
const CHAT_WIDTH_DEFAULT = 380
const readChatOpen = () => {
  try {
    const v = localStorage.getItem(CHAT_OPEN_KEY)
    if (v == null) return true
    return v === '1' || v === 'true'
  } catch {
    return true
  }
}
const writeChatOpen = (on) => {
  try { localStorage.setItem(CHAT_OPEN_KEY, on ? '1' : '0') } catch {}
}
const readChatWidth = () => {
  try {
    const n = Number(localStorage.getItem(CHAT_WIDTH_KEY))
    if (Number.isFinite(n) && n >= CHAT_WIDTH_MIN) return Math.round(n)
  } catch {}
  return CHAT_WIDTH_DEFAULT
}
const writeChatWidth = (n) => {
  try { localStorage.setItem(CHAT_WIDTH_KEY, String(Math.round(n))) } catch {}
}
const MUTE_KEY = 'agent-desktop.muted'
const readMuted = () => {
  try { return localStorage.getItem(MUTE_KEY) === '1' } catch { return false }
}
const writeMuted = (m) => {
  try { localStorage.setItem(MUTE_KEY, m ? '1' : '0') } catch {}
}

const ui = M.store('ui', {
  items: [],
  scale: { replicas: 0, ready: 0, current: 0 },
  selectedContainer: null,
  selectedDesktop: null,
  fullView: false,
  chatOpen: readChatOpen(),
  chatWidth: readChatWidth(),
  error: '',
  loading: true,
  busy: false,
  snapshot: { present: false },
  thumbGen: 0,
  thumbOk: {},
  thumbRetry: {},
  wsRenameOpen: false,
  wsRenameDraft: '',
  wsPathCopied: false,
  muted: readMuted(),
  captured: false,
})
ui.chatOpen = readChatOpen()

// The isolated desktop is a Selkies HTML5 client iframe served through the
// dashboard proxy at /desktops/<pod>/. The wall shows static /thumb images.
const syncScreens = () => {
  syncLogStreams(ui.items)
  syncGauges(ui.items)
  queueMicrotask(() => stickLogs())
}

const api = async (path, opts) => {
  const res = await fetch(path, {
    headers: { 'content-type': 'application/json' },
    ...opts,
  })
  const body = await res.json().catch(() => ({}))
  if (!res.ok) throw new Error(body.error || res.statusText)
  return body
}

const desktopSnap = (list) =>
  (list || []).map((d) => {
    const ws = (d.workspaces || []).map((w) => {
      const label = String(w.label || '').trim()
      return `${w.id}${w.current ? '*' : ''}:${label}`
    }).join(',')
    return `${d.name}:${d.ready}:${d.phase}:${d.restarts || 0}:${ws}`
  }).join('|')

const closeWsRename = () => {
  if (!ui.wsRenameOpen && !ui.wsRenameDraft) return
  ui.wsRenameOpen = false
  ui.wsRenameDraft = ''
}

const refresh = async () => {
  try {
    const data = await api('/api/desktops')
    const next = data.desktops || []
    if (desktopSnap(ui.items) !== desktopSnap(next)) ui.items = next
    const sc = data.scale || ui.scale
    const prev = ui.scale || {}
    if (prev.replicas !== sc.replicas || prev.ready !== sc.ready || prev.current !== sc.current) {
      ui.scale = sc
    }
    const snap = data.snapshot || { present: false }
    const prevSnap = ui.snapshot || {}
    if (prevSnap.present !== snap.present || prevSnap.source !== snap.source || prevSnap.bytes !== snap.bytes) {
      ui.snapshot = snap
    }
    if (ui.selectedContainer && !next.some((d) => d.name === ui.selectedContainer)) {
      ui.selectedContainer = null
    }
    if (ui.selectedDesktop && next.length && !next.some((d) => d.name === ui.selectedDesktop.name)) {
      const wasFull = ui.fullView
      ui.selectedDesktop = null
      ui.fullView = false
      closeWsRename()
      chat.attach(null)
      if (wasFull && readFullRoute()) goWall()
    }
    ui.thumbGen = (ui.thumbGen || 0) + 1
    ui.error = ''
    ui.loading = false
    queueMicrotask(syncScreens)
  } catch (err) {
    ui.error = err.message
    ui.loading = false
  }
}

const paint = () => {
  try { M.redraw() } catch {}
}

const Router = M.Router
const WALL_PATH = '/'
const fullPath = (name, ws) =>
  `/c/${encodeURIComponent(name)}/w/${encodeURIComponent(ws)}`

const readFullRoute = () => {
  const p = Router.params || {}
  if (!p.name || !p.id) return null
  try {
    return { name: decodeURIComponent(p.name), ws: decodeURIComponent(p.id) }
  } catch {
    return { name: p.name, ws: p.id }
  }
}

const applyRouteFromHash = () => {
  const full = readFullRoute()
  if (full) {
    const same = ui.fullView
      && ui.selectedDesktop?.name === full.name
      && String(ui.selectedDesktop?.ws) === String(full.ws)
    ui.selectedContainer = null
    ui.selectedDesktop = { name: full.name, ws: full.ws }
    ui.fullView = true
    if (!same) closeWsRename()
    chat.attach(`${full.name}::${full.ws}`)
    paint()
    queueMicrotask(syncScreens)
    // Flip the pod's X display to this workspace so the (per-container) Selkies
    // stream shows it. Same stream when only the workspace changes.
    api(`/api/desktops/${encodeURIComponent(full.name)}/workspaces/${encodeURIComponent(full.ws)}/focus`, {
      method: 'POST',
    }).catch((err) => console.warn('workspace focus', err))
    return
  }
  if (!ui.fullView) return
  const name = ui.selectedDesktop?.name
  ui.fullView = false
  closeWsRename()
  chat.attach(null)
  paint()
  queueMicrotask(syncScreens)
  if (name) {
    api(`/api/desktops/${encodeURIComponent(name)}/workspaces/scan`, { method: 'POST' })
      .catch((err) => console.warn('workspace scan', err))
  }
}

const goWall = () => Router.set(WALL_PATH)
const goFull = (name, ws) => Router.set(fullPath(name, ws))

const ensureRoutes = () => {
  Router.setMode('hash')
  Router.setTitleFormat((t) => {
    const p = Router.params
    if (p?.name && p?.id) {
      try {
        return `${decodeURIComponent(p.name)} · ${decodeURIComponent(p.id)}`
      } catch {
        return t
      }
    }
    return t
  })
  Router.register(WALL_PATH, 'Agent workspaces', () => App())
  Router.register('/c/:name/w/:id', 'Workspace', () => App())
}

const leaveFuller = () => goWall()

// Selkies gaming mode (Ctrl+Shift+X) owns pointer lock and eats Esc; the first
// Esc exits pointer lock, the second reaches here and returns to the wall. When
// not locked, a single Esc in the same-origin iframe returns to the wall. The
// always-visible toolbar "wall" button is the reliable fallback.
const onFrameEsc = (win) => (ev) => {
  if (ev.key !== 'Escape') return
  if (document.pointerLockElement || win.document?.pointerLockElement) return
  goWall()
}

// The Selkies client (in the iframe) accepts same-origin control messages; mute
// maps to setMute. The core recreates its audio gain node unmuted when the stream
// reconnects, so re-apply the muted state on its pipeline/status pings.
const setFrameMute = (win, muted) => {
  try { win?.postMessage({ type: 'setMute', value: !!muted }, window.location.origin) } catch {}
}
const reapplyMuteToFrame = (win) => {
  if (win && ui.muted) setFrameMute(win, true)
}

// In-place mouse capture: pointer-lock the Selkies input surface so the OS cursor
// is confined to the stream (deltas keep flowing) while the tiled DESKTOP_FULL
// layout — chat rail included — stays on screen. Esc releases. Pointer lock needs
// a real user gesture, so the lock is requested from a click *inside* the iframe
// (same-origin); the toolbar toggle relies on same-origin activation propagation.
const selkiesLock = (win) => {
  if (!win || win.document.pointerLockElement) return
  const inp = win.webrtcInput
  const el = inp?.element || win.document.getElementById('overlayInput') || win.document.querySelector('canvas')
  if (!el) return
  try {
    if (inp && typeof inp._requestPointerLock === 'function') {
      inp._requestPointerLock(el, () => selkiesLock(win), (e) => console.warn('pointer lock failed', e))
    } else {
      el.requestPointerLock?.()
    }
    if (inp?.cursorDiv) inp.cursorDiv.style.visibility = 'hidden'
  } catch (e) { console.warn('capture', e) }
}
const selkiesUnlock = (win) => {
  try { win?.document.exitPointerLock?.() } catch {}
}
// A WebGL/FPS page in the guest holds its OWN pointer lock. Our Esc is consumed by
// the outer browser to exit our lock, so it never reaches the guest — leaving the
// guest game still locked (absolute cursor warps read as exaggerated mouselook).
// When our capture ends, inject an Escape into the guest (XTEST) so its page exits
// pointer lock too, making one Esc fully stop mouselook.
const XK_ESCAPE = 0xff1b
const releaseGuestPointerLock = (win) => {
  const inp = win?.webrtcInput
  if (!inp || typeof inp._sendKeyEvent !== 'function') return
  try {
    inp._sendKeyEvent(XK_ESCAPE, 'Escape', true)
    inp._sendKeyEvent(XK_ESCAPE, 'Escape', false)
  } catch (e) { console.warn('guest escape', e) }
}
const wireCapture = (win) => {
  if (!win || win.__captureWired) return
  win.__captureWired = true
  try {
    // A plain left click on the stream captures (matches the old click-to-control
    // flow). Modified clicks are left to Selkies' own chords (Ctrl+Shift+Click,
    // gaming mode). Capture-phase, no preventDefault, so Selkies still gets it.
    win.document.addEventListener('mousedown', (ev) => {
      if (win.document.pointerLockElement) return
      if (ev.button !== 0 || ev.ctrlKey || ev.shiftKey || ev.altKey || ev.metaKey) return
      selkiesLock(win)
    }, true)
    win.document.addEventListener('pointerlockchange', () => {
      const locked = Boolean(win.document.pointerLockElement)
      if (!locked) {
        if (win.webrtcInput?.cursorDiv) win.webrtcInput.cursorDiv.style.visibility = ''
        // Also release the guest page's own pointer lock so mouselook stops on
        // the first Esc, not the second.
        releaseGuestPointerLock(win)
      }
      if (ui.captured !== locked) { ui.captured = locked; try { M.redraw() } catch {} }
    })
  } catch (e) { console.warn('wireCapture', e) }
}

const workspacesOf = (c) =>
  (c?.workspaces && c.workspaces.length)
    ? c.workspaces
    : [{ id: 'workspace', name: 'workspace', current: true }]

let burstTimer = 0
let copyFlashTimer = 0
const burstPoll = (ms = 8000) => {
  const until = Date.now() + ms
  const tick = () => {
    clearTimeout(burstTimer)
    ui.thumbGen = (ui.thumbGen || 0) + 1
    queueMicrotask(syncScreens)
    if (Date.now() < until) burstTimer = setTimeout(tick, 400)
  }
  tick()
}

const App = () => ({
  get items() { return ui.items },
  get scale() { return ui.scale },
  get snapshot() { return ui.snapshot || { present: false } },
  get pickedContainer() { return ui.selectedContainer },
  get full() { return ui.fullView ? ui.selectedDesktop : null },
  get chatOpen() { return ui.chatOpen },
  get chatWidth() { return ui.chatWidth },
  get chatRailStyle() {
    return { '--chat-rail': `${ui.chatWidth || CHAT_WIDTH_DEFAULT}px` }
  },
  get error() { return ui.error },
  get loading() { return ui.loading },
  get busy() { return ui.busy },
  get liveCount() { return ui.items.filter((d) => d.ready).length },
  get workspaceCount() {
    return ui.items.reduce((n, d) => n + workspacesOf(d).length, 0)
  },
  get thumbGen() { return ui.thumbGen },
  get thumbOkMap() { return ui.thumbOk },
  get nonePicked() { return !ui.selectedContainer && !ui.selectedDesktop },
  get wallPicked() { return !ui.fullView && Boolean(ui.selectedContainer || ui.selectedDesktop) },
  get desktopPicked() { return Boolean(ui.selectedDesktop) && !ui.fullView },
  get inFull() { return Boolean(ui.fullView) },
  workspaces: workspacesOf,
  picked() {
    const name = ui.selectedContainer || ui.selectedDesktop?.name
    return ui.items.find((d) => d.name === name)
  },
  fullContainer() { return ui.items.find((d) => d.name === ui.selectedDesktop?.name) },
  wsCount(c) { return workspacesOf(c).length },
  wsTitle(ws) {
    const label = String(ws?.label || '').trim()
    if (label) return label
    return ws?.name || ws?.id || ''
  },
  wsTitleHint(ws) {
    const label = String(ws?.label || '').trim()
    const id = ws?.name || ws?.id || ''
    return label ? id : ''
  },
  fullTitle() {
    return this.fullPath()
  },
  fullContainerId() {
    return this.full?.name || ''
  },
  fullWorkspace() {
    const f = this.full
    if (!f) return null
    const c = this.fullContainer()
    return workspacesOf(c).find((w) => String(w.id) === String(f.ws)) || null
  },
  fullWorkspaceId() {
    const f = this.full
    if (!f) return ''
    const ws = this.fullWorkspace()
    return ws?.name || (f.ws != null ? String(f.ws) : '')
  },
  fullPath() {
    const left = this.fullContainerId()
    const right = this.fullWorkspaceId()
    if (left && right) return `${left} > ${right}`
    return left || right
  },
  fullLabel() {
    return String(this.fullWorkspace()?.label || '').trim()
  },
  get pathCopied() { return Boolean(ui.wsPathCopied) },
  copyFullPath(ev) {
    ev?.preventDefault?.()
    ev?.stopPropagation?.()
    const text = this.fullPath()
    if (!text) return
    const flash = () => {
      ui.wsPathCopied = true
      paint()
      clearTimeout(copyFlashTimer)
      copyFlashTimer = setTimeout(() => {
        ui.wsPathCopied = false
        try { M.redraw() } catch {}
      }, 1200)
    }
    const fallback = () => {
      const ta = document.createElement('textarea')
      ta.value = text
      ta.setAttribute('readonly', '')
      ta.style.cssText = 'position:fixed;left:-9999px;top:0'
      document.body.appendChild(ta)
      ta.focus()
      ta.select()
      let ok = false
      try { ok = document.execCommand('copy') } catch {}
      ta.remove()
      return ok
    }
    if (navigator.clipboard?.writeText) {
      navigator.clipboard.writeText(text).then(flash).catch(() => {
        if (fallback()) flash()
      })
      return
    }
    if (fallback()) flash()
  },
  fullFrameSrc() {
    // Per-container Selkies stream. Empty when not in full view so leaving the
    // wall tears the stream (and its audio) down.
    const name = this.full?.name
    return name ? `/desktops/${encodeURIComponent(name)}/` : ''
  },
  onFrameLoad(ev) {
    const win = ev?.target?.contentWindow
    if (!win) return
    try { win.addEventListener('keydown', onFrameEsc(win)) } catch {}
    // Focus the stream so its own capture chords (Ctrl+Shift+Click / Ctrl+Shift+X)
    // reach Selkies, and wire plain-click-to-capture (in-place pointer lock).
    try { ev.target.focus?.(); win.focus?.() } catch {}
    wireCapture(win)
    // Keep audio muted across reconnects: the core resets its gain node on each
    // audio (re)init and announces it via pipeline/status messages.
    try {
      win.addEventListener('message', (e) => {
        if (e.origin !== window.location.origin) return
        const t = e?.data?.type
        if (t === 'pipelineStatusUpdate' || t === 'sidebarButtonStatusUpdate') reapplyMuteToFrame(win)
      })
    } catch {}
    setTimeout(() => reapplyMuteToFrame(win), 800)
  },
  get renaming() { return Boolean(ui.wsRenameOpen) },
  startRename(ev) {
    ev?.preventDefault?.()
    ev?.stopPropagation?.()
    if (!this.full) return
    ui.wsRenameDraft = this.fullLabel()
    ui.wsRenameOpen = true
    paint()
    queueMicrotask(() => {
      const el = document.querySelector('.ws-rename-input')
      if (!el) return
      el.focus()
      el.select()
    })
  },
  cancelRename(ev) {
    ev?.preventDefault?.()
    ev?.stopPropagation?.()
    closeWsRename()
    paint()
  },
  applyListed(name, listed) {
    const workspaces = listed?.workspaces
    if (!name || !Array.isArray(workspaces)) return
    ui.items = ui.items.map((d) => (d.name === name ? { ...d, workspaces } : d))
  },
  setLocalLabel(name, wsId, label) {
    const next = String(label || '').trim() || null
    ui.items = ui.items.map((d) => {
      if (d.name !== name) return d
      const workspaces = workspacesOf(d).map((w) =>
        String(w.id) === String(wsId) ? { ...w, label: next } : w,
      )
      return { ...d, workspaces }
    })
  },
  async commitRename(ev) {
    ev?.preventDefault?.()
    ev?.stopPropagation?.()
    if (!ui.wsRenameOpen) return
    const f = this.full
    const draft = String(ui.wsRenameDraft || '').replace(/\s+/g, ' ').trim()
    closeWsRename()
    if (!f) {
      paint()
      return
    }
    const prev = String(this.fullWorkspace()?.label || '').trim()
    if (draft === prev) {
      paint()
      return
    }
    this.setLocalLabel(f.name, f.ws, draft)
    paint()
    try {
      const listed = await api(
        `/api/desktops/${encodeURIComponent(f.name)}/workspaces/${encodeURIComponent(f.ws)}`,
        { method: 'PATCH', body: JSON.stringify({ label: draft }) },
      )
      this.applyListed(f.name, listed)
    } catch (err) {
      this.setLocalLabel(f.name, f.ws, prev)
      ui.error = err.message
    }
  },
  onContainerBlank(c, ev) {
    if (ui.fullView) return
    if (ev.target?.closest?.('.desktop-tile, .gauges-wrap, .log-shell')) return
    ev.stopPropagation?.()
    if (!ui.selectedDesktop) return
    ui.selectedDesktop = null
    paint()
  },
  onStageBlank(ev) {
    if (ui.fullView) return
    if (ev.target?.closest?.('.container-tile, .chat-rail')) return
    if (!ui.selectedContainer && !ui.selectedDesktop) return
    ui.selectedDesktop = null
    ui.selectedContainer = null
    paint()
  },
  pickContainer(c, ev) {
    ev?.stopPropagation?.()
    ui.fullView = false
    ui.selectedDesktop = null
    ui.selectedContainer = ui.selectedContainer === c.name ? null : c.name
    chat.attach(null)
    paint()
  },
  pickDesktop(c, ws, ev) {
    ev?.stopPropagation?.()
    const same = ui.selectedDesktop?.name === c.name && String(ui.selectedDesktop?.ws) === String(ws.id) && !ui.fullView
    ui.fullView = false
    ui.selectedContainer = null
    ui.selectedDesktop = same ? null : { name: c.name, ws: ws.id }
    chat.attach(null)
    paint()
  },
  async openDesktop(c, ws, ev) {
    ev?.stopPropagation?.()
    if (!c.ready) return
    goFull(c.name, ws.id)
  },
  back() { goWall() },
  get captured() { return Boolean(ui.captured) },
  toggleCapture() {
    const f = document.querySelector('iframe.selkies-frame')
    const win = f?.contentWindow
    if (!win) return
    if (win.document.pointerLockElement) selkiesUnlock(win)
    else { try { f.focus?.(); win.focus?.() } catch {}; selkiesLock(win) }
  },
  get muted() { return Boolean(ui.muted) },
  toggleMute() {
    ui.muted = !ui.muted
    writeMuted(ui.muted)
    const f = document.querySelector('iframe.selkies-frame')
    setFrameMute(f?.contentWindow, ui.muted)
    paint()
  },
  toggleChat() {
    ui.chatOpen = !ui.chatOpen
    writeChatOpen(ui.chatOpen)
    paint()
  },
  startChatResize(ev) {
    ev.preventDefault()
    ev.stopPropagation()
    const handle = ev.currentTarget
    const stage = handle?.closest?.('.stage') || document.querySelector('.stage')
    const startX = ev.clientX
    const startW = Number(ui.chatWidth) || CHAT_WIDTH_DEFAULT
    handle?.classList?.add('is-drag')
    document.body.classList.add('is-resizing-chat')
    const onMove = (e) => {
      const max = Math.max(
        CHAT_WIDTH_MIN,
        Math.floor((stage?.clientWidth || window.innerWidth) * 0.72),
      )
      ui.chatWidth = Math.min(max, Math.max(CHAT_WIDTH_MIN, startW + (startX - e.clientX)))
    }
    const onUp = () => {
      handle?.classList?.remove('is-drag')
      document.body.classList.remove('is-resizing-chat')
      window.removeEventListener('pointermove', onMove)
      window.removeEventListener('pointerup', onUp)
      writeChatWidth(ui.chatWidth)
    }
    window.addEventListener('pointermove', onMove)
    window.addEventListener('pointerup', onUp)
  },
  async addContainer() {
    ui.busy = true
    try {
      const data = await api('/api/desktops', { method: 'POST' })
      ui.scale = data.scale || ui.scale
      ui.items = data.desktops || ui.items
      if (data.container?.name) {
        ui.selectedContainer = data.container.name
        ui.selectedDesktop = null
      }
      if (data.snapshot) ui.snapshot = data.snapshot
      queueMicrotask(syncScreens)
      burstPoll(12000)
    } catch (err) {
      ui.error = err.message
    } finally {
      ui.busy = false
    }
  },
  async removeContainer() {
    const c = this.picked()
    if (!c) return
    ui.busy = true
    try {
      const data = await api(`/api/desktops/${encodeURIComponent(c.name)}`, { method: 'DELETE' })
      ui.scale = data.scale || ui.scale
      ui.items = data.desktops || ui.items
      if (ui.selectedContainer === c.name) ui.selectedContainer = null
      if (ui.selectedDesktop?.name === c.name) {
        const wasFull = ui.fullView
        ui.selectedDesktop = null
        ui.fullView = false
        closeWsRename()
        chat.attach(null)
        if (wasFull) goWall()
      }
      queueMicrotask(syncScreens)
      burstPoll(8000)
    } catch (err) {
      ui.error = err.message
    } finally {
      ui.busy = false
    }
  },
  async snapshotContainer() {
    const c = this.picked()
    if (!c?.ready || !ui.selectedContainer) return
    ui.busy = true
    ui.error = ''
    try {
      const snap = await api('/api/snapshot', {
        method: 'POST',
        body: JSON.stringify({ container: c.name }),
      })
      ui.snapshot = snap
    } catch (err) {
      ui.error = err.message
    } finally {
      ui.busy = false
    }
  },
  async clearSnapshot() {
    ui.busy = true
    ui.error = ''
    try {
      ui.snapshot = await api('/api/snapshot', { method: 'DELETE' })
    } catch (err) {
      ui.error = err.message
    } finally {
      ui.busy = false
    }
  },
  async addDesktop() {
    const name = ui.selectedDesktop?.name || ui.selectedContainer
    if (!name) return
    ui.busy = true
    try {
      await api(`/api/desktops/${encodeURIComponent(name)}/workspaces`, { method: 'POST' })
      await refresh()
      const c = ui.items.find((d) => d.name === name)
      const last = workspacesOf(c).at(-1)
      if (last) {
        ui.selectedContainer = null
        ui.selectedDesktop = { name, ws: last.id }
      }
      burstPoll(10000)
    } catch (err) {
      ui.error = err.message
    } finally {
      ui.busy = false
    }
  },
  async removeDesktop() {
    const name = ui.selectedDesktop?.name || ui.selectedContainer
    const c = ui.items.find((d) => d.name === name)
    const ws = ui.selectedDesktop?.ws ?? Math.max(0, workspacesOf(c).length - 1)
    if (!name) return
    ui.busy = true
    try {
      await api(
        `/api/desktops/${encodeURIComponent(name)}/workspaces/${encodeURIComponent(ws)}`,
        { method: 'DELETE' },
      )
      if (ui.selectedDesktop) {
        const wasFull = ui.fullView
        ui.selectedDesktop = null
        ui.fullView = false
        closeWsRename()
        ui.selectedContainer = name
        chat.attach(null)
        if (wasFull) goWall()
      }
      await refresh()
    } catch (err) {
      ui.error = err.message
    } finally {
      ui.busy = false
    }
  },
  containerClass(c) {
    const bits = ['container-tile']
    if (ui.selectedContainer === c.name) bits.push('is-picked')
    if (wantDesktop(c)) bits.push('show-desktop')
    if (wantLog(c)) bits.push('show-log')
    if (wantGauges(c)) bits.push('show-gauges')
    return bits.join(' ')
  },
  desktopClass(c, ws) {
    const bits = ['desktop-tile']
    if (ws.current) bits.push('is-current')
    if (ui.selectedDesktop?.name === c.name && String(ui.selectedDesktop?.ws) === String(ws.id)) {
      bits.push(ui.fullView ? 'is-open' : 'is-picked')
    }
    return bits.join(' ')
  },
  screenKey(c, ws) { return `${c.name}:${ws.id}` },
  thumbUrl(c, ws) {
    return `/api/desktops/${encodeURIComponent(c.name)}/workspaces/${encodeURIComponent(ws.id)}/thumb?g=${this.thumbGen}`
  },
  thumbOk(c, ws) { return Boolean(this.thumbOkMap?.[`${c.name}:${ws.id}`]) },
  onThumbLoad(c, ws) {
    const key = `${c.name}:${ws.id}`
    if (this.thumbOkMap?.[key]) return
    ui.thumbOk = { ...ui.thumbOk, [key]: true }
  },
  onThumbError(c, ws) {
    const key = `${c.name}:${ws.id}`
    const n = (ui.thumbRetry?.[key] || 0) + 1
    ui.thumbOk = { ...ui.thumbOk, [key]: false }
    ui.thumbRetry = { ...ui.thumbRetry, [key]: n }
    if (n > 40) return
    const delay = Math.min(4000, 250 * n)
    setTimeout(() => {
      ui.thumbGen = (ui.thumbGen || 0) + 1
    }, delay)
  },
  thumbClass(c, ws) {
    const bits = ['screen', 'thumb-screen']
    if (this.thumbOkMap?.[`${c.name}:${ws.id}`]) bits.push('is-ready')
    else bits.push('is-wait')
    return bits.join(' ')
  },
  wantDesktop, wantLog, wantGauges,
  flipDesktop(d, ev) { toggleDesktop(d, ev); queueMicrotask(syncScreens) },
  flipLog(d, ev) { toggleLog(d, ev); queueMicrotask(syncScreens) },
  flipGauges(d, ev) { toggleGauges(d, ev); queueMicrotask(syncScreens) },
  onLogScroll,
  telemSample(name) { return (telem.byName[name]?.sample) || {} },
  cpuLabel, ramLabel, diskLabel, netLabel, diskIoLabel,
  badge(d) {
    if (d.ready) return 'live'
    if (d.phase === 'Running') return 'wait'
    return 'down'
  },
  badgeLabel(d) {
    if (d.ready) return 'live'
    if (d.phase === 'Running') return 'booting'
    return (d.phase || 'down').toLowerCase()
  },
  template: `
    <div class="shell">
      <header class="top">
        <div class="brand">
          <i class="ph ph-monitor"></i>
          <div>
            <h1>Agent workspaces</h1>
            <small>Debian · XFCE · browser-use · agent-browser</small>
          </div>
        </div>
        <div class="stats">
          <span><i class="dot" :class="liveCount ? 'live' : 'down'"></i>live <b x-text="liveCount"></b></span>
          <span>containers <b x-text="scale.replicas"></b></span>
          <span>ready <b x-text="scale.ready"></b></span>
          <span>workspaces <b x-text="workspaceCount"></b></span>
          <span x-show="snapshot.present" title="New containers restore this browser-use profile">
            <i class="dot live"></i>snapshot
          </span>
        </div>
        <div class="spacer"></div>
        <span class="err" x-show="error" x-text="error"></span>
        <div class="actions">
          <button class="btn" type="button" x-show="nonePicked"
                  :disabled="busy || scale.replicas>=8" @click="addContainer()">
            <i class="ph ph-plus"></i> container
          </button>

          <button class="btn" type="button" x-show="wallPicked"
                  :disabled="busy || scale.replicas<=0 || !picked()"
                  @click="removeContainer()">
            <i class="ph ph-minus"></i> container
          </button>
          <button class="btn" type="button" x-show="pickedContainer"
                  :class="snapshot.present ? 'on' : ''"
                  :disabled="busy || !picked() || !picked().ready"
                  title="Copy this container's browser-use cookies/logins. New containers boot from it."
                  @click="snapshotContainer()">
            <i class="ph ph-camera"></i> Snapshot
          </button>
          <button class="btn ghost" type="button" x-show="pickedContainer && snapshot.present"
                  :disabled="busy"
                  title="Discard the browser-use snapshot. New containers boot empty."
                  @click="clearSnapshot()">
            <i class="ph ph-camera-slash"></i> Clear Snapshot
          </button>
          <button class="btn" type="button" x-show="wallPicked"
                  :disabled="busy || !picked() || !picked().ready || wsCount(picked())>=8"
                  @click="addDesktop()">
            <i class="ph ph-plus"></i> workspace
          </button>
          <button class="btn" type="button" x-show="desktopPicked"
                  :disabled="busy || !fullContainer() || wsCount(fullContainer())<=1"
                  @click="removeDesktop()">
            <i class="ph ph-minus"></i> workspace
          </button>
          <span class="pane-toggles toolbar-panes" x-show="wallPicked && picked()">
            <button type="button" class="pane-btn" :class="wantDesktop(picked()) ? 'on' : ''"
                    @click="flipDesktop(picked(), $event)">
              <i class="ph ph-monitor"></i> workspaces
            </button>
            <button type="button" class="pane-btn" :class="wantLog(picked()) ? 'on' : ''"
                    @click="flipLog(picked(), $event)">
              <i class="ph ph-terminal"></i> log
            </button>
            <button type="button" class="pane-btn" :class="wantGauges(picked()) ? 'on' : ''"
                    @click="flipGauges(picked(), $event)">
              <i class="ph ph-gauge"></i> gauges
            </button>
          </span>

          <button class="btn ghost" type="button" x-show="inFull" @click="back()">
            <i class="ph ph-arrow-left"></i> wall
          </button>
          <button class="btn toggle" type="button" x-show="inFull"
                  :class="captured ? 'on' : 'off'"
                  :aria-pressed="captured ? 'true' : 'false'"
                  :title="captured ? 'Release mouse (Esc)' : 'Capture mouse — lock the cursor to the stream'"
                  @click="toggleCapture()">
            <i class="ph" :class="captured ? 'ph-mouse' : 'ph-cursor-click'"></i>
            <span x-text="captured ? 'captured' : 'capture'"></span>
          </button>
          <button class="btn toggle" type="button" x-show="inFull"
                  :class="muted ? 'on' : 'off'"
                  :aria-pressed="muted ? 'true' : 'false'"
                  :title="muted ? 'Unmute desktop audio' : 'Mute desktop audio'"
                  @click="toggleMute()">
            <i class="ph" :class="muted ? 'ph-speaker-slash' : 'ph-speaker-high'"></i>
            <span x-text="muted ? 'muted' : 'audio'"></span>
          </button>
          <button class="btn toggle" type="button" x-show="inFull"
                  :class="chatOpen ? 'on' : 'off'"
                  :aria-pressed="chatOpen ? 'true' : 'false'"
                  title="Toggle chat sidebar"
                  @click="toggleChat()">
            <i class="ph ph-chat-circle"></i> chat
          </button>
        </div>
      </header>

      <main class="stage" :class="(full && chatOpen) ? 'has-chat' : ''"
            :style="chatRailStyle"
            @click="onStageBlank($event)">
        <div class="empty" x-show="!loading && items.length===0">
          <i class="ph ph-squares-four"></i>
          <h2>No containers running</h2>
          <p>Use + container to boot an agent-desktop pod on the Kind cluster.</p>
        </div>

        <section class="wall grid" x-show="!full && items.length">
          <article class="tile"
                   x-for="d in items"
                   :key="d.name"
                   :class="containerClass(d)"
                   @click="onContainerBlank(d, $event)">
            <div class="tile-head" @click="pickContainer(d, $event)">
              <i class="ph ph-cube"></i>
              <span class="name" x-text="d.name"></span>
              <span class="badge" :class="badge(d)" x-text="badgeLabel(d)"></span>
              <span class="meta">
                <span x-text="wsCount(d) + ' workspace' + (wsCount(d)===1 ? '' : 's')"></span>
              </span>
            </div>
            <div class="gauges-wrap" x-show="wantGauges(d)" :class="'gauges-for-' + d.name" @click.stop>
              <div class="gauges">
                <div class="gauge">
                  <div class="gauge-tag"><i class="ph ph-cpu"></i> CPU</div>
                  <div class="gauge-dial">
                    <canvas data-gauge="cpu" width="148" height="148"></canvas>
                    <div class="gauge-face">
                      <div class="gauge-pct" x-text="(telemSample(d.name).cpu_pct || 0) + '%'"></div>
                    </div>
                  </div>
                  <div class="gauge-name" x-text="cpuLabel(d.name)"></div>
                </div>
                <div class="gauge">
                  <div class="gauge-tag"><i class="ph ph-memory"></i> RAM</div>
                  <div class="gauge-dial">
                    <canvas data-gauge="ram" width="148" height="148"></canvas>
                    <div class="gauge-face">
                      <div class="gauge-pct" x-text="(telemSample(d.name).ram_pct || 0) + '%'"></div>
                    </div>
                  </div>
                  <div class="gauge-name" x-text="ramLabel(d.name)"></div>
                </div>
                <div class="gauge">
                  <div class="gauge-tag"><i class="ph ph-hard-drives"></i> DISK</div>
                  <div class="gauge-dial">
                    <canvas data-gauge="disk" width="148" height="148"></canvas>
                    <div class="gauge-face">
                      <div class="gauge-pct" x-text="(telemSample(d.name).disk_pct || 0) + '%'"></div>
                    </div>
                  </div>
                  <div class="gauge-name" x-text="diskLabel(d.name)"></div>
                </div>
              </div>
              <div class="charts">
                <div class="chart-row">
                  <span class="chart-lbl">CPU</span>
                  <canvas data-spark="cpu" width="220" height="28"></canvas>
                  <span class="chart-val" x-text="cpuLabel(d.name)"></span>
                </div>
                <div class="chart-row">
                  <span class="chart-lbl">NET</span>
                  <canvas data-spark="net" width="220" height="28"></canvas>
                  <span class="chart-val" x-text="netLabel(d.name)"></span>
                </div>
                <div class="chart-row">
                  <span class="chart-lbl">DISK IO</span>
                  <canvas data-spark="disk" width="220" height="28"></canvas>
                  <span class="chart-val" x-text="diskIoLabel(d.name)"></span>
                </div>
              </div>
            </div>
            <div class="desktop-nest" x-show="wantDesktop(d)"
                 @click="onContainerBlank(d, $event)">
              <article class="tile desktop-tile"
                       x-for="ws in d.workspaces"
                       :key="d.name + ':' + ws.id"
                       :class="desktopClass(d, ws)">
                <div class="tile-head" @click="pickDesktop(d, ws, $event)">
                  <i class="ph ph-browser"></i>
                  <span class="name" x-text="wsTitle(ws)" :title="wsTitleHint(ws)"></span>
                  <span class="rec-dot" x-show="ws.current" title="capturing"></span>
                </div>
                <div class="screen thumb-screen"
                     :class="thumbClass(d, ws)"
                     :data-screen="screenKey(d, ws)"
                     @click="openDesktop(d, ws, $event)">
                  <div class="screen-wait">
                    <i class="ph ph-circle-notch ph-spinner"></i>
                    <span>waiting for workspace</span>
                  </div>
                  <img class="ws-thumb" :src="thumbUrl(d, ws)" alt=""
                       @load="onThumbLoad(d, ws)" @error="onThumbError(d, ws)" />
                </div>
              </article>
            </div>
            <div class="log-shell" x-show="wantLog(d)"
                 :class="(wantDesktop(d) ? 'is-compact' : 'is-fill') + ' log-for-' + d.name"
                 @click.stop>
              <div class="log-pane" tabindex="0" x-ignore></div>
            </div>
          </article>
        </section>

        <section class="wall solo" x-show="full">
          <article class="tile is-open show-desktop">
            <div class="tile-head">
              <i class="ph ph-browser"></i>
              <span class="name" x-text="fullContainerId()"></span>
              <span class="crumb-sep" x-show="fullWorkspaceId()">></span>
              <span class="name" x-text="fullWorkspaceId()"></span>
              <button class="head-icon" type="button"
                      :class="pathCopied ? 'is-ok' : ''"
                      :title="pathCopied ? 'Copied' : 'Copy ' + fullPath()"
                      :aria-label="pathCopied ? 'Copied' : 'Copy container and workspace id'"
                      @click.stop="copyFullPath($event)">
                <i class="ph ph-copy-simple" x-show="!pathCopied"></i>
                <i class="ph ph-check" x-show="pathCopied"></i>
              </button>
              <span class="ws-alias" x-show="!renaming && fullLabel()"
                    :title="fullLabel()" x-text="fullLabel()"></span>
              <button class="head-icon" type="button" x-show="!renaming"
                      title="Name this workspace"
                      aria-label="Name this workspace"
                      @click.stop="startRename($event)">
                <i class="ph ph-pencil-simple"></i>
              </button>
              <form class="ws-rename" x-show="renaming"
                    @submit.prevent="commitRename($event)"
                    @click.stop>
                <input class="ws-rename-input"
                       type="text"
                       maxlength="80"
                       spellcheck="false"
                       autocomplete="off"
                       placeholder="what is this workspace for?"
                       aria-label="Workspace name"
                       x-model="$store.ui.wsRenameDraft"
                       @keydown.escape.prevent="cancelRename($event)"
                       @blur="commitRename($event)" />
              </form>
              <span class="meta">
                <span class="capture-status hint" x-show="!captured">
                  <i class="ph ph-cursor-click"></i>
                  click stream to capture · <span class="kbd">Ctrl+Shift+X</span> fullscreen · <span class="kbd">Esc</span> wall
                </span>
                <span class="capture-status" x-show="captured">
                  <i class="ph ph-mouse"></i>
                  mouse captured · <span class="kbd">Esc</span> releases
                </span>
              </span>
            </div>
            <iframe class="selkies-frame" x-show="full"
                    :src="fullFrameSrc()"
                    allow="pointer-lock; fullscreen; clipboard-read; clipboard-write; gamepad; autoplay"
                    title="workspace"
                    @load="onFrameLoad($event)"></iframe>
          </article>
        </section>

        <div
          class="chat-split"
          x-show="full && chatOpen"
          title="Resize chat"
          @pointerdown="startChatResize($event)"
        ></div>
        <div class="chat-rail" x-show="full && chatOpen">
          <div
            x-component="mjs-chat"
            mode="sidebar"
            store="chat"
            id-prefix="desktop"
            :show-tabs="false"
            :show-history="false"
            :show-agent="false"
            :show-goto="false"
            :show-visibility="true"
            :show-starters="false"
            :show-status="true"
          >
            <h1>Session</h1>
            <p class="text-xs">
              This agent session owns <strong>this</strong> workspace. File and
              shell tools share the container jail; browser tools drive only
              this workspace's Chromium window (cookies are shared).
            </p>
          </div>
        </div>
      </main>
    </div>
  `,
})

const boot = async (bust = Date.now()) => {
  const { registerChat: register } = await import(`/vendor/m-js-cmp-chat/src/index.js?t=${bust}`)
  register(M)
  resetLogClients()
  try { Router.stop() } catch {}
  ensureRoutes()
  M.mount('#app', App)
  // Keep the App shell across hash changes so the iframe is not rebuilt.
  Router.onChange(() => applyRouteFromHash())
  await refresh()
  applyRouteFromHash()
}

window.__M_BOOT__ = boot
window.__desktopRefresh = refresh
window.__desktopLeave = leaveFuller

if (!window.__DESKTOP_ONCE__) {
  window.__DESKTOP_ONCE__ = true
  setInterval(() => window.__desktopRefresh?.(), 1000)
  window.addEventListener('keydown', (ev) => {
    if (ev.key !== 'Escape') return
    if (ui.wsRenameOpen) {
      ev.preventDefault()
      ev.stopPropagation()
      closeWsRename()
      try { M.redraw() } catch {}
      return
    }
    if (!(ui.selectedDesktop || ui.selectedContainer)) return
    if (ev.target && ev.target.closest && ev.target.closest('textarea, input, .sheet-chat, .mjs-chat')) {
      return
    }
    ev.preventDefault()
    ev.stopPropagation()
    if (ui.fullView) window.__desktopLeave?.()
    else if (ui.selectedDesktop) {
      ui.selectedDesktop = null
      try { M.redraw() } catch {}
    } else if (ui.selectedContainer) {
      ui.selectedContainer = null
      try { M.redraw() } catch {}
    }
  }, true)
  window.addEventListener('contextmenu', (ev) => {
    if (ev.target?.closest?.('.ws-thumb, .desktop-nest')) {
      ev.preventDefault()
    }
  }, true)
}

await boot()
