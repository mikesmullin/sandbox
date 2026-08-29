import M from '/vendor/m.min.js'
import RFB from '/vendor/novnc/core/rfb.js'
import { chat } from './chat.js'
import {
  telem,
  wantDesktop, wantLog, wantGauges,
  toggleDesktop, toggleLog, toggleGauges,
  syncLogStreams, syncGauges, onLogScroll, stickLogs, resetLogClients,
  cpuLabel, ramLabel, diskLabel, netLabel, diskIoLabel,
} from './logs.js'

const connections = (window.__rfb ??= new Map())

const ui = M.store('ui', {
  items: [],
  scale: { replicas: 0, ready: 0, current: 0 },
  selected: null,
  captured: false,
  error: '',
  loading: true,
  busy: false,
})

const wsUrl = (name) => {
  const proto = location.protocol === 'https:' ? 'wss:' : 'ws:'
  return `${proto}//${location.host}/desktops/${encodeURIComponent(name)}/websockify`
}

const screenEl = (name) => {
  const host = document.querySelector(`[data-screen="${CSS.escape(name)}"]`)
  if (!host) return null
  return host.querySelector('.screen-inner') || host
}

const applyMode = (name) => {
  const rfb = connections.get(name)
  if (!rfb) return
  const solo = ui.selected === name
  const grabbed = solo && ui.captured
  rfb.viewOnly = !grabbed
  rfb.focusOnClick = grabbed
  rfb.qualityLevel = solo ? 8 : 4
  rfb.compressionLevel = solo ? 2 : 4
  try {
    if (grabbed) rfb.focus()
    else rfb.blur()
  } catch {}
}

const connect = (name, el) => {
  if (!el || connections.has(name)) return
  const rfb = new RFB(el, wsUrl(name), { shared: true })
  rfb.scaleViewport = true
  rfb.clipViewport = false
  rfb.background = '#07090d'
  rfb.showDotCursor = true
  rfb.addEventListener('connect', () => applyMode(name))
  rfb.addEventListener('disconnect', (ev) => {
    connections.delete(name)
    if (ev.detail && ev.detail.clean === false) {
      setTimeout(() => {
        const node = screenEl(name)
        if (node && ui.items.some((d) => d.name === name && d.ready)) {
          connect(name, node)
        }
      }, 1500)
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
}

const syncScreens = () => {
  const live = new Set()
  for (const d of ui.items) {
    if (d.ready && wantDesktop(d)) {
      live.add(d.name)
      const el = screenEl(d.name)
      if (el) connect(d.name, el)
    }
  }
  for (const name of [...connections.keys()]) {
    if (!live.has(name)) disconnect(name)
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
  (list || []).map((d) => `${d.name}:${d.ready}:${d.phase}:${d.restarts || 0}`).join('|')

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
    if (ui.selected && !next.some((d) => d.name === ui.selected)) leaveFuller()
    ui.error = ''
    ui.loading = false
    queueMicrotask(syncScreens)
  } catch (err) {
    ui.error = err.message
    ui.loading = false
  }
}

const scaleTo = async (n) => {
  ui.busy = true
  try {
    const data = await api('/api/desktops', {
      method: 'PATCH',
      body: JSON.stringify({ replicas: n }),
    })
    ui.items = data.desktops || ui.items
    ui.scale = data.scale || ui.scale
    queueMicrotask(syncScreens)
  } catch (err) {
    ui.error = err.message
  } finally {
    ui.busy = false
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

const leaveFuller = () => {
  ui.captured = false
  ui.selected = null
  chat.attach(null)
  paint()
}

const onOutsideDesktop = (ev) => {
  if (!ui.captured) return
  if (ev.target && ev.target.closest && ev.target.closest('.screen')) return
  window.__desktopUngrab?.()
}

const App = () => ({
  get items() { return ui.items },
  get scale() { return ui.scale },
  get selected() { return ui.selected },
  get error() { return ui.error },
  get loading() { return ui.loading },
  get busy() { return ui.busy },
  get liveCount() { return ui.items.filter((d) => d.ready).length },
  get captured() { return ui.captured },
  open(d) {
    if (!d.ready) return
    const same = ui.selected === d.name
    ui.selected = d.name
    ui.captured = false
    if (!same || !chat.connected) chat.attach(d.name)
    queueMicrotask(syncScreens)
  },
  grab(ev, d) {
    if (!d.ready) return
    if (ui.selected !== d.name) return
    ev.stopPropagation()
    if (ui.captured) return
    ui.captured = true
    paint()
  },
  release() { ungrab() },
  back() { leaveFuller() },
  add() { scaleTo((ui.scale.replicas || 0) + 1) },
  remove() { scaleTo(Math.max(0, (ui.scale.replicas || 0) - 1)) },
  tileClass(d) {
    const bits = []
    if (ui.selected === d.name) bits.push('is-open')
    if (ui.selected === d.name && ui.captured) bits.push('is-capturing')
    if (wantDesktop(d)) bits.push('show-desktop')
    if (wantLog(d)) bits.push('show-log')
    if (wantGauges(d)) bits.push('show-gauges')
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
            <h1>Agent desktops</h1>
            <small>Debian · XFCE · browser-use · agent-browser</small>
          </div>
        </div>
        <div class="stats">
          <span><i class="dot" :class="liveCount ? 'live' : 'down'"></i>live <b x-text="liveCount"></b></span>
          <span>replicas <b x-text="scale.replicas"></b></span>
          <span>ready <b x-text="scale.ready"></b></span>
        </div>
        <div class="spacer"></div>
        <span class="err" x-show="error" x-text="error"></span>
        <div class="actions">
          <button class="btn ghost" type="button" x-show="selected" @click="back()">
            <i class="ph ph-arrow-left"></i> wall
          </button>
          <button class="btn" type="button" :disabled="busy || scale.replicas<=0" @click="remove()">
            <i class="ph ph-minus"></i>
          </button>
          <button class="btn" type="button" :disabled="busy || scale.replicas>=8" @click="add()">
            <i class="ph ph-plus"></i> desktop
          </button>
        </div>
      </header>

      <main class="stage" :class="selected ? 'has-chat' : ''">
        <div class="empty" x-show="!loading && items.length===0">
          <i class="ph ph-squares-four"></i>
          <h2>No desktops running</h2>
          <p>Scale up a replica to boot an XFCE session on the Kind cluster.</p>
        </div>

        <section class="wall" :class="selected ? 'solo' : 'grid'" x-show="items.length">
          <article class="tile"
                   x-for="d in items"
                   :key="d.name"
                   :class="tileClass(d)"
                   @click="open(d)">
            <div class="tile-head">
              <i class="ph ph-browser"></i>
              <span class="name" x-text="d.name"></span>
              <span class="badge" :class="badge(d)" x-text="badgeLabel(d)"></span>
              <span class="meta">
                <span class="captured-tag" x-show="selected===d.name && captured">
                  <i class="ph ph-keyboard"></i> captured
                </span>
                <span class="pane-toggles" @click.stop>
                  <button type="button" class="pane-btn" :class="wantDesktop(d) ? 'on' : ''"
                          title="Show desktop" @click="flipDesktop(d, $event)">
                    <i class="ph ph-monitor"></i> desktop
                  </button>
                  <button type="button" class="pane-btn" :class="wantLog(d) ? 'on' : ''"
                          title="Show container log" @click="flipLog(d, $event)">
                    <i class="ph ph-terminal"></i> log
                  </button>
                  <button type="button" class="pane-btn" :class="wantGauges(d) ? 'on' : ''"
                          title="Show gauges" @click="flipGauges(d, $event)">
                    <i class="ph ph-gauge"></i> gauges
                  </button>
                </span>
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
            <div class="screen" x-show="wantDesktop(d)" :data-screen="d.name" @click="grab($event, d)">
              <div class="screen-inner" x-ignore></div>
              <div class="capture hint" x-show="selected===d.name && !captured && d.ready">
                <i class="ph ph-cursor-click"></i>
                click desktop to control
              </div>
              <div class="capture" x-show="selected===d.name && captured">
                <i class="ph ph-mouse"></i>
                mouse + keyboard captured
                <span><span class="kbd">Esc</span> releases</span>
              </div>
            </div>
            <div class="log-shell" x-show="wantLog(d)"
                 :class="(wantDesktop(d) ? 'is-compact' : 'is-fill') + ' log-for-' + d.name"
                 @click.stop>
              <div class="log-pane" tabindex="0" x-ignore></div>
            </div>
          </article>
        </section>
        <div class="chat-rail" x-show="selected" @pointerdown="release()" @mousedown="release()">
          <div
            x-component="mjs-chat"
            mode="sidebar"
            store="chat"
            id-prefix="desktop"
            title="desktop agent"
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
              This agent runs <strong>inside</strong> the container. File, shell,
              and Chromium tools execute on the desktop you are watching.
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
  for (const name of [...connections.keys()]) disconnect(name)
  resetLogClients()
  M.mount('#app', App)
  await refresh()
}

window.__M_BOOT__ = boot
window.__desktopRefresh = refresh
window.__desktopUngrab = ungrab
window.__desktopLeave = leaveFuller

if (!window.__DESKTOP_ONCE__) {
  window.__DESKTOP_ONCE__ = true
  setInterval(() => window.__desktopRefresh?.(), 3000)
  window.addEventListener('keydown', (ev) => {
    if (ev.key !== 'Escape' || !ui.selected) return
    if (ev.target && ev.target.closest && ev.target.closest('textarea, input, .sheet-chat, .mjs-chat')) {
      if (ui.captured) window.__desktopUngrab?.()
      return
    }
    ev.preventDefault()
    ev.stopPropagation()
    if (ui.captured) window.__desktopUngrab?.()
    else window.__desktopLeave?.()
  }, true)
  window.addEventListener('pointerdown', onOutsideDesktop, true)
  window.addEventListener('mousedown', onOutsideDesktop, true)
}

await boot()
