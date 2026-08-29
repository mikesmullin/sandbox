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
      return `${proto()}//${location.host}/desktops/${encodeURIComponent(s.desktop)}/agent`
    },
  }),
})
