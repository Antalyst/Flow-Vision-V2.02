type Handler = (payload: any) => void

/**
 * One app-wide WebSocket to /_ws (Nitro native websockets). It authenticates
 * with the session cookie, reconnects with backoff, and routes `{ event, payload }`
 * frames to subscribers. Browser-only: every function is a no-op during SSR.
 */
let socket: WebSocket | null = null
let retry = 0
let retryTimer: ReturnType<typeof setTimeout> | undefined
let wanted = false
const handlers = new Map<string, Set<Handler>>()
const joinedDocuments = new Map<string, number>() // documentId → subscriber count

function dispatch(event: string, payload?: unknown) {
  handlers.get(event)?.forEach((h) => h(payload))
}

function send(data: object) {
  if (socket?.readyState === WebSocket.OPEN) socket.send(JSON.stringify(data))
}

function open() {
  const url = `${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/_ws`
  const ws = new WebSocket(url)
  socket = ws

  ws.onopen = () => {
    retry = 0
    // Rooms don't survive a reconnect; rejoin open document threads.
    for (const documentId of joinedDocuments.keys()) send({ type: 'join', documentId })
    dispatch('connect')
  }
  ws.onmessage = (e) => {
    try {
      const { event, payload } = JSON.parse(String(e.data))
      dispatch(event, payload)
    } catch {
      /* ignore malformed frames */
    }
  }
  ws.onclose = () => {
    if (socket === ws) socket = null
    if (!wanted) return
    // Exponential backoff, capped at 30s.
    retryTimer = setTimeout(open, Math.min(30_000, 1000 * 2 ** retry++))
  }
}

/** Open the socket and wire pushes into the stores (idempotent). */
export function connectRealtime() {
  if (import.meta.server || wanted) return
  wanted = true

  const notifications = useNotificationsStore()
  const documents = useDocumentsStore()
  const ui = useUiStore()
  addHandler('notification', (n: { title: string; body?: string; link?: string }) => {
    notifications.received()
    ui.info(n.title, n.body, n.link ?? undefined)
  })
  addHandler('document:updated', (payload: { id: string; status: string }) => documents.changed(payload))
  open()
}

export function disconnectRealtime() {
  if (import.meta.server) return
  wanted = false
  clearTimeout(retryTimer)
  socket?.close()
  socket = null
  handlers.clear()
  joinedDocuments.clear()
}

function addHandler(event: string, handler: Handler) {
  if (!handlers.has(event)) handlers.set(event, new Set())
  handlers.get(event)!.add(handler)
}

/** Subscribe to realtime events for the lifetime of the calling component. */
export function useRealtime() {
  const mine: Array<[string, Handler]> = []
  const myDocuments: string[] = []

  function on<T = unknown>(event: string, handler: (payload: T) => void) {
    if (import.meta.server) return
    addHandler(event, handler as Handler)
    mine.push([event, handler as Handler])
  }

  /** Receive a document's thread messages while this component is mounted. */
  function joinDocument(documentId: string) {
    if (import.meta.server) return
    joinedDocuments.set(documentId, (joinedDocuments.get(documentId) ?? 0) + 1)
    myDocuments.push(documentId)
    send({ type: 'join', documentId })
  }

  onBeforeUnmount(() => {
    mine.forEach(([event, handler]) => handlers.get(event)?.delete(handler))
    for (const documentId of myDocuments) {
      const left = (joinedDocuments.get(documentId) ?? 1) - 1
      if (left > 0) joinedDocuments.set(documentId, left)
      else {
        joinedDocuments.delete(documentId)
        send({ type: 'leave', documentId })
      }
    }
  })

  return { on, joinDocument }
}
