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

const DEFAULT_MODEL = 'llama-server:default'
const DEFAULT_MODEL_KEY = 'mjs-chat.model'

const readSavedModel = (key) => {
  if (!key) return ''
  try {
    const v = String(localStorage.getItem(key) || '').trim()
    return v
  } catch {
    return ''
  }
}

const writeSavedModel = (key, model) => {
  if (!key) return
  const v = String(model || '').trim()
  if (!v) return
  try {
    localStorage.setItem(key, v)
  } catch {
    /* ignore quota / private mode */
  }
}

const isUserPrompt = (m) =>
  m && m.kind === 'user' && !/^\/new$/i.test(String(m.text || '').trim())

const TRANSCRIPT_TYPES = new Set([
  'user',
  'assistant_delta',
  'reasoning_delta',
  'tool_delta',
  'card',
  'context_event',
  'approval_needed',
  'state',
  'done',
  'aborted',
  'status',
  'usage',
  'gen_info',
])

const isStaleSession = (store, msg) => {
  const sid = msg?.sessionId
  if (!sid || !store.sessionId) return false
  return String(sid) !== String(store.sessionId)
}

const TODO_WRITE = /(^|__)(todo_write|write_todos)$/i
const TODO_STATUSES = new Set(['pending', 'in_progress', 'completed'])

const todoStatus = (raw) => {
  let s = String(raw || 'pending').toLowerCase().replace(/[\s-]+/g, '_')
  if (s === 'todo') s = 'pending'
  if (s === 'inprogress') s = 'in_progress'
  if (s === 'done' || s === 'complete') s = 'completed'
  return TODO_STATUSES.has(s) ? s : 'pending'
}

const normalizeTodo = (raw, i) => {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null
  const content = String(raw.content || raw.description || raw.step || raw.subject || raw.title || '').trim()
  let id = String(raw.id || raw.taskId || raw.task_id || '').trim()
  if (!id) id = `item-${i + 1}`
  if (!content && !String(raw.id || '').trim()) return null
  const out = { id, content: content || id, status: todoStatus(raw.status) }
  const form = String(raw.activeForm || raw.active_form || '').trim()
  if (form) out.activeForm = form
  return out
}

const todoListFromArgs = (args) => {
  if (!args || typeof args !== 'object') return null
  if (Array.isArray(args.todos)) return args.todos
  if (Array.isArray(args.plan)) return args.plan
  if (Array.isArray(args.task_list)) return args.task_list
  return null
}

const todoContentKey = (s) => String(s || '').toLowerCase().replace(/\s+/g, ' ').trim()

const findTodoMatch = (items, incoming) => {
  if (incoming.id) {
    const byId = items.find((t) => t.id === incoming.id)
    if (byId) return byId
  }
  const c = todoContentKey(incoming.content)
  if (!c) return null
  const exact = items.find((t) => todoContentKey(t.content) === c)
  if (exact) return exact
  if (c.length < 32) return null
  const needle = c.slice(0, 48)
  return items.find((t) => {
    const e = todoContentKey(t.content)
    return e.startsWith(needle) || c.startsWith(e.slice(0, 48))
  }) || null
}

const applyTodoWrite = (store, args) => {
  const list = todoListFromArgs(args)
  if (!Array.isArray(list)) return
  const items = list.map((t, i) => normalizeTodo(t, i)).filter(Boolean)
  const cur = Array.isArray(store.todos) ? store.todos.map((t) => ({ ...t })) : []
  if (args?.merge && cur.length) {
    for (const t of items) {
      const prev = findTodoMatch(cur, t)
      if (prev) {
        const oldId = prev.id
        if (t.content) prev.content = t.content
        if (t.status) prev.status = t.status
        if (t.activeForm != null) prev.activeForm = t.activeForm
        if (t.id && t.id !== oldId) prev.id = t.id
      } else {
        cur.push(t)
      }
    }
    store.todos = cur
  } else {
    store.todos = items
  }
}

const hydrateTodosFromMessages = (store, messages) => {
  const tmp = { todos: [] }
  for (const m of messages || []) {
    if (m && m.kind === 'tool_call' && TODO_WRITE.test(String(m.name || ''))) {
      applyTodoWrite(tmp, m.args || {})
    }
  }
  store.todos = tmp.todos || []
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
    store._awaitingNewSession = false
    store.applyNewSession?.(msg.sessionId)
    return
  }
  if (store._awaitingNewSession && (TRANSCRIPT_TYPES.has(msg.type) || msg.type === 'hello')) {
    return
  }
  if (isStaleSession(store, msg) && (TRANSCRIPT_TYPES.has(msg.type) || msg.type === 'hello')) {
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
    if (Array.isArray(msg.messages) && msg.messages.some((m) => m && m.kind === 'tool_call' && TODO_WRITE.test(String(m.name || '')))) {
      hydrateTodosFromMessages(store, msg.messages)
    } else if (Array.isArray(msg.todos)) {
      store.todos = msg.todos
    }
    if (msg.tokensUsed != null && msg.tokensUsed !== '') {
      const n = Number(msg.tokensUsed)
      if (Number.isFinite(n) && n >= 0) store.tokensUsed = n
    }
    store.error = msg.error || ''
    let keepLocal = false
    if (Array.isArray(msg.messages)) {
      const incoming = msg.messages.map((m) => (m && typeof m === 'object' ? { ...m } : m))
      // Empty post-/new snapshot: keep only a prompt typed after /new, not the
      // previous session's transcript.
      const keepAfterNew = Boolean(store._keepAfterNew)
      const localUser = (store.messages || []).some(isUserPrompt)
      if (incoming.length === 0 && keepAfterNew && localUser) {
        keepLocal = true
      } else {
        store.messages = incoming
        store._keepAfterNew = false
      }
    }
    const running = Boolean(msg.waiting || msg.phase === 'running')
    if (!keepLocal) {
      store.waiting = running
      if (running && msg.runStartedAt) {
        store.startStopwatch?.(msg.runStartedAt)
      } else if (!running) {
        store.stopStopwatch?.({ freeze: false })
        store._runStartedAt = 0
      }
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
    if (Array.isArray(msg.todos)) store.todos = msg.todos
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
  if (msg.type === 'context_event') {
    if (msg.role === 'user') {
      const text = String(msg.content || '')
      let row = null
      for (let i = store.messages.length - 1; i >= 0; i--) {
        if (store.messages[i].kind === 'user' && !store.messages[i].eventId) {
          row = store.messages[i]
          break
        }
      }
      if (row) {
        if (msg.event_id) row.eventId = msg.event_id
        row.visible = msg.visible !== false
      } else if (text) {
        const last = store.messages[store.messages.length - 1]
        if (!(last && last.kind === 'user' && last.text === text)) {
          store.messages.push({
            id: msg.event_id || crypto.randomUUID(),
            kind: 'user',
            text,
            visible: msg.visible !== false,
            eventId: msg.event_id || null,
            telemetry: null,
          })
          store.scrollBottom?.()
        }
      }
      return
    }
    if (msg.role === 'assistant') {
      for (let i = store.messages.length - 1; i >= 0; i--) {
        if (store.messages[i].kind === 'assistant') {
          if (!store.messages[i].eventId && msg.event_id) {
            store.messages[i].eventId = msg.event_id
          }
          store.messages[i].visible = msg.visible !== false
          break
        }
      }
      return
    }
    return
  }
  if (msg.type === 'todos') {
    if (Array.isArray(msg.todos)) store.todos = msg.todos
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
    if (c.kind === 'tool_call' && TODO_WRITE.test(String(c.name || ''))) {
      applyTodoWrite(store, c.args || {})
    }
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
 * @param {boolean} [opts.persistModel=true]
 * @param {string} [opts.modelKey='mjs-chat.model']
 * @param {boolean} [opts.reconnect=true]
 */
export function createChatStore(M, opts = {}) {
  const name = opts.name || 'chat'
  const idPrefix = opts.idPrefix || 'desktop'
  const transport = opts.transport || wsTransport(opts)
  const onDraftFocus = opts.onDraftFocus
  const persistModel = opts.persistModel !== false
  const modelKey = persistModel ? (opts.modelKey || DEFAULT_MODEL_KEY) : ''
  const fallbackModel = opts.model || DEFAULT_MODEL
  const initialModel = readSavedModel(modelKey) || fallbackModel

  return M.store(name, {
    desktop: null,
    path: opts.path || '',
    connected: false,
    waiting: false,
    draft: '',
    messages: [],
    error: '',
    model: initialModel,
    models: opts.models || [initialModel],
    sessionId: null,
    allowlist: '',
    allowlistBaseline: '',
    allowlistOverridden: false,
    allowlistOpen: false,
    allowlistInited: false,
    todos: [],
    todosOpen: false,
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
    _keepAfterNew: false,
    _awaitingNewSession: false,
    _reconnect: opts.reconnect !== false,
    idPrefix,

    get draftInput() { return this.draft },
    set draftInput(v) { this.draft = v },
    get allowlistText() { return this.allowlist },
    set allowlistText(v) { this.allowlist = v },
    get activeMessages() {
      return (this.messages || []).filter((m) => {
        if (m.kind !== 'tool_call' && m.kind !== 'tool_result') return true
        return !TODO_WRITE.test(String(m.name || '')) && !/(^|__)todo_read$/.test(String(m.name || ''))
      })
    },
    get activeWaiting() { return this.waiting },
    get showWelcome() { return !this.messages.length },
    get modelOptions() {
      const list = Array.isArray(this.models) ? [...this.models] : []
      if (this.model && !list.includes(this.model)) list.unshift(this.model)
      return list
    },

    applyNewSession(id) {
      this._awaitingNewSession = false
      this.sessionId = id || this.sessionId
      const msgs = this.messages || []
      let lastNew = -1
      for (let i = 0; i < msgs.length; i++) {
        if (msgs[i].kind === 'user' && /^\/new$/i.test(String(msgs[i].text || '').trim())) {
          lastNew = i
        }
      }
      const keep = lastNew >= 0 ? msgs.slice(lastNew + 1).filter(isUserPrompt) : []
      this.messages = []
      this._keepAfterNew = keep.length > 0
      this.waiting = keep.length > 0
      this.error = ''
      this.tokensUsed = 0
      this.todos = []
      this.todosOpen = false
      this._lastGenInfo = null
      this._runStartedAt = 0
      this.stopStopwatch({ freeze: keep.length > 0 })
      this.messages.push({
        id: crypto.randomUUID(),
        kind: 'assistant',
        text: 'New session.',
        visible: true,
        telemetry: null,
      })
      for (const m of keep) this.messages.push({ ...m })
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
      this.todos = []
      this.todosOpen = false
      this.tokensUsed = 0
      this._lastGenInfo = null
      this._keepAfterNew = false
      this._awaitingNewSession = false
      this.stopStopwatch({ freeze: false })
      const preferred = readSavedModel(modelKey)
      if (preferred) this.model = preferred
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
      if (isNew) {
        const row = this.messages[this.messages.length - 1]
        this.messages = row ? [row] : []
        this._keepAfterNew = false
        this._awaitingNewSession = true
      }
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
      const sel = String(ev?.target?.value || '').trim()
      if (!sel || sel === this.model) return
      this.model = sel
      writeSavedModel(modelKey, sel)
      if (this.connected) transport.setModel(this, sel)
    },

    applyPreferredModel(msg) {
      if (!modelKey || !msg || msg.type !== 'state') return
      const preferred = readSavedModel(modelKey)
      if (!preferred) return
      if (this.waiting) return
      const incoming = Array.isArray(msg.messages) ? msg.messages : []
      if (incoming.some(isUserPrompt)) return
      if ((this.messages || []).some(isUserPrompt)) return
      this.model = preferred
      if (this.connected && preferred !== (msg.model || '')) {
        transport.setModel(this, preferred)
      }
    },

    toggleAllowlist() {
      this.allowlistOpen = !this.allowlistOpen
    },

    toggleTodos() {
      this.todosOpen = !this.todosOpen
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
      this.applyPreferredModel?.(msg)
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
