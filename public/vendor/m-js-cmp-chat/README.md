# m-js-cmp-chat

Cowork-style chat UI as an **m.js v3** plugin. Two layouts (sidebar + fullscreen), one store contract, clone or vendor into `public/vendor` and use it from any m-js SPA.

This exists because the same sidebar has been copied into cowork, agent-desktop, and earlier apps. Improvements now land here once.

Requires **[m.js v3](https://github.com/mikesmullin/m-js)** (`M.component` / `x-component` / `M.store`). Phosphor icons (`ph ph-*`) should already be on the page.

## Drop-in

```sh
# symlink (dev) or copy (images)
ln -s /workspace/m-js-cmp-chat public/vendor/m-js-cmp-chat
# or:
rsync -a --delete /workspace/m-js-cmp-chat/src /workspace/m-js-cmp-chat/css public/vendor/m-js-cmp-chat/
```

```html
<link rel="stylesheet" href="/vendor/phosphor/style.css" />
<link rel="stylesheet" href="/vendor/m-js-cmp-chat/css/chat.css" />
```

```js
import M from '/vendor/m.min.js'
import {
  registerChat,
  createChatStore,
  wsTransport,
} from '/vendor/m-js-cmp-chat/src/index.js'

createChatStore(M, {
  name: 'chat',
  idPrefix: 'desktop',
  transport: wsTransport({
    url: (s) => `ws://${location.host}/desktops/${s.desktop}/agent`,
  }),
})
registerChat(M)

M.mount('#app', {
  template: `
    <div x-component="mjs-chat"
         mode="sidebar"
         store="chat"
         id-prefix="desktop"
         title="desktop agent"
         :show-tabs="false"
         :show-agent="false"
         :show-goto="false"
         :show-visibility="false"
         :show-starters="false"
         :show-status="true">
      <h1>Session</h1>
      <p>Tools run inside the container.</p>
    </div>
  `,
})
```

Fullscreen (cowork):

```html
<div x-component="mjs-chat" mode="fullscreen" store="cowork" id-prefix="cowork">
  <h1>Cowork</h1>
  <p>Browser UI → angela → MCP.</p>
</div>
```

Host children fill the welcome `<slot>`. Feature flags default to the cowork fullscreen set; turn them off per app.

## Modes

| `mode` | What you get |
|---|---|
| `fullscreen` | History rail + tab bar + transcript + composer (allowlist, agent/model, pie, send/stop). Fullscreen toggle hides history. |
| `sidebar` | Compact right rail (sheet-chat). Same transcript + composer; history is off unless you pass `:showHistory="true"`. |

## Props

| Prop | Default | Notes |
|---|---|---|
| `mode` | `"sidebar"` | `"sidebar"` \| `"fullscreen"` |
| `store` | `"chat"` | `M.store` name the widget reads |
| `id-prefix` | `mjs-chat` / `mjs-chat-side` | Prefix for `#…-messages`, `#…-draft`, `#…-model`, `#…-agent`, `#…-allowlist` |
| `title` | `"Session"` / `"Chat"` | Header + default welcome `<h1>` |
| `show-tabs` | `true` | Tab strip. Sidebar with this off shows a single title chip |
| `show-history` | fullscreen only | Left session list |
| `show-agent` | fullscreen only | Agent `<select>` |
| `show-model` | `true` | Model `<select>` |
| `show-allowlist` | `true` | Shield + textarea |
| `show-pie` | `true` | Context-window pie |
| `show-goto` | fullscreen only | Bookmark gutter |
| `show-visibility` | fullscreen only | Eye gutter (exclude from context) |
| `show-starters` | fullscreen only | Welcome prompt buttons |
| `show-always` | `true` | Approval **Always** |
| `show-denied` | `true` | DENIED label on tool results |
| `show-status` | `false` | `ready` / `running` + elapsed |

Booleans: pass `:show-tabs="false"` (expression). A bare `show-tabs` attribute is `true`. HTML parsers lowercase attrs, so always use kebab-case at the call site.

## Store contract

The widget does not own the wire. It calls methods on `M.store(store)` and reads fields. Alias pairs are accepted so cowork (`activeMessages`) and a single-session store (`messages`) both work.

**Read**

- `messages` / `activeMessages`
- `waiting` / `activeWaiting`
- `draft` / `draftInput` (getter+setter)
- `allowlist` / `allowlistText` (getter+setter)
- `connected` (optional; missing ⇒ treat as connected)
- `error`, `model`, `models` / `modelOptions`, `agents`
- `allowlistOpen`, `allowlistOverridden`
- `pieDash`, `pieUsedK`, `contextTooltip`
- `tabList` / `tabs`, `activeTabId`
- `history` / `historyList`, `historyOpen`, `isFullscreen`, `activeSessionId`
- `showWelcome`, `welcomeStarters`
- `elapsed`, `statusLabel`, `statusClass`

**Call** (missing methods are no-ops)

- `send`, `stop`, `onKeydown`, `onDraftFocus`
- `onAgentChange`, `onModelChange`
- `toggleAllowlist`, `onAllowlistInput`, `onAllowlistBlur`
- `decideApproval(msg, decision)`
- `toggleMsgVisible`, `toggleMsgGoto`, `onGotoLabelInput`, `ensureGoto`, `isGotoLabelDuplicate`
- `newTab`, `closeTab`, `selectTab`
- `toggleHistory`, `toggleFullscreen`
- `openSession`, `deleteSession`, `cleanAllSessions`
- `useStarter`, `onMessagesScroll`

Markdown / tool-card / telemetry helpers live in this package. A host store may override them.

`createChatStore(M, { transport })` implements the single-session side of this contract. `wsTransport({ url })` speaks the angela WS protocol used by agent-desktop (`hello`, `assistant_delta`, `card`, `approval_needed`, `done`, …). Cowork keeps its own tabbed HTTP/NDJSON store and only mounts the widget.

## Theme

`.mjs-chat` maps:

` --bg --panel --panel-2 --border/--line --text/--ink --muted/--dim --accent --ok/--live --err/--down --user --user-border --tool --mono --sans `

Override those on `:root` (or set `--mjs-*` on `.mjs-chat`).

## Demo

```sh
cd /workspace/m-js-cmp-chat
bun demo/server.js    # http://127.0.0.1:3333
```

## Layout of this repo

```
src/index.js       public API
src/register.js    M.component('mjs-chat')
src/store.js       createChatStore + wsTransport
src/helpers.js     markdown, telemetry, tool cards
src/templates.js   sidebar + fullscreen markup
css/chat.css       scoped styles
demo/              mock echo backend
```
