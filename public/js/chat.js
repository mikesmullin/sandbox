import M from '/vendor/m.min.js'

const proto = () => (location.protocol === 'https:' ? 'wss:' : 'ws:')

const escHtml = (s) =>
  String(s ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')

export const chat = M.store('chat', {
  desktop: null,
  connected: false,
  waiting: false,
  draft: '',
  messages: [],
  error: '',
  model: 'llama-server:default',
  models: ['llama-server:default'],
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

  applyNewSession(id) {
    this.sessionId = id || this.sessionId
    this.messages = []
    this.waiting = false
    this.error = ''
    this.tokensUsed = 0
    this._lastGenInfo = null
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

  attach(name) {
    if (this.desktop === name && this._ws && this.connected) return
    this.reset()
    this.desktop = name
    if (!name) return
    const url = `${proto()}//${location.host}/desktops/${encodeURIComponent(name)}/agent`
    const ws = new WebSocket(url)
    this._ws = ws
    ws.addEventListener('open', () => {
      if (this._ws !== ws) return
      this.connected = true
      this.error = ''
    })
    ws.addEventListener('message', (ev) => {
      if (this._ws !== ws) return
      let msg
      try { msg = JSON.parse(ev.data) } catch { return }
      this.handle(msg)
    })
    ws.addEventListener('close', () => {
      if (this._ws !== ws) return
      this.connected = false
      this.waiting = false
    })
    ws.addEventListener('error', () => {
      if (this._ws !== ws) return
      this.error = 'agent socket error'
    })
  },

  close() {
    const ws = this._ws
    this._ws = null
    this.connected = false
    try { ws?.close() } catch {}
  },

  send() {
    const content = String(this.draft || '').trim()
    if (!content || !this.connected) return
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
    if (!isNew) this.startStopwatch()
    this._ws.send(JSON.stringify({
      type: 'chat',
      content,
      model: this.model,
      allowlist: this.allowlist,
    }))
    this.scrollBottom(true)
  },

  formatElapsed(ms) {
    return `${(Math.max(0, ms) / 1000).toFixed(3)}s`
  },

  startStopwatch() {
    this.stopStopwatch({ freeze: false })
    this._elapsedT0 = performance.now()
    this._elapsedGen += 1
    const gen = this._elapsedGen
    this.elapsed = '0.000s'
    const tick = () => {
      if (gen !== this._elapsedGen) return
      const text = this.formatElapsed(performance.now() - this._elapsedT0)
      const el = document.querySelector('.chat-elapsed')
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
      this.elapsed = this.formatElapsed(performance.now() - this._elapsedT0)
      const el = document.querySelector('.chat-elapsed')
      if (el) el.textContent = this.elapsed
    } else if (!freeze) {
      this.elapsed = ''
      this._elapsedT0 = 0
    }
  },

  stop(opts = {}) {
    if (!this.connected) return
    try { this._ws.send(JSON.stringify({ type: 'abort' })) } catch {}
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

  get modelOptions() {
    const list = Array.isArray(this.models) ? [...this.models] : []
    if (this.model && !list.includes(this.model)) list.unshift(this.model)
    return list
  },

  onModelChange(ev) {
    const sel = ev?.target?.value
    if (!sel || sel === this.model) return
    this.model = sel
    if (this.connected) this._ws.send(JSON.stringify({ type: 'model', model: sel }))
  },

  get allowlistText() { return this.allowlist },
  set allowlistText(v) { this.allowlist = v },

  fillAllowlistTa() {
    const el = typeof document !== 'undefined' && document.getElementById('desktop-allowlist')
    if (!el) return
    if (document.activeElement === el) return
    if (el.value !== (this.allowlist ?? '')) el.value = this.allowlist ?? ''
  },

  toggleAllowlist() {
    this.allowlistOpen = !this.allowlistOpen
    if (this.allowlistOpen) queueMicrotask(() => this.fillAllowlistTa())
  },

  onAllowlistInput(ev) {
    const v = ev?.target && typeof ev.target.value === 'string' ? ev.target.value : null
    if (v != null) this.allowlist = v
    this.allowlistInited = true
    this.allowlistOverridden = (this.allowlist ?? '') !== (this.allowlistBaseline ?? '')
  },

  onAllowlistBlur() {
    this.onAllowlistInput()
    if (!this.connected) return
    this._ws.send(JSON.stringify({
      type: 'allowlist',
      text: this.allowlist ?? '',
      overridden: Boolean(this.allowlistOverridden),
    }))
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

  cloneTelemetry(t) {
    if (!t || typeof t !== 'object') return null
    return { ...t }
  },

  _metricChip(icon, text) {
    return (
      `<span class="metric-chip">` +
      `<i class="ph ${icon}" aria-hidden="true"></i>` +
      `<span>${escHtml(text)}</span>` +
      `</span>`
    )
  },

  formatTelemetryHtml(t, msg) {
    const chips = []
    if (t && typeof t === 'object') {
      if (t.tok_per_sec != null && Number.isFinite(Number(t.tok_per_sec))) {
        chips.push(this._metricChip('ph-gauge', `${Number(t.tok_per_sec).toFixed(2)} tps`))
      }
      if (t.completion_tokens != null && Number(t.completion_tokens) > 0) {
        chips.push(this._metricChip('ph-text-aa', `${t.completion_tokens} tok`))
      }
      if (t.ttft_ms != null && Number.isFinite(Number(t.ttft_ms))) {
        chips.push(this._metricChip('ph-timer', `${(Number(t.ttft_ms) / 1000).toFixed(2)}s ttft`))
      } else if (t.duration_ms != null && Number(t.duration_ms) > 0 && t.completion_tokens) {
        chips.push(this._metricChip('ph-timer', `${(Number(t.duration_ms) / 1000).toFixed(2)}s`))
      }
      const reason = t.finish_reason || t.stop_reason || (t.error ? 'error' : null)
      if (reason) chips.push(this._metricChip('ph-flag-banner', `finish: ${reason}`))
      if (t.error) chips.push(this._metricChip('ph-warning', String(t.error).slice(0, 40)))
    }
    if (msg?.kind === 'tool_result' && msg.full_chars) {
      chips.push(this._metricChip(
        'ph-cloud-arrow-down',
        `${Number(msg.full_chars).toLocaleString()} B${msg.truncated ? ' (trunc)' : ''}`,
      ))
    }
    return chips.length ? chips.join('') : ''
  },

  freezeTelemetryOnLast(kind) {
    const t = this._lastGenInfo
    if (!t) return
    for (let i = this.messages.length - 1; i >= 0; i--) {
      const m = this.messages[i]
      if (m.kind === kind && !m.telemetry) {
        m.telemetry = this.cloneTelemetry(t)
        break
      }
    }
  },

  decideApproval(msg, decision) {
    if (!msg || !this.connected) return
    const id = msg.approvalId
    for (const m of this.messages) {
      if (m.kind === 'approval_needed' && m.approvalId === id) m.status = decision
    }
    this._ws.send(JSON.stringify({ type: 'approval', id, decision }))
  },

  handle(msg) {
    if (msg.type === 'session' && msg.command === 'new') {
      this.applyNewSession(msg.sessionId)
      return
    }
    if (msg.type === 'hello') {
      this.model = msg.model || this.model
      if (Array.isArray(msg.models) && msg.models.length) this.models = msg.models
      this.sessionId = msg.sessionId || this.sessionId
      // Seed once. Later hellos (model catalog, model switch) must not
      // clobber a textarea the user is mid-edit.
      if (msg.allowlist != null && !this.allowlistInited && !this.allowlistOverridden) {
        this.allowlist = String(msg.allowlist)
        this.allowlistBaseline = String(msg.allowlist)
        this.allowlistInited = true
        queueMicrotask(() => this.fillAllowlistTa())
      }
      if (msg.contextWindow) this.contextWindow = Number(msg.contextWindow) || this.contextWindow
      return
    }
    if (msg.type === 'models' && Array.isArray(msg.models) && msg.models.length) {
      this.models = msg.models
      return
    }
    if (msg.type === 'allowlist') return
    if (msg.type === 'assistant_delta') {
      const chunk = msg.text || ''
      if (!chunk) return
      let row = null
      for (let i = this.messages.length - 1; i >= 0; i--) {
        if (this.messages[i].kind === 'assistant' && this.messages[i].streaming) {
          row = this.messages[i]
          break
        }
      }
      if (!row) {
        row = { id: crypto.randomUUID(), kind: 'assistant', text: '', streaming: true, visible: true, telemetry: null }
        this.messages.push(row)
      }
      row.text = (row.text || '') + chunk
      this.scrollBottom()
      return
    }
    if (msg.type === 'reasoning_delta') {
      const chunk = msg.text || ''
      if (!chunk) return
      let row = null
      for (let i = this.messages.length - 1; i >= 0; i--) {
        if (this.messages[i].kind === 'reasoning' && this.messages[i].streaming) {
          row = this.messages[i]
          break
        }
      }
      if (!row) {
        row = { id: crypto.randomUUID(), kind: 'reasoning', text: '', streaming: true, visible: true, telemetry: null }
        this.messages.push(row)
      }
      row.text = (row.text || '') + chunk
      this.scrollBottom()
      return
    }
    if (msg.type === 'usage' || msg.type === 'gen_info') {
      if (msg.prompt_tokens != null && msg.prompt_tokens !== '') {
        const prompt = Number(msg.prompt_tokens)
        if (Number.isFinite(prompt) && prompt >= 0) this.tokensUsed = prompt
      }
      if (msg.contextWindow) this.contextWindow = Number(msg.contextWindow) || this.contextWindow
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
      if (t.ttft_ms == null && this._turnStartedAt) {
        t.ttft_ms = Date.now() - this._turnStartedAt
      }
      this._lastGenInfo = this.cloneTelemetry(t)
      this.freezeTelemetryOnLast('assistant')
      this.freezeTelemetryOnLast('reasoning')
      return
    }
    if (msg.type === 'approval_needed') {
      const aid = msg.id
      if (this.messages.some((m) => m.kind === 'approval_needed' && m.approvalId === aid)) return
      this.messages.push({
        id: crypto.randomUUID(),
        kind: 'approval_needed',
        approvalId: aid,
        name: msg.name,
        args: msg.args || {},
        command: msg.command || '',
        status: 'pending',
        visible: true,
      })
      this.scrollBottom()
      return
    }
    if (msg.type === 'card' && msg.card) {
      const c = msg.card
      if (c.kind === 'tool_call' || c.kind === 'tool_result') {
        for (const m of this.messages) {
          if ((m.kind === 'assistant' || m.kind === 'reasoning') && m.streaming) m.streaming = false
        }
        this.messages.push({
          id: crypto.randomUUID(),
          kind: c.kind,
          name: c.name,
          args: c.args || {},
          explanation: c.explanation || '',
          text: c.text || '',
          ok: c.ok,
          full_chars: c.text ? String(c.text).length : 0,
          visible: true,
          telemetry: null,
        })
        this.scrollBottom()
        return
      }
      if (c.kind === 'assistant') {
        let live = null
        for (let i = this.messages.length - 1; i >= 0; i--) {
          if (this.messages[i].kind === 'assistant' && this.messages[i].streaming) {
            live = this.messages[i]
            break
          }
        }
        const finalText = c.text != null ? String(c.text) : ''
        if (live) {
          if (finalText) live.text = finalText
          live.streaming = false
          if (!live.telemetry && this._lastGenInfo) live.telemetry = this.cloneTelemetry(this._lastGenInfo)
          if (!(live.text || '').trim()) {
            const idx = this.messages.indexOf(live)
            if (idx >= 0) this.messages.splice(idx, 1)
          }
        } else if (finalText.trim()) {
          this.messages.push({
            id: crypto.randomUUID(),
            kind: 'assistant',
            text: finalText,
            streaming: false,
            visible: true,
            telemetry: this.cloneTelemetry(this._lastGenInfo),
          })
        }
        this.scrollBottom()
      }
      return
    }
    if (msg.type === 'error') {
      this.error = msg.error || 'agent error'
      this.waiting = false
      this.stopStopwatch({ freeze: true })
      this.messages.push({
        id: crypto.randomUUID(),
        kind: 'assistant',
        text: `Error: ${this.error}`,
        visible: true,
        telemetry: null,
      })
      return
    }
    if (msg.type === 'done' || msg.type === 'aborted') {
      for (const m of this.messages) {
        if (m.streaming) m.streaming = false
      }
      this.freezeTelemetryOnLast('assistant')
      this.freezeTelemetryOnLast('reasoning')
      this.waiting = false
      this.stopStopwatch({ freeze: true })
      this.scrollBottom()
    }
  },

  toolCallExplanation(msg) {
    if (!msg) return ''
    if (msg.explanation && String(msg.explanation).trim()) return String(msg.explanation).trim()
    const a = msg.args
    if (a?.explanation && String(a.explanation).trim()) return String(a.explanation).trim()
    return ''
  },

  toolCallCode(msg) {
    if (!msg) return ''
    const a = msg.args && typeof msg.args === 'object' ? { ...msg.args } : {}
    delete a.explanation
    if (a.script != null && String(a.script).trim()) return String(a.script)
    if (a.command != null && String(a.command).trim()) {
      const argv = Array.isArray(a.args) ? a.args.map(String) : []
      return [String(a.command).trim(), ...argv].join(' ')
    }
    const keys = Object.keys(a).filter((k) => a[k] != null && a[k] !== '')
    if (!keys.length) return ''
    try { return JSON.stringify(a, null, 2) } catch { return String(a) }
  },

  formatToolArgs(args) {
    if (!args || typeof args !== 'object') return ''
    try { return JSON.stringify(args) } catch { return String(args) }
  },

  renderMarkdown(text) {
    const s = String(text ?? '')
    const esc = escHtml(s)
    return esc
      .replace(/`([^`]+)`/g, '<code>$1</code>')
      .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
      .replace(/\n/g, '<br>')
  },

  scrollBottom(force) {
    if (!force && !this._stick) return
    const el = document.getElementById('desktop-messages')
    if (!el) return
    requestAnimationFrame(() => { el.scrollTop = el.scrollHeight })
  },

  onMessagesScroll() {
    const el = document.getElementById('desktop-messages')
    if (!el) return
    const gap = el.scrollHeight - el.scrollTop - el.clientHeight
    this._stick = gap < 40
  },
})
