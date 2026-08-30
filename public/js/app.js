import M from '/vendor/m.min.js'
import RFB from '/vendor/novnc/core/rfb.js'
import KeyTable from '/vendor/novnc/core/input/keysym.js'
import { chat } from './chat.js'
import {
  telem,
  wantDesktop, wantLog, wantGauges,
  toggleDesktop, toggleLog, toggleGauges,
  syncLogStreams, syncGauges, onLogScroll, stickLogs, resetLogClients,
  cpuLabel, ramLabel, diskLabel, netLabel, diskIoLabel,
} from './logs.js'

const connections = (window.__rfb ??= new Map())

const CHAT_OPEN_KEY = 'agent-desktop.chatOpen'
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

const ui = M.store('ui', {
  items: [],
  scale: { replicas: 0, ready: 0, current: 0 },
  selectedContainer: null,
  selectedDesktop: null,
  fullView: false,
  chatOpen: readChatOpen(),
  captured: false,
  error: '',
  loading: true,
  busy: false,
  thumbGen: 0,
  vncLive: {},
  thumbOk: {},
  thumbRetry: {},
})
ui.chatOpen = readChatOpen()

const wsUrl = (name) => {
  const proto = location.protocol === 'https:' ? 'wss:' : 'ws:'
  return `${proto}//${location.host}/desktops/${encodeURIComponent(name)}/websockify`
}

const FLY_MS = 380

const isShown = (el) => {
  if (!el) return false
  const cs = getComputedStyle(el)
  if (cs.display === 'none' || cs.visibility === 'hidden') return false
  return true
}

const destHost = (name) => {
  if (fullPod() === name) {
    const wall = document.querySelector('.wall.solo')
    if (!isShown(wall)) return null
    const host = wall.querySelector(`[data-screen="${CSS.escape(`full:${name}`)}"]`)
    return isShown(host) ? host : null
  }
  const wall = document.querySelector('.wall.grid')
  if (!isShown(wall)) return null
  const d = ui.items.find((x) => x.name === name)
  const list = d?.workspaces || []
  const current = list.find((w) => w.current) || list[0]
  if (!current) return null
  const key = `${name}:${current.id}`
  const hosts = wall.querySelectorAll(`[data-screen="${CSS.escape(key)}"]`)
  for (const h of hosts) {
    if (!isShown(h)) continue
    const r = h.getBoundingClientRect()
    if (r.width > 2 && r.height > 2) return h
  }
  return null
}

const destRect = (name) => {
  const host = destHost(name)
  if (!host) return null
  const r = host.getBoundingClientRect()
  if (r.width < 2 || r.height < 2) return null
  return r
}

const destReady = (name, r) => {
  if (!r) return false
  if (fullPod() === name) {
    const stage = document.querySelector('.stage')
    const sr = stage?.getBoundingClientRect()
    if (!sr || sr.height < 40) return r.width > 120 && r.height > 80
    return r.width >= sr.width * 0.4 && r.height >= sr.height * 0.55
  }
  return r.width > 48 && r.height > 48
}

const flyEl = (name) => {
  const layer = document.querySelector('.rfb-layer')
  if (!layer) return null
  let el = layer.querySelector(`[data-rfb="${CSS.escape(name)}"]`)
  if (!el) {
    el = document.createElement('div')
    el.className = 'rfb-fly'
    el.dataset.rfb = name
    layer.appendChild(el)
  }
  return el
}

const hostWatch = new Map()
const destObs = new ResizeObserver(() => {
  for (const name of connections.keys()) {
    const fly = flyEl(name)
    if (fly?.dataset.anim === '1') continue
    placeFly(name)
  }
})

const watchDest = (name) => {
  const host = destHost(name)
  const prev = hostWatch.get(name)
  if (prev === host) return
  if (prev) destObs.unobserve(prev)
  if (host) {
    destObs.observe(host)
    hostWatch.set(name, host)
  } else {
    hostWatch.delete(name)
  }
}

const fitRfb = (name) => {
  const rfb = connections.get(name)
  if (!rfb) return
  try { if (rfb._screen) rfb._screen.style.overflow = 'hidden' } catch {}
  try { rfb._updateScale?.() } catch {}
}

const placeFly = (name, { fromRect } = {}) => {
  const fly = flyEl(name)
  if (!fly) return
  const to = destRect(name)
  if (!to) {
    if (fromRect || fly.dataset.anim === '1' || connections.get(name)) return
    fly.classList.add('is-hidden')
    return
  }
  fly.classList.remove('is-hidden')
  fly.classList.toggle('is-full', fullPod() === name)
  fly.classList.toggle('is-capturing', fullPod() === name && ui.captured)
  fly.style.left = `${to.left}px`
  fly.style.top = `${to.top}px`
  fly.style.width = `${to.width}px`
  fly.style.height = `${to.height}px`
  fitRfb(name)
  const live = Boolean(ui.vncLive?.[name] || connections.get(name))
  const from = fromRect && fromRect.width > 2 && fromRect.height > 2 ? fromRect : null
  if (from && live && fly.dataset.anim !== '1') {
    const sx = from.width / to.width
    const sy = from.height / to.height
    const dx = from.left - to.left
    const dy = from.top - to.top
    fly.style.transition = 'none'
    fly.style.transform = `translate(${dx}px, ${dy}px) scale(${sx}, ${sy})`
    fly.dataset.anim = '1'
    fly.offsetWidth
    fly.style.transition = `transform ${FLY_MS}ms cubic-bezier(.22,.75,.2,1)`
    fly.style.transform = 'translate(0, 0) scale(1)'
    const done = (ev) => {
      if (ev && ev.target !== fly) return
      if (fly.dataset.anim !== '1') return
      fly.dataset.anim = ''
      fly.style.transition = ''
      fly.style.transform = ''
      placeFly(name)
      applyMode(name)
      fitRfb(name)
    }
    fly.addEventListener('transitionend', done)
    setTimeout(() => done(), FLY_MS + 80)
  } else if (fly.dataset.anim !== '1') {
    fly.style.transition = ''
    fly.style.transform = ''
  }
}

const placeFlyWhenReady = (name, opts = {}) => {
  let n = 0
  const tick = () => {
    watchDest(name)
    const r = destRect(name)
    if (destReady(name, r) || n >= 12) {
      placeFly(name, opts)
      watchDest(name)
      return
    }
    n += 1
    requestAnimationFrame(tick)
  }
  requestAnimationFrame(tick)
}

const placeAllFlies = () => {
  for (const name of connections.keys()) {
    const fly = flyEl(name)
    if (fly?.dataset.anim === '1') continue
    watchDest(name)
    placeFly(name)
  }
}

const fullPod = () => (ui.fullView && ui.selectedDesktop?.name) || null

const applyMode = (name) => {
  const rfb = connections.get(name)
  if (!rfb) return
  const solo = fullPod() === name
  const grabbed = solo && ui.captured
  rfb.viewOnly = !grabbed
  rfb.focusOnClick = grabbed
  rfb.qualityLevel = solo ? 8 : 4
  rfb.compressionLevel = solo ? 2 : 4
  flyEl(name)?.classList.toggle('is-capturing', grabbed)
  try {
    if (grabbed) rfb.focus()
    else rfb.blur()
  } catch {}
}

const setVncLive = (name, live) => {
  const cur = Boolean(ui.vncLive?.[name])
  if (cur === live) return
  ui.vncLive = { ...ui.vncLive, [name]: live }
}

const CLIP_SKIP = 'textarea, input, select, [contenteditable], .mjs-chat, .sheet-chat'
const inClipSkip = (el) => Boolean(el?.closest?.(CLIP_SKIP))

const capturedRfb = () => {
  if (!ui.captured) return null
  const name = fullPod()
  if (!name) return null
  const rfb = connections.get(name)
  if (!rfb || rfb._rfbConnectionState !== 'connected') return null
  return rfb
}

const sendGuestClipboard = (rfb, text) => {
  if (!rfb || text == null || text === '') return false
  try {
    rfb.clipboardPasteFrom(text)
    return true
  } catch {
    return false
  }
}

const writeHostClipboard = (text) => {
  if (typeof text !== 'string' || !navigator.clipboard?.writeText) return
  navigator.clipboard.writeText(text).catch(() => {})
}

const pushHostClipboard = (rfb) => {
  if (!rfb || !navigator.clipboard?.readText) return
  navigator.clipboard.readText()
    .then((t) => {
      if (!t) return
      if (rfb._rfbConnectionState !== 'connected' || rfb.viewOnly) return
      sendGuestClipboard(rfb, t)
    })
    .catch(() => {})
}

const sendGuestPaste = (rfb, ctrlHeld) => {
  try {
    if (!ctrlHeld) rfb.sendKey(KeyTable.XK_Control_L, 'ControlLeft', true)
    rfb.sendKey(KeyTable.XK_v, 'KeyV', true)
    rfb.sendKey(KeyTable.XK_v, 'KeyV', false)
    if (!ctrlHeld) rfb.sendKey(KeyTable.XK_Control_L, 'ControlLeft', false)
  } catch {}
}

const fireGuestPaste = (rfb, text, ctrlHeld) => {
  const stuffed = sendGuestClipboard(rfb, text)
  const go = () => {
    if (rfb._rfbConnectionState !== 'connected' || rfb.viewOnly) return
    sendGuestPaste(rfb, ctrlHeld)
  }
  if (stuffed) setTimeout(go, 30)
  else go()
}

const connect = (name) => {
  const el = flyEl(name)
  if (!el) return
  const existing = connections.get(name)
  if (existing && existing.__el === el) return
  if (existing) disconnect(name)
  setVncLive(name, false)
  const rfb = new RFB(el, wsUrl(name), { shared: true })
  rfb.__el = el
  rfb.scaleViewport = true
  rfb.clipViewport = false
  rfb.background = '#07090d'
  try { if (rfb._screen) rfb._screen.style.overflow = 'hidden' } catch {}
  rfb.showDotCursor = true
  rfb.addEventListener('clipboard', (ev) => {
    if (fullPod() !== name) return
    writeHostClipboard(ev.detail?.text)
  })
  rfb.addEventListener('connect', () => {
    applyMode(name)
    setVncLive(name, true)
    placeFly(name)
    if (ui.captured && fullPod() === name) pushHostClipboard(rfb)
  })
  rfb.addEventListener('disconnect', (ev) => {
    connections.delete(name)
    setVncLive(name, false)
    flyEl(name)?.classList.add('is-hidden')
    if (ev.detail && ev.detail.clean === false) {
      setTimeout(() => {
        if (ui.items.some((d) => d.name === name && d.ready)) syncScreens()
      }, 800)
    }
  })
  connections.set(name, rfb)
  applyMode(name)
}

const disconnect = (name) => {
  const rfb = connections.get(name)
  if (!rfb) return
  try { rfb.disconnect() } catch {}
  connections.delete(name)
  setVncLive(name, false)
  const fly = flyEl(name)
  if (fly) {
    fly.dataset.anim = ''
    fly.classList.add('is-hidden')
  }
}

const syncScreens = (opts = {}) => {
  const live = new Set()
  const full = fullPod()
  if (full) {
    const c = ui.items.find((d) => d.name === full)
    if (c?.ready) live.add(c.name)
  } else {
    for (const d of ui.items) {
      if (!(d.ready && wantDesktop(d))) continue
      const list = d.workspaces || []
      if (list.length !== 1) continue
      if (!list[0]) continue
      live.add(d.name)
    }
  }
  for (const name of live) connect(name)
  for (const name of live) {
    const fly = flyEl(name)
    if (opts.flyName === name && opts.fromRect) placeFlyWhenReady(name, { fromRect: opts.fromRect })
    else if (fly?.dataset.anim !== '1') {
      watchDest(name)
      placeFly(name)
    }
  }
  for (const name of [...connections.keys()]) {
    if (live.has(name)) continue
    const fly = flyEl(name)
    if (opts.flyName === name && opts.fromRect && fly) {
      placeFlyWhenReady(name, { fromRect: opts.fromRect })
      const hold = name
      setTimeout(() => {
        if (fullPod() === hold) return
        const d = ui.items.find((x) => x.name === hold)
        if (d?.ready && wantDesktop(d) && (d.workspaces || []).length === 1) return
        disconnect(hold)
      }, FLY_MS + 120)
    } else {
      disconnect(name)
    }
  }
  for (const name of connections.keys()) applyMode(name)
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
    const ws = (d.workspaces || []).map((w) => `${w.id}${w.current ? '*' : ''}`).join(',')
    return `${d.name}:${d.ready}:${d.phase}:${d.restarts || 0}:${ws}`
  }).join('|')

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
    if (ui.selectedContainer && !next.some((d) => d.name === ui.selectedContainer)) {
      ui.selectedContainer = null
    }
    if (ui.selectedDesktop && next.length && !next.some((d) => d.name === ui.selectedDesktop.name)) {
      const wasFull = ui.fullView
      ui.selectedDesktop = null
      ui.fullView = false
      ui.captured = false
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
  for (const name of connections.keys()) applyMode(name)
  try { M.redraw() } catch {}
}

const ungrab = () => {
  if (!ui.captured) return
  ui.captured = false
  paint()
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

let pendingFly = null

const applyRouteFromHash = () => {
  const full = readFullRoute()
  if (full) {
    const same = ui.fullView
      && ui.selectedDesktop?.name === full.name
      && String(ui.selectedDesktop?.ws) === String(full.ws)
    const fly = pendingFly
    pendingFly = null
    ui.selectedContainer = null
    ui.selectedDesktop = { name: full.name, ws: full.ws }
    ui.fullView = true
    if (!same) ui.captured = false
    chat.attach(`${full.name}::${full.ws}`)
    paint()
    queueMicrotask(() => syncScreens({
      fromRect: fly?.name === full.name ? fly.fromRect : null,
      flyName: full.name,
    }))
    if (fly || !same) {
      api(`/api/desktops/${encodeURIComponent(full.name)}/workspaces/${encodeURIComponent(full.ws)}/focus`, {
        method: 'POST',
      }).catch((err) => console.warn('workspace focus', err))
    }
    return
  }
  pendingFly = null
  if (!ui.fullView) return
  const name = ui.selectedDesktop?.name
  const fromRect = name ? flyEl(name)?.getBoundingClientRect() : null
  ui.captured = false
  ui.fullView = false
  chat.attach(null)
  paint()
  queueMicrotask(() => syncScreens({ fromRect, flyName: name }))
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

const onOutsideDesktop = (ev) => {
  if (!ui.captured) return
  if (ev.target && ev.target.closest && ev.target.closest('.screen, .rfb-fly')) return
  window.__desktopUngrab?.()
}

const workspacesOf = (c) =>
  (c?.workspaces && c.workspaces.length)
    ? c.workspaces
    : [{ id: 'workspace', name: 'workspace', current: true }]

let burstTimer = 0
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
  get pickedContainer() { return ui.selectedContainer },
  get full() { return ui.fullView ? ui.selectedDesktop : null },
  get chatOpen() { return ui.chatOpen },
  get error() { return ui.error },
  get loading() { return ui.loading },
  get busy() { return ui.busy },
  get liveCount() { return ui.items.filter((d) => d.ready).length },
  get workspaceCount() {
    return ui.items.reduce((n, d) => n + workspacesOf(d).length, 0)
  },
  get captured() { return ui.captured },
  get thumbGen() { return ui.thumbGen },
  get vncLiveMap() { return ui.vncLive },
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
  liveWall(c, ws) {
    return Boolean(c?.ready && this.wsCount(c) === 1 && ws?.current)
  },
  fullTitle() {
    const f = this.full
    if (!f) return ''
    const c = this.fullContainer()
    const ws = workspacesOf(c).find((w) => String(w.id) === String(f.ws))
    const right = ws?.name || (f.ws != null ? String(f.ws) : '')
    return right ? `${f.name} > ${right}` : f.name
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
    ui.captured = false
    ui.selectedDesktop = null
    ui.selectedContainer = ui.selectedContainer === c.name ? null : c.name
    chat.attach(null)
    paint()
  },
  pickDesktop(c, ws, ev) {
    ev?.stopPropagation?.()
    const same = ui.selectedDesktop?.name === c.name && String(ui.selectedDesktop?.ws) === String(ws.id) && !ui.fullView
    ui.fullView = false
    ui.captured = false
    ui.selectedContainer = null
    ui.selectedDesktop = same ? null : { name: c.name, ws: ws.id }
    chat.attach(null)
    paint()
  },
  async openDesktop(c, ws, ev) {
    ev?.stopPropagation?.()
    if (!c.ready) return
    pendingFly = { name: c.name, fromRect: ev.currentTarget?.getBoundingClientRect?.() }
    goFull(c.name, ws.id)
  },
  grab(ev, c) {
    if (!c?.ready) return
    if (fullPod() !== c.name) return
    ev.stopPropagation()
    if (ui.captured) return
    ui.captured = true
    paint()
    const rfb = connections.get(c.name)
    if (rfb) pushHostClipboard(rfb)
  },
  release() { ungrab() },
  back() { goWall() },
  toggleChat() {
    ui.chatOpen = !ui.chatOpen
    writeChatOpen(ui.chatOpen)
    paint()
    queueMicrotask(placeAllFlies)
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
        ui.captured = false
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
        ui.captured = false
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
  vncLive(name) { return Boolean(this.vncLiveMap?.[name]) },
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
  screenClass(c, ws) {
    const bits = ['screen']
    if (this.vncLiveMap?.[c.name]) bits.push('is-live')
    else bits.push('is-wait')
    return bits.join(' ')
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
                  :class="chatOpen ? 'on' : 'off'"
                  :aria-pressed="chatOpen ? 'true' : 'false'"
                  title="Toggle chat sidebar"
                  @click="toggleChat()">
            <i class="ph ph-chat-circle"></i> chat
          </button>
        </div>
      </header>

      <main class="stage" :class="(full && chatOpen) ? 'has-chat' : ''"
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
                  <span class="name" x-text="ws.name"></span>
                  <span class="rec-dot" x-show="ws.current" title="capturing"></span>
                </div>
                <div class="screen" x-show="liveWall(d, ws)"
                     :class="screenClass(d, ws)"
                     :data-screen="screenKey(d, ws)"
                     @click="openDesktop(d, ws, $event)">
                  <div class="screen-wait">
                    <i class="ph ph-circle-notch ph-spinner"></i>
                    <span>waiting for workspace</span>
                  </div>
                </div>
                <div class="screen thumb-screen" x-show="!liveWall(d, ws)"
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
          <article class="tile is-open" :class="captured ? 'is-capturing show-desktop' : 'show-desktop'">
            <div class="tile-head">
              <i class="ph ph-browser"></i>
              <span class="name" x-text="fullTitle()"></span>
              <span class="meta">
                <span class="capture-status hint"
                      x-show="full && !captured && fullContainer() && fullContainer().ready">
                  <i class="ph ph-cursor-click"></i>
                  click workspace to control
                </span>
                <span class="capture-status" x-show="captured">
                  <i class="ph ph-mouse"></i>
                  mouse + keyboard + clipboard
                  <span><span class="kbd">Esc</span> releases</span>
                </span>
              </span>
            </div>
            <div class="screen" :class="full && vncLiveMap[full.name] ? 'is-live' : 'is-wait'"
                 :data-screen="full ? ('full:' + full.name) : ''"
                 @click="grab($event, fullContainer())">
              <div class="screen-wait">
                <i class="ph ph-circle-notch ph-spinner"></i>
                <span>waiting for workspace</span>
              </div>
            </div>
          </article>
        </section>

        <div class="chat-rail" x-show="full && chatOpen" @pointerdown="release()" @mousedown="release()">
          <div
            x-component="mjs-chat"
            mode="sidebar"
            store="chat"
            id-prefix="desktop"
            :show-tabs="false"
            :show-history="false"
            :show-agent="false"
            :show-goto="false"
            :show-visibility="false"
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
      <div class="rfb-layer" x-ignore></div>
    </div>
  `,
})

const boot = async (bust = Date.now()) => {
  const { registerChat: register } = await import(`/vendor/m-js-cmp-chat/src/index.js?t=${bust}`)
  register(M)
  for (const name of [...connections.keys()]) disconnect(name)
  document.querySelector('.rfb-layer')?.replaceChildren()
  resetLogClients()
  try { Router.stop() } catch {}
  ensureRoutes()
  M.mount('#app', App)
  // Keep the App shell across hash changes so noVNC canvases are not rebuilt.
  Router.onChange(() => applyRouteFromHash())
  await refresh()
  applyRouteFromHash()
}

window.__M_BOOT__ = boot
window.__desktopRefresh = refresh
window.__desktopUngrab = ungrab
window.__desktopLeave = leaveFuller
window.__desktopPlaceFlies = placeAllFlies

const isPasteChord = (ev) => {
  if (ev.altKey) return false
  if (ev.code !== 'KeyV' && ev.key !== 'v' && ev.key !== 'V') return false
  return Boolean(ev.ctrlKey || ev.metaKey)
}

window.__desktopOnPasteKey = (ev) => {
  if (!isPasteChord(ev) || !ui.captured || inClipSkip(ev.target)) return
  const rfb = capturedRfb()
  if (!rfb) return
  ev.stopImmediatePropagation()
  if (ev.repeat || rfb.__awaitPaste || rfb.__pasteDone) return
  rfb.__awaitPaste = true
  const ctrlHeld = Boolean(ev.ctrlKey)
  const finish = (text) => {
    if (rfb.__pasteDone) return
    rfb.__pasteDone = true
    rfb.__awaitPaste = false
    clearTimeout(rfb.__pasteTimer)
    rfb.__pasteFinish = null
    fireGuestPaste(rfb, text, ctrlHeld)
    setTimeout(() => { rfb.__pasteDone = false }, 400)
  }
  rfb.__pasteFinish = finish
  rfb.__pasteTimer = setTimeout(() => finish(''), 150)
  navigator.clipboard?.readText?.().then((t) => finish(t)).catch(() => {})
}

window.__desktopOnPaste = (ev) => {
  if (!ui.captured || inClipSkip(ev.target)) return
  const rfb = capturedRfb()
  if (!rfb) return
  ev.preventDefault()
  if (rfb.__pasteDone) return
  const text = ev.clipboardData?.getData('text/plain') ?? ''
  if (typeof rfb.__pasteFinish === 'function') rfb.__pasteFinish(text)
  else fireGuestPaste(rfb, text, false)
}

window.__desktopOnClipChange = () => {
  const rfb = capturedRfb()
  if (rfb) pushHostClipboard(rfb)
}

if (!window.__DESKTOP_ONCE__) {
  window.__DESKTOP_ONCE__ = true
  setInterval(() => window.__desktopRefresh?.(), 1000)
  window.addEventListener('keydown', (ev) => {
    if (ev.key !== 'Escape' || !(ui.selectedDesktop || ui.selectedContainer || ui.captured)) return
    if (ev.target && ev.target.closest && ev.target.closest('textarea, input, .sheet-chat, .mjs-chat')) {
      if (ui.captured) window.__desktopUngrab?.()
      return
    }
    ev.preventDefault()
    ev.stopPropagation()
    if (ui.captured) window.__desktopUngrab?.()
    else if (ui.fullView) window.__desktopLeave?.()
    else if (ui.selectedDesktop) {
      ui.selectedDesktop = null
      try { M.redraw() } catch {}
    } else if (ui.selectedContainer) {
      ui.selectedContainer = null
      try { M.redraw() } catch {}
    }
  }, true)
  window.addEventListener('pointerdown', onOutsideDesktop, true)
  window.addEventListener('mousedown', onOutsideDesktop, true)
  window.addEventListener('resize', () => window.__desktopPlaceFlies?.())
  window.addEventListener('scroll', () => window.__desktopPlaceFlies?.(), true)
}

if (!window.__DESKTOP_CLIP_ONCE__) {
  window.__DESKTOP_CLIP_ONCE__ = true
  window.addEventListener('keydown', (ev) => window.__desktopOnPasteKey?.(ev), true)
  window.addEventListener('paste', (ev) => window.__desktopOnPaste?.(ev), true)
  try { navigator.clipboard?.addEventListener?.('clipboardchange', () => window.__desktopOnClipChange?.()) } catch {}
  document.addEventListener('clipboardchange', () => window.__desktopOnClipChange?.())
}

await boot()
