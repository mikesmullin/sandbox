/**
 * Optional chat store + WebSocket transport.
 *
 * Apps with their own session/history layer (cowork) should keep that store
 * and only mount `mjs-chat`. Apps that just need "connect to an agent WS"
 * (agent-desktop) can use createChatStore + wsTransport.
 */

import {
  fillSelect,
  formatElapsed,
  formatTelemetryHtml,
  formatToolArgs,
  renderMarkdown,
  toolCallCode,
  toolCallExplanation,
  toolResultImageNote,
  onBubbleScroll,
  toggleBubbleExpand,
  toggleBubbleCollapse,
  stickBubbleScrolls as stickBubbleScrollsHelper,
  watchBubbleScrolls as watchBubbleScrollsHelper,
} from './helpers.js'

const looksLikeProviderDump = (text) => {
  const t = String(text || '').trim()
  return t.startsWith('{') && /"choices"\s*:/.test(t) && /"usage"\s*:/.test(t)
}

/** tool_call ↔ tool_result FIFO pair (providers need both sides). */
const visibilityGroup = (messages, msg) => {
  if (!msg) return []
  if (msg.kind !== 'tool_call' && msg.kind !== 'tool_result') return [msg]
  const pending = new Map()
  const partnerOf = new Map()
  for (const m of messages || []) {
    if (m.kind === 'tool_call' && m.name) {
      if (!pending.has(m.name)) pending.set(m.name, [])
      pending.get(m.name).push(m)
    } else if (m.kind === 'tool_result' && m.name) {
      const q = pending.get(m.name)
      if (q?.length) {
        const call = q.shift()
        partnerOf.set(call, m)
        partnerOf.set(m, call)
      }
    }
  }
  const other = partnerOf.get(msg)
  return other ? [msg, other] : [msg]
}

const proto = () => (typeof location !== 'undefined' && location.protocol === 'https:' ? 'wss:' : 'ws:')

/**
 * @param {{ url: string | ((store: object) => string) }} opts
 */
export function wsTransport(opts = {}) {
  const urlOf = (store) => {
    if (typeof opts.url === 'function') return opts.url(store)
    if (opts.url) return opts.url
    return `${proto()}//${location.host}${store.path || '/agent'}`
  }

  return {
    connect(store) {
      const url = urlOf(store)
      if (!url) return
      const ws = new WebSocket(url)
      store._ws = ws
      ws.addEventListener('open', () => {
        if (store._ws !== ws) return
        store.connected = true
        store.error = ''
      })
      ws.addEventListener('message', (ev) => {
        if (store._ws !== ws) return
        let msg
        try {
          msg = JSON.parse(ev.data)
        } catch {
          return
        }
        store.handle(msg)
      })
      ws.addEventListener('close', () => {
        if (store._ws !== ws) return
        store.connected = false
        store.waiting = false
        if (store._reconnect && store.desktop) {
          clearTimeout(store._reconn)
          store._reconn = setTimeout(() => {
            if (store.desktop && (!store._ws || store._ws.readyState > 1)) {
              store.attach(store.desktop)
            }
          }, 800)
        }
      })
      ws.addEventListener('error', () => {
        if (store._ws !== ws) return
        applyIncoming(store, { type: 'error', error: 'agent socket error' })
      })
    },
    send(store, payload) {
      if (!store._ws || store._ws.readyState !== WebSocket.OPEN) return
      store._ws.send(JSON.stringify(payload))
    },
    abort(store) {
      try {
        store._ws?.send(JSON.stringify({ type: 'abort' }))
      } catch {
        /* ignore */
      }
    },
    setModel(store, model) {
      try {
        store._ws?.send(JSON.stringify({ type: 'model', model }))
      } catch {
        /* ignore */
      }
    },
    setAllowlist(store, text, overridden) {
      try {
        store._ws?.send(JSON.stringify({ type: 'allowlist', text, overridden: Boolean(overridden) }))
      } catch {
        /* ignore */
      }
    },
    approve(store, id, decision) {
      try {
        store._ws?.send(JSON.stringify({ type: 'approval', id, decision }))
      } catch {
        /* ignore */
      }
    },
    setVisible(store, eventId, visible) {
      try {
        store._ws?.send(JSON.stringify({ type: 'visible', eventId, visible: Boolean(visible) }))
      } catch {
        /* ignore */
      }
    },
  }
}

const cloneTelemetry = (t) => {
  if (!t || typeof t !== 'object') return null
  try {
    return structuredClone(t)
  } catch {
    return { ...t }
  }
}

/**
 * Apply an incoming agent-harness event to a single-session store.
 * Shared by wsTransport and tests.
 */
export function applyIncoming(store, msg) {
  if (msg.type === 'session' && msg.command === 'new') {
    store.applyNewSession?.(msg.sessionId)
    return
  }
  if (msg.type === 'state') {
    store.model = msg.model || store.model
    if (Array.isArray(msg.models) && msg.models.length) store.models = msg.models
    store.sessionId = msg.sessionId || store.sessionId
    if (msg.allowlist != null) {
      store.allowlist = String(msg.allowlist)
      store.allowlistBaseline = String(msg.allowlistBaseline ?? msg.allowlist)
      store.allowlistInited = true
      if (msg.allowlistOverridden != null) {
        store.allowlistOverridden = Boolean(msg.allowlistOverridden)
      } else {
        store.allowlistOverridden = (store.allowlist ?? '') !== (store.allowlistBaseline ?? '')
      }
    }
    if (msg.contextWindow) store.contextWindow = Number(msg.contextWindow) || store.contextWindow
    if (msg.tokensUsed != null && msg.tokensUsed !== '') {
      const n = Number(msg.tokensUsed)
      if (Number.isFinite(n) && n >= 0) store.tokensUsed = n
    }
    store.error = msg.error || ''
    if (Array.isArray(msg.messages)) {
      store.messages = msg.messages.map((m) => (m && typeof m === 'object' ? { ...m } : m))
    }
    const running = Boolean(msg.waiting || msg.phase === 'running')
    store.waiting = running
    if (running && msg.runStartedAt) {
      store.startStopwatch?.(msg.runStartedAt)
    } else if (!running) {
      store.stopStopwatch?.({ freeze: false })
      store._runStartedAt = 0
    }
    store.scrollBottom?.(true)
    return
  }
  if (msg.type === 'hello') {
    store.model = msg.model || store.model
    if (Array.isArray(msg.models) && msg.models.length) store.models = msg.models
    store.sessionId = msg.sessionId || store.sessionId
    if (msg.allowlist != null && !store.allowlistInited && !store.allowlistOverridden) {
      store.allowlist = String(msg.allowlist)
      store.allowlistBaseline = String(msg.allowlist)
      store.allowlistInited = true
    }
    if (msg.contextWindow) store.contextWindow = Number(msg.contextWindow) || store.contextWindow
    return
  }
  if (msg.type === 'models' && Array.isArray(msg.models) && msg.models.length) {
    store.models = msg.models
    return
  }
  if (msg.type === 'model' && msg.model) {
    store.model = msg.model
    if (msg.contextWindow) store.contextWindow = Number(msg.contextWindow) || store.contextWindow
    return
  }
  if (msg.type === 'draft') return
  if (msg.type === 'user') {
    const text = String(msg.text || '')
    if (!text) return
    const last = store.messages[store.messages.length - 1]
    if (last && last.kind === 'user' && last.text === text) return
    store.messages.push({
      id: crypto.randomUUID(),
      kind: 'user',
      text,
      visible: true,
      telemetry: null,
    })
    store.scrollBottom?.()
    return
  }
  if (msg.type === 'allowlist') {
    if (msg.text != null) {
      store.allowlist = String(msg.text)
      store.allowlistInited = true
      if (msg.overridden != null) store.allowlistOverridden = Boolean(msg.overridden)
      else store.allowlistOverridden = (store.allowlist ?? '') !== (store.allowlistBaseline ?? '')
    }
    return
  }
  if (msg.type === 'status') {
    const running = msg.phase === 'running' || msg.waiting === true
    store.waiting = running
    if (msg.sessionId) store.sessionId = msg.sessionId
    if (running) {
      if (msg.runStartedAt && !store._runStartedAt) store.startStopwatch?.(msg.runStartedAt)
    } else {
      store.stopStopwatch?.({ freeze: true })
      store._runStartedAt = 0
    }
    return
  }
  if (msg.type === 'approval' && (msg.id || msg.approvalId)) {
    const aid = msg.id || msg.approvalId
    const decision = msg.decision || msg.action || 'deny'
    for (const m of store.messages) {
      if (m.kind === 'approval_needed' && m.approvalId === aid) m.status = decision
    }
    return
  }
  if (msg.type === 'assistant_delta') {
    const chunk = msg.text || ''
    if (!chunk) return
    let row = null
    for (let i = store.messages.length - 1; i >= 0; i--) {
      if (store.messages[i].kind === 'assistant' && store.messages[i].streaming) {
        row = store.messages[i]
        break
      }
    }
    if (!row) {
      row = { id: crypto.randomUUID(), kind: 'assistant', text: '', streaming: true, visible: true, telemetry: null }
      store.messages.push(row)
    }
    row.text = (row.text || '') + chunk
    store.scrollBottom?.()
    return
  }
  if (msg.type === 'reasoning_delta') {
    const chunk = msg.text || ''
    if (!chunk) return
    let row = null
    for (let i = store.messages.length - 1; i >= 0; i--) {
      if (store.messages[i].kind === 'reasoning' && store.messages[i].streaming) {
        row = store.messages[i]
        break
      }
    }
    if (!row) {
      row = { id: crypto.randomUUID(), kind: 'reasoning', text: '', streaming: true, visible: true, telemetry: null }
      store.messages.push(row)
    }
    row.text = (row.text || '') + chunk
    store.scrollBottom?.()
    return
  }
  if (msg.type === 'usage' || msg.type === 'gen_info') {
    if (msg.prompt_tokens != null && msg.prompt_tokens !== '') {
      const prompt = Number(msg.prompt_tokens)
      if (Number.isFinite(prompt) && prompt >= 0) store.tokensUsed = prompt
    }
    if (msg.contextWindow) store.contextWindow = Number(msg.contextWindow) || store.contextWindow
    const t = {
      completion_tokens: msg.completion_tokens,
      prompt_tokens: msg.prompt_tokens,
      total_tokens: msg.total_tokens,
      tok_per_sec: msg.tok_per_sec,
      ttft_ms: msg.ttft_ms,
      duration_ms: msg.duration_ms,
      finish_reason: msg.finish_reason,
      stop_reason: msg.stop_reason,
      error: msg.error,
      model: msg.model,
    }
    if (t.ttft_ms == null && store._turnStartedAt) {
      t.ttft_ms = Date.now() - store._turnStartedAt
    }
    store._lastGenInfo = cloneTelemetry(t)
    store.freezeTelemetryOnLast?.('assistant')
    return
  }
  if (msg.type === 'tool_delta') {
    const chunk = msg.output || msg.text || ''
    const want = msg.name || ''
    let row = null
    for (let i = store.messages.length - 1; i >= 0; i--) {
      const m = store.messages[i]
      if (m.kind !== 'tool_call') continue
      if (want && m.name && m.name !== want) continue
      row = m
      break
    }
    if (!row) {
      row = {
        id: crypto.randomUUID(),
        kind: 'tool_call',
        name: msg.name || 'tool',
        args: {},
        explanation: '',
        text: '',
        progress: '',
        streaming: true,
        visible: true,
        telemetry: null,
      }
      store.messages.push(row)
    }
    row.progress = chunk
    row.streaming = true
    store.scrollBottom?.()
    return
  }
  if (msg.type === 'approval_needed') {
    const aid = msg.id
    if (store.messages.some((m) => m.kind === 'approval_needed' && m.approvalId === aid)) return
    store.messages.push({
      id: crypto.randomUUID(),
      kind: 'approval_needed',
      approvalId: aid,
      name: msg.name,
      args: msg.args || {},
      command: msg.command || '',
      status: 'pending',
      visible: true,
    })
    store.scrollBottom?.()
    return
  }
  if (msg.type === 'card' && msg.card) {
    const c = msg.card
    if (c.kind === 'tool_call' || c.kind === 'tool_result') {
      for (const m of store.messages) {
        if ((m.kind === 'assistant' || m.kind === 'reasoning') && m.streaming) m.streaming = false
      }
      if (c.kind === 'tool_call') {
        const want = c.name || ''
        for (let i = store.messages.length - 1; i >= 0; i--) {
          const m = store.messages[i]
          if (m.kind !== 'tool_call') continue
          if (want && m.name && m.name !== want) continue
          const emptyArgs = !m.args || !Object.keys(m.args).length
          if (emptyArgs && (m.streaming || m.progress)) {
            m.name = c.name || m.name
            m.args = c.args || {}
            m.explanation = c.explanation || m.explanation || ''
            if (c.eventId) m.eventId = c.eventId
            store.scrollBottom?.()
            return
          }
          break
        }
      }
      if (c.kind === 'tool_result') {
        const want = c.name || ''
        for (let i = store.messages.length - 1; i >= 0; i--) {
          const m = store.messages[i]
          if (m.kind === 'tool_call' && m.streaming && (!want || !m.name || m.name === want)) {
            m.streaming = false
            break
          }
        }
      }
      store.messages.push({
        id: crypto.randomUUID(),
        kind: c.kind,
        name: c.name,
        args: c.args || {},
        explanation: c.explanation || '',
        text: c.text || '',
        progress: c.progress || '',
        ok: c.ok,
        denied: c.denied,
        eventId: c.eventId || null,
        full_chars: c.full_chars != null ? c.full_chars : (c.text ? String(c.text).length : 0),
        truncated: Boolean(c.truncated),
        image: c.image || null,
        visible: true,
        telemetry: cloneTelemetry(c.telemetry || store._lastGenInfo),
      })
      store.scrollBottom?.()
      return
    }
    if (c.kind === 'reasoning') {
      let live = null
      for (let i = store.messages.length - 1; i >= 0; i--) {
        if (store.messages[i].kind === 'reasoning' && store.messages[i].streaming) {
          live = store.messages[i]
          break
        }
      }
      const finalText = c.text != null ? String(c.text) : ''
      if (live) {
        if (finalText) live.text = finalText
        live.streaming = false
        if (c.eventId) live.eventId = c.eventId
      } else if (finalText.trim()) {
        store.messages.push({
          id: crypto.randomUUID(),
          kind: 'reasoning',
          text: finalText,
          streaming: false,
          visible: true,
          eventId: c.eventId || null,
          telemetry: null,
        })
      }
      store.scrollBottom?.()
      return
    }
    if (c.kind === 'assistant') {
      let live = null
      for (let i = store.messages.length - 1; i >= 0; i--) {
        if (store.messages[i].kind === 'assistant' && store.messages[i].streaming) {
          live = store.messages[i]
          break
        }
      }
      let finalText = c.text != null ? String(c.text) : ''
      if (looksLikeProviderDump(finalText)) finalText = ''
      if (live) {
        if (finalText) live.text = finalText
        live.streaming = false
        if (c.eventId) live.eventId = c.eventId
        if (!live.telemetry && (c.telemetry || store._lastGenInfo)) {
          live.telemetry = cloneTelemetry(c.telemetry || store._lastGenInfo)
        }
        if (!(live.text || '').trim()) {
          const idx = store.messages.indexOf(live)
          if (idx >= 0) store.messages.splice(idx, 1)
        }
      } else if (finalText.trim()) {
        store.messages.push({
          id: crypto.randomUUID(),
          kind: 'assistant',
          text: finalText,
          streaming: false,
          visible: true,
          eventId: c.eventId || null,
          telemetry: cloneTelemetry(c.telemetry || store._lastGenInfo),
        })
      }
      store.scrollBottom?.()
    }
    return
  }
  if (msg.type === 'visible') {
    const ids = new Set(
      Array.isArray(msg.eventIds)
        ? msg.eventIds
        : msg.eventId
          ? [msg.eventId]
          : [],
    )
    if (!ids.size) return
    const vis = Boolean(msg.visible)
    for (const m of store.messages) {
      if (m.eventId && ids.has(m.eventId)) m.visible = vis
    }
    return
  }
  if (msg.type === 'error') {
    const err = String(msg.error || 'agent error')
    store.error = err
    store.waiting = false
    store.stopStopwatch?.({ freeze: true })
    const last = store.messages[store.messages.length - 1]
    const text = err.startsWith('Error:') ? err : `Error: ${err}`
    if (!(last && last.kind === 'error' && last.text === text)) {
      store.messages.push({
        id: crypto.randomUUID(),
        kind: 'error',
        text,
        visible: true,
        telemetry: null,
      })
    }
    store.scrollBottom?.()
    return
  }
  if (msg.type === 'done' || msg.type === 'aborted') {
    for (const m of store.messages) {
      if (m.streaming) m.streaming = false
    }
    store.freezeTelemetryOnLast?.('assistant')
    store.waiting = false
    store._runStartedAt = 0
    store.stopStopwatch?.({ freeze: true })
    store.scrollBottom?.()
  }
}

/**
 * @param {object} M m.js module
 * @param {object} [opts]
 * @param {string} [opts.name='chat']
 * @param {object} [opts.transport]
 * @param {string} [opts.idPrefix='desktop']
 * @param {string} [opts.model]
 * @param {boolean} [opts.reconnect=true]
 */
export function createChatStore(M, opts = {}) {
  const name = opts.name || 'chat'
  const idPrefix = opts.idPrefix || 'desktop'
  const transport = opts.transport || wsTransport(opts)
  const onDraftFocus = opts.onDraftFocus

  return M.store(name, {
    desktop: null,
    path: opts.path || '',
    connected: false,
    waiting: false,
    draft: '',
    messages: [],
    error: '',
    model: opts.model || 'llama-server:default',
    models: opts.models || [opts.model || 'llama-server:default'],
    sessionId: null,
    allowlist: '',
    allowlistBaseline: '',
    allowlistOverridden: false,
    allowlistOpen: false,
    allowlistInited: false,
    contextWindow: 32768,
    tokensUsed: 0,
    elapsed: '',
    _ws: null,
    _stick: true,
    _lastGenInfo: null,
    _turnStartedAt: 0,
    _elapsedT0: 0,
    _elapsedTimer: 0,
    _elapsedGen: 0,
    _runStartedAt: 0,
    _allowTimer: 0,
    _reconnect: opts.reconnect !== false,
    idPrefix,

    get draftInput() { return this.draft },
    set draftInput(v) { this.draft = v },
    get allowlistText() { return this.allowlist },
    set allowlistText(v) { this.allowlist = v },
    get activeMessages() { return this.messages },
    get activeWaiting() { return this.waiting },
    get showWelcome() { return !this.messages.length },
    get modelOptions() {
      const list = Array.isArray(this.models) ? [...this.models] : []
      if (this.model && !list.includes(this.model)) list.unshift(this.model)
      return list
    },

    applyNewSession(id) {
      this.sessionId = id || this.sessionId
      this.messages = []
      this.waiting = false
      this.error = ''
      this.tokensUsed = 0
      this._lastGenInfo = null
      this._runStartedAt = 0
      this.stopStopwatch({ freeze: false })
      this.messages.push({
        id: crypto.randomUUID(),
        kind: 'assistant',
        text: 'New session.',
        visible: true,
        telemetry: null,
      })
      this.scrollBottom(true)
    },

    reset() {
      this.close()
      this.messages = []
      this.waiting = false
      this.error = ''
      this.draft = ''
      this.sessionId = null
      this.allowlistOpen = false
      this.allowlistInited = false
      this.allowlistOverridden = false
      this.allowlist = ''
      this.allowlistBaseline = ''
      this.tokensUsed = 0
      this._lastGenInfo = null
      this.stopStopwatch({ freeze: false })
    },

    attach(key) {
      const live = this._ws && (this._ws.readyState === WebSocket.OPEN || this._ws.readyState === WebSocket.CONNECTING)
      if (this.desktop === key && live && this.connected) return
      const keepDraft = this.desktop === key && key ? this.draft : ''
      this.reset()
      this.desktop = key
      this.draft = keepDraft
      if (!key) return
      transport.connect(this)
    },

    close() {
      const ws = this._ws
      this._ws = null
      this.connected = false
      try { ws?.close() } catch { /* ignore */ }
    },

    send() {
      const content = String(this.draft || '').trim()
      if (!content) return
      if (this.connected === false) return
      if (this.waiting) this.stop({ soft: true })
      this.messages.push({
        id: crypto.randomUUID(),
        kind: 'user',
        text: content,
        visible: true,
        telemetry: null,
      })
      this.draft = ''
      const isNew = /^\/new$/i.test(content)
      this.waiting = !isNew
      this._stick = true
      this._turnStartedAt = Date.now()
      this._lastGenInfo = null
      if (!isNew) this.startStopwatch(this._turnStartedAt)
      transport.send(this, {
        type: 'chat',
        content,
        model: this.model,
        allowlist: this.allowlist,
      })
      this.scrollBottom(true)
    },

    startStopwatch(originWallMs) {
      this.stopStopwatch({ freeze: false })
      this._runStartedAt = Number(originWallMs) || Date.now()
      this._elapsedT0 = this._runStartedAt
      this._elapsedGen += 1
      const gen = this._elapsedGen
      this.elapsed = formatElapsed(Date.now() - this._runStartedAt)
      const tick = () => {
        if (gen !== this._elapsedGen) return
        const text = formatElapsed(Date.now() - this._runStartedAt)
        const el = typeof document !== 'undefined' && document.querySelector('.chat-elapsed')
        if (el) {
          el.textContent = text
          el.hidden = false
        }
        this._elapsedTimer = requestAnimationFrame(tick)
      }
      tick()
    },

    stopStopwatch({ freeze = true } = {}) {
      this._elapsedGen += 1
      if (this._elapsedTimer) {
        cancelAnimationFrame(this._elapsedTimer)
        this._elapsedTimer = 0
      }
      if (freeze && this._elapsedT0) {
        this.elapsed = formatElapsed(performance.now() - this._elapsedT0)
      } else if (!freeze) {
        this.elapsed = ''
        this._elapsedT0 = 0
      }
    },

    stop(opts = {}) {
      transport.abort(this)
      for (const m of this.messages) {
        if (m.streaming) m.streaming = false
      }
      if (!opts.soft) {
        this.waiting = false
        this.stopStopwatch({ freeze: true })
      }
    },

    onKeydown(ev) {
      if (ev.key === 'Enter' && !ev.shiftKey) {
        ev.preventDefault()
        this.send()
      }
    },

    onDraftFocus() {
      onDraftFocus?.(this)
    },

    onModelChange(ev) {
      const sel = ev?.target?.value
      if (!sel || sel === this.model) return
      this.model = sel
      if (this.connected) transport.setModel(this, sel)
    },

    toggleAllowlist() {
      this.allowlistOpen = !this.allowlistOpen
    },

    onAllowlistInput(ev) {
      const v = ev?.target && typeof ev.target.value === 'string' ? ev.target.value : null
      if (v != null) this.allowlist = v
      this.allowlistInited = true
      this.allowlistOverridden = (this.allowlist ?? '') !== (this.allowlistBaseline ?? '')
      if (!this.connected) return
      clearTimeout(this._allowTimer)
      this._allowTimer = setTimeout(() => {
        transport.setAllowlist(this, this.allowlist ?? '', this.allowlistOverridden)
      }, 80)
    },

    onAllowlistBlur() {
      this.onAllowlistInput()
      if (!this.connected) return
      transport.setAllowlist(this, this.allowlist ?? '', this.allowlistOverridden)
    },

    get statusLabel() {
      if (!this.connected) return 'connecting…'
      if (this.waiting) return 'running'
      if (this.error) return 'error'
      return 'ready'
    },

    get statusClass() {
      if (!this.connected) return 'wait'
      if (this.waiting) return 'run'
      if (this.error) return 'down'
      return 'live'
    },

    get pieFrac() {
      const max = Number(this.contextWindow) || 0
      if (max <= 0) return 0
      return Math.min(1, Math.max(0, (Number(this.tokensUsed) || 0) / max))
    },

    get pieDash() {
      const c = 2 * Math.PI * 15.5
      const f = this.pieFrac
      return `${(c * f).toFixed(2)} ${(c * (1 - f)).toFixed(2)}`
    },

    get pieUsedK() {
      const used = Number(this.tokensUsed) || 0
      if (!Number.isFinite(used) || used <= 0) return '0'
      return String(Math.round(used / 1000))
    },

    get contextTooltip() {
      const max = Number(this.contextWindow) || 0
      const used = Number(this.tokensUsed) || 0
      const fmt = (n) =>
        n >= 1_000_000
          ? `${(n / 1_000_000).toFixed(n % 1_000_000 === 0 ? 0 : 1)}M`
          : n >= 1000
            ? `${Math.round(n / 1000)}k`
            : String(n)
      if (!max) return `${used} tok · ${this.model || ''}`
      return `${fmt(used)} / ${fmt(max)} tok · ${this.model || ''}`
    },

    freezeTelemetryOnLast(kind) {
      const t = this._lastGenInfo
      if (!t) return
      for (let i = this.messages.length - 1; i >= 0; i--) {
        const m = this.messages[i]
        if (m.kind === kind && !m.telemetry) {
          m.telemetry = cloneTelemetry(t)
          break
        }
      }
    },

    decideApproval(msg, decision) {
      if (!msg) return
      const id = msg.approvalId
      for (const m of this.messages) {
        if (m.kind === 'approval_needed' && m.approvalId === id) m.status = decision
      }
      transport.approve(this, id, decision)
    },

    toggleMsgVisible(msg) {
      if (!msg) return
      const next = msg.visible === false
      for (const m of visibilityGroup(this.messages, msg)) m.visible = next
      if (msg.eventId && this.connected) transport.setVisible?.(this, msg.eventId, next)
    },

    handle(msg) {
      applyIncoming(this, msg)
    },

    toolCallExplanation,
    toolCallCode,
    toolResultImageNote,
    formatToolArgs,
    formatTelemetryHtml,
    renderMarkdown,
    fillSelect,

    elMessages() {
      if (typeof document === 'undefined') return null
      return document.getElementById(`${this.idPrefix}-messages`)
    },

    onBubbleScroll,
    toggleBubbleExpand,
    toggleBubbleCollapse,
    stickBubbleScrolls() {
      const el = this.elMessages()
      if (el) watchBubbleScrollsHelper(el)
      stickBubbleScrollsHelper(el)
    },

    scrollBottom(force) {
      if (!force && !this._stick) return
      const el = this.elMessages()
      if (!el) return
      watchBubbleScrollsHelper(el)
      requestAnimationFrame(() => {
        el.scrollTop = el.scrollHeight
        stickBubbleScrollsHelper(el)
      })
    },

    onMessagesScroll() {
      const el = this.elMessages()
      if (!el) return
      const gap = el.scrollHeight - el.scrollTop - el.clientHeight
      this._stick = gap < 40
    },
  })
}
