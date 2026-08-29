/**
 * Markup for the cowork chat widgets. Kept as strings so `mjs-chat`
 * can compose sidebar + fullscreen from one source.
 */

export const messageBlockTpl = `
  <div
    class="msg-block"
    x-for="msg in messages"
    :key="msg.id"
    :class="{
      'msg-hidden': msg.visible === false,
      'msg-user': msg.kind === 'user',
    }"
    :data-msg-id="msg.id"
  >
    <div class="bubble-user" x-show="msg.kind === 'user'" x-text="msg.text"></div>

    <div
      class="bubble-assistant md-body is-streaming"
      x-show="msg.kind === 'assistant' && msg.streaming"
    >
      <span x-text="msg.text || ''"></span><span class="stream-caret" aria-hidden="true"></span>
    </div>
    <div
      class="bubble-assistant md-body"
      x-show="msg.kind === 'assistant' && !msg.streaming"
      x-html="renderMarkdown(msg.text)"
    ></div>

    <div
      class="bubble-reasoning"
      x-show="msg.kind === 'reasoning'"
      :class="{ 'is-streaming': msg.streaming }"
    >
      <div class="reasoning-header">
        <i class="ph ph-brain reasoning-icon" aria-hidden="true"></i>
        <span class="reasoning-label">Reasoning</span>
      </div>
      <div class="reasoning-body" x-text="msg.text || ''"></div>
    </div>

    <div class="tool-card tool-call-card" x-show="msg.kind === 'tool_call'">
      <div class="tool-call-header">
        <i class="ph ph-terminal-window tool-icon" aria-hidden="true"></i>
        <span class="tool-call-name" x-text="msg.name"></span>
      </div>
      <div
        class="tool-call-explanation"
        x-show="toolCallExplanation(msg)"
        x-text="toolCallExplanation(msg)"
      ></div>
      <pre
        class="tool-call-code"
        x-show="toolCallCode(msg)"
        x-text="toolCallCode(msg)"
      ></pre>
    </div>

    <div
      class="tool-card tool-card-row"
      x-show="msg.kind === 'tool_result'"
      :class="msg.ok === false ? 'err' : 'ok'"
    >
      <i
        class="ph tool-icon"
        :class="msg.ok === false ? 'ph-x-circle' : 'ph-check-circle'"
        aria-hidden="true"
      ></i>
      <span x-text="msg.name"></span>
      <span x-show="want('showDenied') && msg.denied" class="text-red-400"> DENIED</span>
      <span
        class="tool-size"
        x-show="msg.full_chars"
        x-text="(msg.full_chars || 0).toLocaleString() + ' B'"
      ></span>
      <pre class="tool-result-body" x-text="msg.text || ''"></pre>
    </div>

    <div
      class="approval-card"
      x-show="msg.kind === 'approval_needed'"
      :class="msg.status === 'pending' ? 'pending' : 'resolved'"
    >
      <div class="font-semibold text-sm approval-title">
        <i class="ph ph-warning tool-icon" aria-hidden="true"></i>
        Tool approval required
      </div>
      <div class="text-xs mt-1 font-mono" x-text="msg.name"></div>
      <div class="text-xs mt-1" x-text="msg.command || formatToolArgs(msg.args)"></div>
      <div class="flex gap-2 mt-2" x-show="msg.status === 'pending'">
        <button type="button" class="btn-allow" @click="decideApproval(msg, 'allow')">Allow</button>
        <button type="button" class="btn-always" x-show="want('showAlways')" @click="decideApproval(msg, 'always')">Always</button>
        <button type="button" class="btn-deny" @click="decideApproval(msg, 'deny')">Deny</button>
      </div>
      <div class="text-xs mt-2" x-show="msg.status !== 'pending'"
        x-text="'Decision: ' + msg.status"></div>
    </div>

    <div
      class="msg-gutter"
      x-show="want('showVisibility') || want('showGoto') || msg.telemetry || msg.kind === 'user'"
    >
      <div class="msg-gutter-actions">
        <button
          type="button"
          class="gutter-btn"
          x-show="want('showVisibility')"
          :title="msg.visible === false ? 'Include in context window' : 'Exclude from context window'"
          @click="toggleMsgVisible(msg)"
        >
          <i
            class="ph"
            :class="msg.visible === false ? 'ph-eye-slash' : 'ph-eye'"
            :aria-label="msg.visible === false ? 'hidden' : 'visible'"
          ></i>
        </button>
        <button
          type="button"
          class="gutter-btn gutter-btn-goto"
          x-show="want('showGoto')"
          :class="{ on: msg.goto && msg.goto.enabled }"
          title="Goto bookmark — agent can jump here with goto(label)"
          @click="toggleMsgGoto(msg)"
        >
          <i
            class="ph ph-bookmark-simple"
            :aria-label="msg.goto && msg.goto.enabled ? 'goto on' : 'goto off'"
          ></i>
        </button>
        <input
          type="text"
          class="goto-label-input"
          :class="{ duplicate: isGotoLabelDuplicate(msg) }"
          x-show="want('showGoto') && msg.goto && msg.goto.enabled"
          x-cloak
          x-model="msg.goto.label"
          @focus="ensureGoto(msg)"
          @input="onGotoLabelInput(msg)"
          @click.stop
          placeholder="label"
          spellcheck="false"
          autocomplete="off"
        />
      </div>
      <div
        class="msg-gutter-metrics"
        x-show="msg.telemetry || msg.kind === 'user'"
        x-html="formatTelemetryHtml(msg.telemetry, msg)"
      ></div>
    </div>
  </div>
`

export const composerTpl = `
  <footer class="composer" :class="{ 'sheet-composer': isSidebar }">
    <div class="composer-inner">
      <div class="allowlist-panel" x-show="want('showAllowlist') && allowlistOpen" x-cloak>
        <label class="allowlist-label">
          allowed commands (one rule per line)
          <span
            class="allowlist-source"
            x-text="allowlistOverridden ? '· ui override' : '· agent default'"
          ></span>
        </label>
        <textarea
          class="allowlist-ta"
          :id="ids.allowlist"
          x-model="allowlistText"
          @input="onAllowlistInput($event)"
          @blur="onAllowlistBlur()"
          spellcheck="false"
        ></textarea>
      </div>

      <textarea
        class="draft-ta"
        :id="ids.draft"
        x-model="draftInput"
        @keydown="onKeydown($event)"
        @focus="onDraftFocus()"
        placeholder="Message… (Enter send, Shift+Enter newline)"
      ></textarea>

      <div class="composer-row">
        <select
          class="dd agent-dd"
          :id="ids.agent"
          x-show="want('showAgent')"
          @change="onAgentChange($event)"
          :disabled="waiting || !agents.length"
          title="Agent"
        ></select>

        <select
          class="dd model-dd"
          :id="ids.model"
          x-show="want('showModel')"
          @change="onModelChange($event)"
          :disabled="waiting || !modelOptions.length"
          title="Model"
        ></select>

        <div
          class="ctx-pie"
          x-show="want('showPie')"
          :title="contextTooltip"
          role="img"
          :aria-label="contextTooltip"
        >
          <svg viewBox="0 0 36 36" width="28" height="28" aria-hidden="true">
            <circle
              cx="18" cy="18" r="15.5"
              fill="none"
              stroke="currentColor"
              class="ctx-pie-track"
              stroke-width="4"
            />
            <circle
              cx="18" cy="18" r="15.5"
              fill="none"
              stroke="currentColor"
              class="ctx-pie-fill"
              stroke-width="4"
              stroke-linecap="round"
              :stroke-dasharray="pieDash"
              stroke-dashoffset="0"
              transform="rotate(-90 18 18)"
            />
          </svg>
          <span class="ctx-pie-label" x-text="pieUsedK"></span>
        </div>

        <button
          type="button"
          class="btn-stop"
          x-show="waiting"
          @click="stop()"
          title="Stop agent"
        >
          <i class="ph ph-stop" aria-hidden="true"></i>
          <span x-show="!isSidebar">Stop</span>
        </button>

        <button
          type="button"
          class="icon-btn allowlist-toggle"
          x-show="want('showAllowlist')"
          :class="{ active: allowlistOpen }"
          @click="toggleAllowlist()"
          title="Allowlist"
        >
          <i class="ph ph-shield-check" aria-hidden="true"></i>
        </button>

        <button
          type="button"
          class="btn-primary"
          x-show="!waiting"
          @click="send()"
          :disabled="sendDisabled"
        >
          <i class="ph ph-paper-plane-right" aria-hidden="true"></i>
          <span>Send</span>
        </button>
      </div>
    </div>
  </footer>
`

export const historyTpl = `
  <aside class="history" :class="{ collapsed: !historyOpen || isFullscreen }" x-show="isFullscreenMode && want('showHistory')">
    <div class="history-header">
      <span>History</span>
      <button
        type="button"
        class="icon-btn trash-all"
        title="Delete all sessions"
        @click="cleanAllSessions()"
        x-show="historyList.length > 0"
      >
        <i class="ph ph-trash" aria-hidden="true"></i>
      </button>
    </div>
    <div class="history-list">
      <div class="text-xs px-2 py-3" x-show="historyList.length === 0">
        No sessions yet
      </div>
      <div
        class="history-item-row"
        x-for="item in historyList"
        :key="item.id"
        :class="{ active: activeSessionId === item.id }"
      >
        <button
          type="button"
          class="history-item"
          @click="openSession(item.id)"
        >
          <div class="history-title" x-text="item.title || item.agent || item.id"></div>
          <div class="history-meta">
            <span x-text="item.agent || ''"></span>
            <span x-show="item.model" x-text="' · ' + shortModel(item.model)"></span>
          </div>
        </button>
        <button
          type="button"
          class="trash-one"
          title="Delete this session"
          @click.stop="deleteSession(item.id)"
        >
          <i class="ph ph-trash" aria-hidden="true"></i>
        </button>
      </div>
    </div>
  </aside>
`

export const tabsTpl = `
  <div class="tabs" :class="{ 'sheet-chat-tabs': isSidebar }">
    <div
      class="tab"
      x-for="tab in tabList"
      :key="tab.id"
      :class="{ active: tab.id === activeTabId }"
      @click="selectTab(tab.id)"
    >
      <span x-text="tab.name"></span>
      <button
        type="button"
        class="x"
        @click.stop="closeTab(tab.id)"
        title="Close"
      >
        <i class="ph ph-x" aria-hidden="true"></i>
      </button>
    </div>
    <button type="button" class="icon-btn" @click="newTab()" title="New chat">
      <i class="ph ph-plus" aria-hidden="true"></i>
    </button>
  </div>
`

export const welcomeTpl = `
  <div class="welcome" :class="{ 'sheet-welcome': isSidebar }" x-show="showWelcome">
    <slot>
      <h1 x-text="welcomeTitle"></h1>
      <p x-show="welcomeLead" x-html="welcomeLead"></p>
    </slot>
    <div class="starter" x-show="want('showStarters') && welcomeStarters.length">
      <button
        type="button"
        x-for="s in welcomeStarters"
        :key="s.prompt"
        @click="useStarter(s.prompt)"
        x-text="s.label"
      ></button>
    </div>
  </div>
`

export const transcriptTpl = `
  <div
    class="messages"
    :class="{ 'sheet-messages': isSidebar }"
    :id="ids.messages"
    @scroll.passive="onMessagesScroll()"
  >
    ${welcomeTpl}
    ${messageBlockTpl}
    <div class="thinking" x-show="waiting">
      Thinking <span>•</span><span>•</span><span>•</span>
    </div>
    <div class="chat-err" x-show="error" x-text="error"></div>
  </div>
`

export const chatTpl = `
  <div
    class="mjs-chat"
    :class="rootClass"
    aria-label="Session"
  >
    <span class="mjs-chat-sync" hidden x-text="selectSyncKey"></span>
    ${historyTpl}

    <section class="main" :class="{ fullscreen: isFullscreen, 'sheet-chat': isSidebar }">
      <header class="topbar" :class="{ 'sheet-chat-top': isSidebar }">
        <button
          type="button"
          class="icon-btn"
          x-show="isFullscreenMode && !isFullscreen"
          @click="toggleHistory()"
          title="Toggle history"
        >
          <i class="ph ph-list" aria-hidden="true"></i>
        </button>

        <div class="sheet-chat-tabs" x-show="isSidebar && !want('showTabs')">
          <div class="tab active">
            <i class="ph ph-robot"></i>
            <span x-text="welcomeTitle"></span>
          </div>
          <div class="chat-header-meta" x-show="want('showStatus')">
            <span class="chat-status" :class="statusClass" x-text="statusLabel"></span>
            <span class="chat-elapsed" x-show="elapsed" x-text="elapsed"></span>
          </div>
        </div>

        <div x-show="want('showTabs')" style="flex:1;min-width:0;display:flex;align-items:center;gap:8px">
          ${tabsTpl}
        </div>

        <div class="chat-header-meta" x-show="!isSidebar && want('showStatus')">
          <span class="chat-status" :class="statusClass" x-text="statusLabel"></span>
          <span class="chat-elapsed" x-show="elapsed" x-text="elapsed"></span>
        </div>

        <button
          type="button"
          class="icon-btn"
          x-show="isFullscreenMode"
          @click="toggleFullscreen()"
          :title="isFullscreen ? 'Exit fullscreen' : 'Fullscreen chat'"
        >
          <i class="ph ph-corners-out" x-show="!isFullscreen" aria-hidden="true"></i>
          <i class="ph ph-corners-in" x-show="isFullscreen" aria-hidden="true"></i>
        </button>
      </header>

      ${transcriptTpl}
      ${composerTpl}
    </section>
  </div>
`
