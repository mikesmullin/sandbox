/**
 * Isolate-mode right rail — cowork sheet chat + composer (allowlist, pie, model, stop).
 */
import { chat } from '../chat.js'

export default function ChatSidebar() {
  return {
    get draftInput() { return chat.draft },
    set draftInput(v) { chat.draft = v },
    get messages() { return chat.messages },
    get waiting() { return chat.waiting },
    get connected() { return chat.connected },
    get error() { return chat.error },
    get model() { return chat.model },
    get modelOptions() { return chat.modelOptions },
    get showWelcome() { return !chat.messages.length },
    get allowlistOpen() { return chat.allowlistOpen },
    get allowlistOverridden() { return chat.allowlistOverridden },
    get allowlistText() { return chat.allowlist },
    set allowlistText(v) { chat.allowlist = v },
    get pieDash() { return chat.pieDash },
    get pieUsedK() { return chat.pieUsedK },
    get contextTooltip() { return chat.contextTooltip },
    get elapsed() { return chat.elapsed },
    get statusLabel() { return chat.statusLabel },
    get statusClass() { return chat.statusClass },
    send() { chat.send() },
    stop() { chat.stop() },
    onKeydown(ev) { chat.onKeydown(ev) },
    onMessagesScroll() { chat.onMessagesScroll() },
    onModelChange(ev) { chat.onModelChange(ev) },
    toggleAllowlist() { chat.toggleAllowlist() },
    onAllowlistInput(ev) { chat.onAllowlistInput(ev) },
    onAllowlistBlur() { chat.onAllowlistBlur() },
    toolCallExplanation(msg) { return chat.toolCallExplanation(msg) },
    toolCallCode(msg) { return chat.toolCallCode(msg) },
    formatToolArgs(args) { return chat.formatToolArgs(args) },
    formatTelemetryHtml(t, msg) { return chat.formatTelemetryHtml(t, msg) },
    decideApproval(msg, decision) { chat.decideApproval(msg, decision) },
    renderMarkdown(text) { return chat.renderMarkdown(text) },
    template: `
      <aside class="sheet-chat" aria-label="Session">
        <header class="sheet-chat-top">
          <div class="sheet-chat-tabs">
            <div class="tab active">
              <i class="ph ph-robot"></i>
              <span>desktop agent</span>
            </div>
            <div class="chat-header-meta">
              <span class="chat-status" :class="statusClass" x-text="statusLabel"></span>
              <span class="chat-elapsed" x-show="elapsed" x-text="elapsed"></span>
            </div>
          </div>
        </header>

        <div
          class="messages sheet-messages"
          id="desktop-messages"
          @scroll.passive="onMessagesScroll()"
        >
          <div class="welcome sheet-welcome" x-show="showWelcome">
            <h1>Session</h1>
            <p class="text-xs">
              This agent runs <strong>inside</strong> the container. File, shell,
              and Chromium tools execute on the desktop you are watching.
            </p>
          </div>

          <div
            class="msg-block"
            x-for="msg in messages"
            :key="msg.id"
            :class="{
              'msg-user': msg.kind === 'user',
            }"
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
                <button type="button" class="btn-always" @click="decideApproval(msg, 'always')">Always</button>
                <button type="button" class="btn-deny" @click="decideApproval(msg, 'deny')">Deny</button>
              </div>
              <div class="text-xs mt-2" x-show="msg.status !== 'pending'"
                x-text="'Decision: ' + msg.status"></div>
            </div>
            <div
              class="msg-gutter"
              x-show="msg.telemetry && (msg.kind === 'assistant' || msg.kind === 'reasoning')"
            >
              <div
                class="msg-gutter-metrics"
                x-html="formatTelemetryHtml(msg.telemetry, msg)"
              ></div>
            </div>
          </div>

          <div class="thinking" x-show="waiting">
            Thinking <span>•</span><span>•</span><span>•</span>
          </div>
          <div class="chat-err" x-show="error" x-text="error"></div>
        </div>

        <footer class="composer sheet-composer">
          <div class="composer-inner">
            <div class="allowlist-panel" x-show="allowlistOpen" x-cloak>
              <label class="allowlist-label">
                allowed commands (one rule per line)
                <span
                  class="allowlist-source"
                  x-text="allowlistOverridden ? '· ui override' : '· agent default'"
                ></span>
              </label>
              <textarea
                class="allowlist-ta"
                id="desktop-allowlist"
                x-ignore
                @input="onAllowlistInput($event)"
                @blur="onAllowlistBlur()"
                @keydown.stop=""
                spellcheck="false"
              ></textarea>
            </div>

            <textarea
              class="draft-ta"
              id="desktop-draft"
              x-model="draftInput"
              @keydown="onKeydown($event)"
              @keydown.stop=""
              placeholder="Message… (Enter send, Shift+Enter newline)"
            ></textarea>
            <div class="composer-row">
              <select
                class="dd model-dd"
                id="desktop-model"
                @change="onModelChange($event)"
                :disabled="waiting || !modelOptions.length"
                title="Model"
              >
                <option
                  x-for="m in modelOptions"
                  :key="m"
                  :value="m"
                  :selected="m === model"
                  x-text="m"
                ></option>
              </select>

              <div
                class="ctx-pie"
                :title="contextTooltip"
                role="img"
                :aria-label="contextTooltip"
              >
                <svg viewBox="0 0 36 36" width="28" height="28" aria-hidden="true">
                  <circle
                    cx="18" cy="18" r="15.5"
                    fill="none"
                    stroke="var(--bg-2)"
                    stroke-width="4"
                  />
                  <circle
                    cx="18" cy="18" r="15.5"
                    fill="none"
                    stroke="var(--accent)"
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
                <span>Stop</span>
              </button>

              <button
                type="button"
                class="icon-btn allowlist-toggle"
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
                :disabled="!connected || !(draftInput || '').trim()"
              >
                <i class="ph ph-paper-plane-right" aria-hidden="true"></i>
                <span>Send</span>
              </button>
            </div>
          </div>
        </footer>
      </aside>
    `,
  }
}
