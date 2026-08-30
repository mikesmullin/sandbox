import M from '/vendor/m.min.js'
import { createChatStore, wsTransport } from '/vendor/m-js-cmp-chat/src/index.js'

const proto = () => (location.protocol === 'https:' ? 'wss:' : 'ws:')

export const chat = createChatStore(M, {
  name: 'chat',
  idPrefix: 'desktop',
  model: 'llama-server:default',
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
          return `${proto()}//${location.host}/desktops/${encodeURIComponent(name)}/workspaces/${encodeURIComponent(ws)}/agent`
        }
      }
      return `${proto()}//${location.host}/desktops/${encodeURIComponent(key)}/agent`
    },
  }),
})
