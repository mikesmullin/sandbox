import M from '../vendor/m.min.js'
import { createChatStore, wsTransport } from '../vendor/m-js-cmp-chat/src/index.js'
import { wsUrl } from './paths.js'

export const chat = createChatStore(M, {
  name: 'chat',
  idPrefix: 'desktop',
  model: 'llama-server:default',
  modelKey: 'agent-desktop.chatModel',
  onDraftFocus() {
    window.__desktopUngrab?.()
  },
  transport: wsTransport({
    url: (s) => {
      if (!s.desktop) return ''
      const key = String(s.desktop)
      const split = key.indexOf('::')
      if (split > 0) {
        const name = key.slice(0, split)
        const ws = key.slice(split + 2)
        if (name && ws) {
          return wsUrl(`/desktops/${encodeURIComponent(name)}/workspaces/${encodeURIComponent(ws)}/agent`)
        }
      }
      return wsUrl(`/desktops/${encodeURIComponent(key)}/agent`)
    },
  }),
})
