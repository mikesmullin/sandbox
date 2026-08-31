import M from '../vendor/m.min.js'
import { drawGauge, drawSpark, formatBytes, formatBps, SPARK_N } from './components/Spark.js'
import { withBase, wsUrl } from './paths.js'

const MAX_LINES = 400
const SPARK_KEYS = ['cpu', 'netRx', 'netTx', 'diskR', 'diskW']

export const panes = M.store('panes', {
  // name -> { desktop?: bool, log?: bool, gauges?: bool }
  flags: {},
})

export const telem = M.store('telem', {
  byName: {},
})

const logSocks = new Map()
const logBuf = new Map()
const logPinned = new Map()
const logScroll = new Map()
let logStickLock = false

const paneOf = (name) => panes.flags[name] || {}

export const wantDesktop = (d) => {
  const p = paneOf(d.name)
  if (p.desktop != null) return p.desktop
  return Boolean(d.ready)
}

export const wantLog = (d) => {
  const p = paneOf(d.name)
  if (p.log != null) return p.log
  return !d.ready
}

export const wantGauges = (d) => Boolean(paneOf(d.name).gauges)

export const setPane = (name, patch) => {
  panes.flags = { ...panes.flags, [name]: { ...paneOf(name), ...patch } }
}

export const toggleDesktop = (d, ev) => {
  ev?.stopPropagation?.()
  setPane(d.name, { desktop: !wantDesktop(d) })
}

export const toggleLog = (d, ev) => {
  ev?.stopPropagation?.()
  setPane(d.name, { log: !wantLog(d) })
}

export const toggleGauges = (d, ev) => {
  ev?.stopPropagation?.()
  setPane(d.name, { gauges: !wantGauges(d) })
}

const logEl = (name) => {
  const shell = document.querySelector(`.log-for-${CSS.escape(name)}`)
  if (!shell) return null
  return shell.querySelector('.log-pane') || shell
}

const appendLine = (name, row, el = logEl(name)) => {
  if (!el) return
  const line = document.createElement('div')
  line.className = 'log-line'
  if (row.ts) {
    const ts = document.createElement('span')
    ts.className = 'log-ts'
    ts.textContent = row.ts
    line.appendChild(ts)
  }
  const msg = document.createElement('span')
  msg.className = 'log-msg'
  msg.textContent = row.line || ''
  line.appendChild(msg)
  el.appendChild(line)
  while (el.childElementCount > MAX_LINES) el.firstElementChild.remove()
}

const nameOfPane = (el) => {
  const shell = el?.closest?.('.log-shell') || el
  const m = [...(shell?.classList || [])].find((c) => String(c).startsWith('log-for-'))
  return m ? m.slice('log-for-'.length) : el?.getAttribute?.('data-log')
}

const hookScroll = (name, el) => {
  if (!el || el.dataset.stickHooked) return
  el.dataset.stickHooked = '1'
  el.addEventListener('scroll', (ev) => onLogScroll(name, ev), { passive: true })
}

const paintPane = (name) => {
  const el = logEl(name)
  if (!el) return
  const first = !el.dataset.stickHooked
  if (first) logPinned.set(name, true)
  const rows = logBuf.get(name) || []
  logStickLock = true
  try {
    if (!(el.childElementCount === rows.length && rows.length)) {
      el.replaceChildren()
      for (const row of rows) appendLine(name, row, el)
    }
    if (logPinned.get(name) !== false) {
      el.scrollTop = el.scrollHeight
      logScroll.set(name, el.scrollTop)
    }
  } finally {
    logStickLock = false
  }
  hookScroll(name, el)
  stickLogs(name)
}

export const stickLogs = (name) => {
  const apply = (el, inst) => {
    if (!el || !inst) return
    if (logPinned.get(inst) !== false) {
      el.scrollTop = el.scrollHeight
      logScroll.set(inst, el.scrollTop)
    } else if (logScroll.has(inst)) {
      el.scrollTop = logScroll.get(inst)
    }
  }
  logStickLock = true
  const run = () => {
    try {
      if (name) apply(logEl(name), name)
      else {
        for (const el of document.querySelectorAll('.log-pane')) {
          apply(el, nameOfPane(el))
        }
      }
    } finally {
      logStickLock = false
    }
  }
  requestAnimationFrame(run)
}

export const onLogScroll = (name, ev) => {
  if (logStickLock) return
  const el = ev?.target
  if (!el || !name) return
  const dist = el.scrollHeight - el.scrollTop - el.clientHeight
  const pinned = dist <= 32
  logScroll.set(name, el.scrollTop)
  logPinned.set(name, pinned)
}

const connectLogs = (name) => {
  if (logSocks.has(name)) return
  const ws = new WebSocket(wsUrl(`/desktops/${encodeURIComponent(name)}/logs`))
  logSocks.set(name, ws)
  logPinned.set(name, true)
  logScroll.delete(name)
  ws.addEventListener('message', (ev) => {
    let msg
    try { msg = JSON.parse(ev.data) } catch { return }
    if (msg.type === 'line') {
      const rows = logBuf.get(name) || []
      rows.push(msg)
      while (rows.length > MAX_LINES) rows.shift()
      logBuf.set(name, rows)
      const el = logEl(name)
      if (el) {
        appendLine(name, msg, el)
        stickLogs(name)
      }
    }
  })
  ws.addEventListener('close', () => {
    if (logSocks.get(name) === ws) logSocks.delete(name)
  })
}

const disconnectLogs = (name) => {
  const ws = logSocks.get(name)
  if (!ws) return
  logSocks.delete(name)
  try { ws.close() } catch {}
}

export const resetLogClients = () => {
  for (const name of [...logSocks.keys()]) disconnectLogs(name)
}

export const syncLogStreams = (items) => {
  const want = new Set()
  for (const d of items || []) {
    if (wantLog(d)) {
      want.add(d.name)
      connectLogs(d.name)
      queueMicrotask(() => paintPane(d.name))
    }
  }
  for (const name of [...logSocks.keys()]) {
    if (!want.has(name)) disconnectLogs(name)
  }
}

const emptySeries = () => ({ cpu: [], netRx: [], netTx: [], diskR: [], diskW: [] })

const pushSeries = (s, sample) => {
  const next = s || emptySeries()
  const push = (k, v) => {
    next[k] = [...(next[k] || []), Number(v) || 0].slice(-SPARK_N)
  }
  push('cpu', sample.cpu_pct)
  push('netRx', sample.net_rx_bps)
  push('netTx', sample.net_tx_bps)
  push('diskR', sample.disk_read_bps)
  push('diskW', sample.disk_write_bps)
  return next
}

export const paintGauges = (name) => {
  const root = document.querySelector(`.gauges-for-${CSS.escape(name)}`)
  if (!root) return
  const t = telem.byName[name]
  const s = t?.sample || {}
  drawGauge(root.querySelector('[data-gauge="cpu"]'), s.cpu_pct)
  drawGauge(root.querySelector('[data-gauge="ram"]'), s.ram_pct)
  drawGauge(root.querySelector('[data-gauge="disk"]'), s.disk_pct)
  const ser = t?.series || emptySeries()
  drawSpark(root.querySelector('[data-spark="cpu"]'), ser.cpu)
  drawSpark(root.querySelector('[data-spark="net"]'), ser.netRx, ser.netTx)
  drawSpark(root.querySelector('[data-spark="disk"]'), ser.diskR, ser.diskW)
}

const telemTimers = new Map()

const pollTelem = async (name) => {
  try {
    const res = await fetch(withBase(`/api/desktops/${encodeURIComponent(name)}/telem`))
    const sample = await res.json()
    if (!res.ok) throw new Error(sample.error || res.statusText)
    const prev = telem.byName[name] || { series: emptySeries() }
    const series = pushSeries(prev.series, sample)
    const snap = `${Math.round(sample.cpu_pct)}:${Math.round(sample.ram_pct)}:${Math.round(sample.disk_pct)}`
    const prevSnap = prev._snap
    if (snap !== prevSnap) {
      telem.byName = { ...telem.byName, [name]: { sample, series, error: '', _snap: snap } }
    } else {
      prev.sample = sample
      prev.series = series
    }
    queueMicrotask(() => paintGauges(name))
  } catch (err) {
    const prev = telem.byName[name] || { series: emptySeries() }
    telem.byName = { ...telem.byName, [name]: { ...prev, error: err.message } }
  }
}

export const syncGauges = (items) => {
  const want = new Set()
  for (const d of items || []) {
    if (!wantGauges(d) || !d.ready) continue
    want.add(d.name)
    if (!telemTimers.has(d.name)) {
      pollTelem(d.name)
      telemTimers.set(d.name, setInterval(() => pollTelem(d.name), 1000))
    }
  }
  for (const [name, id] of [...telemTimers.entries()]) {
    if (want.has(name)) continue
    clearInterval(id)
    telemTimers.delete(name)
  }
}

export const cpuLabel = (name) => {
  const s = telem.byName[name]?.sample
  if (!s) return '—'
  return `${s.cpu_pct ?? 0}% · ${s.cpu_cores || '?'}c`
}

export const ramLabel = (name) => {
  const s = telem.byName[name]?.sample
  if (!s) return '—'
  return `${formatBytes(s.ram_used)} / ${formatBytes(s.ram_total)}`
}

export const diskLabel = (name) => {
  const s = telem.byName[name]?.sample
  if (!s) return '—'
  return `${formatBytes(s.disk_used)} / ${formatBytes(s.disk_total)}`
}

export const netLabel = (name) => {
  const s = telem.byName[name]?.sample
  if (!s) return '—'
  return `↓${formatBps(s.net_rx_bps)} ↑${formatBps(s.net_tx_bps)}`
}

export const diskIoLabel = (name) => {
  const s = telem.byName[name]?.sample
  if (!s) return '—'
  return `R ${formatBps(s.disk_read_bps)}  W ${formatBps(s.disk_write_bps)}`
}

void SPARK_KEYS
