/**
 * Register m.js v3 chat widgets.
 *
 *   import M from '/vendor/m.min.js'
 *   import { registerChat } from '/vendor/m-js-cmp-chat/src/index.js'
 *   registerChat(M)
 *
 * Then anywhere:
 *   <div x-component="mjs-chat" mode="sidebar" store="chat"></div>
 *   <div x-component="mjs-chat" mode="fullscreen" store="cowork"></div>
 *
 * The widgets read a named M.store. See README for the store contract.
 */

import {
  coerceFlag,
  fillSelect,
  formatTelemetryHtml,
  formatToolArgs,
  renderMarkdown as renderMarkdownHelper,
  shortModel as shortModelHelper,
  toolCallCode as toolCallCodeHelper,
  toolCallExplanation as toolCallExplanationHelper,
  toolResultImageNote as toolResultImageNoteHelper,
  onBubbleScroll as onBubbleScrollHelper,
  toggleBubbleExpand as toggleBubbleExpandHelper,
  toggleBubbleCollapse as toggleBubbleCollapseHelper,
  stickBubbleScrolls as stickBubbleScrollsHelper,
  watchBubbleScrolls as watchBubbleScrollsHelper,
} from './helpers.js'
import { chatTpl } from './templates.js'

// HTML parsers lowercase/kebab attribute names. Declare the kebab form
// Alpine uses (`id-prefix`, `:show-tabs`) so collectComponentProps hits.
const PROPS = [
  'mode',
  'store',
  'id-prefix',
  'title',
  'welcome-lead',
  'show-tabs',
  'show-history',
  'show-agent',
  'show-model',
  'show-allowlist',
  'show-pie',
  'show-goto',
  'show-visibility',
  'show-starters',
  'show-always',
  'show-denied',
  'show-status',
]

const camelToKebab = (key) => key.replace(/[A-Z]/g, (m) => `-${m.toLowerCase()}`)

const pick = (s, names, fallback) => {
  if (!s) return fallback
  for (const n of names) {
    if (s[n] !== undefined) return s[n]
  }
  return fallback
}

export function registerChat(M, opts = {}) {
  if (!M?.component) throw new Error('registerChat(M): pass the m.js module')
  const defaultStore = opts.store || 'chat'
  const mdOpts = { render: opts.renderMarkdown, marked: opts.marked, DOMPurify: opts.DOMPurify }

  M.component('mjs-chat', {
    props: PROPS,
    mode: 'sidebar',
    store: defaultStore,
    'id-prefix': '',
    title: '',
    'welcome-lead': '',
    'show-tabs': null,
    'show-history': null,
    'show-agent': null,
    'show-model': null,
    'show-allowlist': null,
    'show-pie': null,
    'show-goto': null,
    'show-visibility': null,
    'show-starters': null,
    'show-always': null,
    'show-denied': null,
    'show-status': null,

    get s() {
      const name = this.store || defaultStore
      try {
        return M.store(name)
      } catch {
        return null
      }
    },

    get isSidebar() {
      return String(this.mode || 'sidebar') !== 'fullscreen'
    },
    get isFullscreenMode() {
      return !this.isSidebar
    },
    get isFullscreen() {
      return Boolean(this.s?.isFullscreen)
    },

    /** Feature flags: host props override per-mode defaults. */
    want(key) {
      const fs = !this.isSidebar
      const defaults = {
        showTabs: true,
        showHistory: fs,
        showAgent: fs,
        showModel: true,
        showAllowlist: true,
        showPie: true,
        showGoto: fs,
        showVisibility: fs,
        showStarters: fs,
        showAlways: true,
        showDenied: true,
        showStatus: false,
      }
      const kebab = camelToKebab(key)
      const v = this[kebab] ?? this[key]
      return coerceFlag(v, defaults[key])
    },

    get welcomeTitle() {
      return this.title || pick(this.s, ['welcomeTitle', 'title'], this.isSidebar ? 'Session' : 'Chat')
    },
    get welcomeLead() {
      return this['welcome-lead'] || ''
    },

    get ids() {
      const p =
        this['id-prefix'] ||
        (this.isSidebar ? 'mjs-chat-side' : 'mjs-chat')
      return {
        messages: `${p}-messages`,
        draft: `${p}-draft`,
        allowlist: `${p}-allowlist`,
        model: `${p}-model`,
        agent: `${p}-agent`,
      }
    },

    get rootClass() {
      const bits = [this.isSidebar ? 'mode-sidebar' : 'mode-fullscreen']
      if (this.isSidebar) bits.push('sheet-chat')
      return bits.join(' ')
    },

    get messages() {
      return pick(this.s, ['activeMessages', 'messages'], []) || []
    },
    get waiting() {
      return Boolean(pick(this.s, ['activeWaiting', 'waiting'], false))
    },
    get connected() {
      const s = this.s
      if (!s || s.connected === undefined) return true
      return Boolean(s.connected)
    },
    get error() {
      return this.s?.error || ''
    },
    get showWelcome() {
      if (this.s && 'showWelcome' in this.s) return Boolean(this.s.showWelcome)
      return !this.messages.length
    },
    get welcomeStarters() {
      return this.s?.welcomeStarters || []
    },
    get tabList() {
      return this.s?.tabList || this.s?.tabs || []
    },
    get activeTabId() {
      return this.s?.activeTabId
    },
    get historyOpen() {
      const s = this.s
      if (!s || s.historyOpen === undefined) return true
      return Boolean(s.historyOpen)
    },
    get historyList() {
      return this.s?.historyList || this.s?.history || []
    },
    get activeSessionId() {
      return this.s?.activeSessionId
    },
    get agents() {
      return this.s?.agents || []
    },
    get model() {
      return this.s?.model || this.s?.activeTab?.model || ''
    },
    get agent() {
      return this.s?.agent || this.s?.activeTab?.agent || ''
    },
    get modelOptions() {
      const s = this.s
      if (!s) return []
      if (s.modelOptions) return s.modelOptions
      const list = Array.isArray(s.models) ? [...s.models] : []
      if (s.model && !list.includes(s.model)) list.unshift(s.model)
      return list
    },
    get allowlistOpen() {
      return Boolean(this.s?.allowlistOpen)
    },
    get allowlistOverridden() {
      return Boolean(this.s?.allowlistOverridden)
    },
    get draftInput() {
      return pick(this.s, ['draftInput', 'draft'], '') || ''
    },
    set draftInput(v) {
      const s = this.s
      if (!s) return
      s.draftInput = v
      s.draft = v
    },
    get allowlistText() {
      return pick(this.s, ['allowlistText', 'allowlist'], '') || ''
    },
    set allowlistText(v) {
      const s = this.s
      if (!s) return
      s.allowlistText = v
      s.allowlist = v
    },
    get pieDash() {
      return this.s?.pieDash || '0 97.389'
    },
    get pieUsedK() {
      return this.s?.pieUsedK ?? '0'
    },
    get contextTooltip() {
      return this.s?.contextTooltip || ''
    },
    get elapsed() {
      return this.s?.elapsed || ''
    },
    get statusLabel() {
      return this.s?.statusLabel || (this.connected ? 'ready' : 'connecting…')
    },
    get statusClass() {
      return this.s?.statusClass || (this.connected ? 'live' : 'wait')
    },
    get sendDisabled() {
      const draft = String(this.draftInput || '').trim()
      if (!draft) return true
      if (this.s && this.s.connected === false) return true
      return false
    },

    get selectSyncKey() {
      const key =
        (this.modelOptions || []).join('|') +
        '|' +
        (this.model || '') +
        '|' +
        (this.agent || '') +
        '|' +
        (this.agents || []).map((a) => a.name || a).join('|')
      queueMicrotask(() => this.syncOwnSelects())
      return key
    },

    syncOwnSelects() {
      const ids = this.ids
      const agents = (this.agents || []).map((a) =>
        typeof a === 'string' ? a : { value: a.name, label: a.name },
      )
      const models = (this.modelOptions || []).map((m) => {
        const value = typeof m === 'string' ? m : m.value
        const label = value.length > 42 ? `${value.slice(0, 20)}…${value.slice(-18)}` : value
        return { value, label }
      })
      fillSelect(typeof document !== 'undefined' && document.getElementById(ids.agent), agents, this.agent)
      fillSelect(typeof document !== 'undefined' && document.getElementById(ids.model), models, this.model)
      this.s?.syncSelects?.()
    },

    act(name, ...args) {
      const fn = this.s?.[name]
      if (typeof fn === 'function') return fn.apply(this.s, args)
    },

    send() { return this.act('send') },
    stop() { return this.act('stop') },
    onKeydown(ev) {
      if (this.s?.onKeydown) return this.act('onKeydown', ev)
      if (ev.key === 'Enter' && !ev.shiftKey) {
        ev.preventDefault()
        this.send()
      }
    },
    onDraftFocus() { return this.act('onDraftFocus') },
    onMessagesScroll() { return this.act('onMessagesScroll') },
    onAgentChange(ev) { return this.act('onAgentChange', ev) },
    onModelChange(ev) { return this.act('onModelChange', ev) },
    toggleAllowlist() { return this.act('toggleAllowlist') },
    onAllowlistInput(ev) { return this.act('onAllowlistInput', ev) },
    onAllowlistBlur() { return this.act('onAllowlistBlur') },
    decideApproval(msg, decision) { return this.act('decideApproval', msg, decision) },
    toggleMsgVisible(msg) { return this.act('toggleMsgVisible', msg) },
    toggleMsgGoto(msg) { return this.act('toggleMsgGoto', msg) },
    onGotoLabelInput(msg) { return this.act('onGotoLabelInput', msg) },
    ensureGoto(msg) {
      if (this.s?.ensureGoto) return this.act('ensureGoto', msg)
      if (!msg) return { enabled: false, label: '' }
      if (!msg.goto || typeof msg.goto !== 'object') msg.goto = { enabled: false, label: '' }
      return msg.goto
    },
    isGotoLabelDuplicate(msg) {
      if (this.s?.isGotoLabelDuplicate) return this.s.isGotoLabelDuplicate(msg)
      return false
    },
    newTab() { return this.act('newTab') },
    closeTab(id) { return this.act('closeTab', id) },
    selectTab(id) { return this.act('selectTab', id) },
    toggleHistory() { return this.act('toggleHistory') },
    toggleFullscreen() { return this.act('toggleFullscreen') },
    openSession(id) { return this.act('openSession', id) },
    deleteSession(id) { return this.act('deleteSession', id) },
    cleanAllSessions() { return this.act('cleanAllSessions') },
    useStarter(prompt) {
      if (this.s?.useStarter) return this.act('useStarter', prompt)
      this.draftInput = prompt
      this.send()
    },
    shortModel(m) {
      if (this.s?.shortModel) return this.s.shortModel(m)
      return shortModelHelper(m)
    },
    toolCallExplanation(msg) {
      if (this.s?.toolCallExplanation) return this.s.toolCallExplanation(msg)
      return toolCallExplanationHelper(msg)
    },
    toolCallCode(msg) {
      if (this.s?.toolCallCode) return this.s.toolCallCode(msg)
      return toolCallCodeHelper(msg)
    },
    toolResultImageNote(msg) {
      if (this.s?.toolResultImageNote) return this.s.toolResultImageNote(msg)
      return toolResultImageNoteHelper(msg)
    },
    formatToolArgs(args) {
      if (this.s?.formatToolArgs) return this.s.formatToolArgs(args)
      return formatToolArgs(args)
    },
    formatTelemetryHtml(t, msg) {
      if (this.s?.formatTelemetryHtml) return this.s.formatTelemetryHtml(t, msg)
      return formatTelemetryHtml(t, msg)
    },
    renderMarkdown(text) {
      if (this.s?.renderMarkdown) return this.s.renderMarkdown(text)
      return renderMarkdownHelper(text, mdOpts)
    },
    onBubbleScroll(ev, msg) {
      if (this.s?.onBubbleScroll) return this.act('onBubbleScroll', ev, msg)
      return onBubbleScrollHelper(ev, msg)
    },
    toggleBubbleExpand(ev, msg) {
      if (this.s?.toggleBubbleExpand) return this.act('toggleBubbleExpand', ev, msg)
      return toggleBubbleExpandHelper(ev, msg)
    },
    toggleBubbleCollapse(msg) {
      if (this.s?.toggleBubbleCollapse) return this.act('toggleBubbleCollapse', msg)
      return toggleBubbleCollapseHelper(msg)
    },
    stickBubbleScrolls() {
      if (this.s?.stickBubbleScrolls) return this.act('stickBubbleScrolls')
      const el = typeof document !== 'undefined' && document.getElementById(this.ids.messages)
      stickBubbleScrollsHelper(el)
    },

    init() {
      queueMicrotask(() => {
        this.syncOwnSelects()
        this.s?.ensureMessagesPinned?.()
        const el = typeof document !== 'undefined' && document.getElementById(this.ids.messages)
        if (!el) return
        watchBubbleScrollsHelper(el)
        this.stickBubbleScrolls()
      })
    },

    template: chatTpl,
  })

  return M
}
