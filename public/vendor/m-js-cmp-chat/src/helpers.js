/**
 * Pure helpers shared by the chat widgets and optional store.
 * Apps may import these; the components also bind them onto the instance
 * so a host store does not have to reimplement markdown / telemetry / tool cards.
 */

export const escHtml = (s) =>
  String(s ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')

export const formatToolArgs = (args) => {
  if (!args || typeof args !== 'object') return ''
  try {
    return JSON.stringify(args)
  } catch {
    return String(args)
  }
}

/** Explanation for a tool_call bubble (top-level or args.explanation). */
export const toolCallExplanation = (msg) => {
  if (!msg) return ''
  if (msg.explanation != null && String(msg.explanation).trim()) {
    return String(msg.explanation).trim()
  }
  const a = msg.args
  if (a?.explanation != null && String(a.explanation).trim()) {
    return String(a.explanation).trim()
  }
  return ''
}

/**
 * Primary command body for a tool_call code block:
 * bash → script; exec → command + args; else remaining args as pretty JSON.
 */
export const toolCallCode = (msg) => {
  if (!msg) return ''
  const a = msg.args && typeof msg.args === 'object' ? { ...msg.args } : {}
  delete a.explanation
  if (a.script != null && String(a.script).trim()) return String(a.script)
  if (a.command != null && String(a.command).trim()) {
    const argv = Array.isArray(a.args) ? a.args.map(String) : []
    return [String(a.command).trim(), ...argv].join(' ')
  }
  const keys = Object.keys(a).filter(
    (k) => a[k] != null && a[k] !== '' && !(Array.isArray(a[k]) && !a[k].length),
  )
  if (!keys.length) return ''
  if (keys.length === 1 && typeof a[keys[0]] === 'string') return String(a[keys[0]])
  try {
    return JSON.stringify(a, null, 2)
  } catch {
    return String(a)
  }
}

/**
 * Assistant markdown → HTML.
 * Uses global `marked` + `DOMPurify` when the host page loaded them;
 * otherwise a tiny escape + `**bold**` / `` `code` `` / newlines fallback.
 */
export const renderMarkdown = (text, opts = {}) => {
  const raw = String(text ?? '')
  if (!raw) return ''
  if (typeof opts.render === 'function') return opts.render(raw)
  let html = raw
  try {
    const marked = opts.marked ?? globalThis.marked
    if (marked) {
      if (typeof marked.parse === 'function') {
        marked.setOptions?.({ gfm: true, breaks: true, headerIds: false, mangle: false })
        html = marked.parse(raw)
      } else if (typeof marked === 'function') {
        html = marked(raw)
      }
    } else {
      html = escHtml(raw)
        .replace(/`([^`]+)`/g, '<code>$1</code>')
        .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
        .replace(/\n/g, '<br>')
    }
  } catch {
    html = escHtml(raw).replace(/\n/g, '<br>')
  }
  try {
    const DOMPurify = opts.DOMPurify ?? globalThis.DOMPurify
    if (DOMPurify?.sanitize) {
      return DOMPurify.sanitize(html, { USE_PROFILES: { html: true } })
    }
  } catch {
    /* keep html */
  }
  return html
}

const metricChip = (icon, text) =>
  `<span class="metric-chip">` +
  `<i class="ph ${icon}" aria-hidden="true"></i>` +
  `<span>${escHtml(text)}</span>` +
  `</span>`

/** HTML metrics row with Phosphor icons (message gutter). */
export const formatTelemetryHtml = (t, msg) => {
  const chips = []
  if (t && typeof t === 'object') {
    if (t.tok_per_sec != null && Number.isFinite(Number(t.tok_per_sec))) {
      chips.push(metricChip('ph-gauge', `${Number(t.tok_per_sec).toFixed(2)} tps`))
    }
    if (t.completion_tokens != null && Number(t.completion_tokens) > 0) {
      chips.push(metricChip('ph-text-aa', `${t.completion_tokens} tok`))
    }
    if (t.ttft_ms != null && Number.isFinite(Number(t.ttft_ms))) {
      chips.push(metricChip('ph-timer', `${(Number(t.ttft_ms) / 1000).toFixed(2)}s ttft`))
    } else if (t.duration_ms != null && Number(t.duration_ms) > 0 && t.completion_tokens) {
      chips.push(metricChip('ph-timer', `${(Number(t.duration_ms) / 1000).toFixed(2)}s`))
    }
    const reason = t.finish_reason || t.stop_reason || (t.error ? 'error' : null)
    if (reason) chips.push(metricChip('ph-flag-banner', `finish: ${reason}`))
    if (t.error) chips.push(metricChip('ph-warning', String(t.error).slice(0, 40)))
  }
  if (msg?.kind === 'tool_result' && msg.full_chars) {
    chips.push(
      metricChip(
        'ph-cloud-arrow-down',
        `${Number(msg.full_chars).toLocaleString()} B${msg.truncated ? ' (trunc)' : ''}`,
      ),
    )
  }
  return chips.length ? chips.join('') : ''
}

export const shortModel = (m) => {
  if (!m) return ''
  const s = String(m)
  if (s.length <= 28) return s
  return s.slice(0, 12) + '…' + s.slice(-12)
}

export const formatElapsed = (ms) => `${(Math.max(0, ms) / 1000).toFixed(3)}s`

/** Native <select> filler — x-for inside <select> is unreliable. */
export const fillSelect = (el, items, selected, labelFn) => {
  if (!el) return
  const cur = selected == null ? '' : String(selected)
  const next = Array.isArray(items) ? items : []
  const sig = next.map((item) => {
    const value = typeof item === 'string' ? item : item.value
    const label =
      labelFn?.(item) ?? (typeof item === 'string' ? item : item.label || item.value)
    return `${value}\0${label}`
  }).join('\n') + `\n=${cur}`
  if (el.dataset.mjsChatSig === sig) return
  el.dataset.mjsChatSig = sig
  el.innerHTML = ''
  if (!next.length) {
    const o = document.createElement('option')
    o.value = ''
    o.textContent = '(none)'
    el.appendChild(o)
    return
  }
  for (const item of next) {
    const value = typeof item === 'string' ? item : item.value
    const label =
      labelFn?.(item) ?? (typeof item === 'string' ? item : item.label || item.value)
    const o = document.createElement('option')
    o.value = value
    o.textContent = label
    if (value === cur) o.selected = true
    el.appendChild(o)
  }
}

export const coerceFlag = (v, fallback) => {
  if (v === false || v === 'false' || v === 0 || v === '0') return false
  if (v === true || v === 'true' || v === '') return true
  if (v == null) return fallback
  return Boolean(v)
}
