const base = new URL(document.baseURI).pathname.replace(/\/$/, '')

export const withBase = (path) => `${base}${path.startsWith('/') ? path : `/${path}`}`

export const wsUrl = (path) => {
  const protocol = location.protocol === 'https:' ? 'wss:' : 'ws:'
  return `${protocol}//${location.host}${withBase(path)}`
}