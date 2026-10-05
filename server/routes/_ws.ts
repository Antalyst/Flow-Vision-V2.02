import { Document } from '../lib/models.ts'
import { SESSION_COOKIE, resolveSession } from '../lib/auth.ts'
import { subscribe, unsubscribe, unsubscribeAll } from '../lib/realtime.ts'

interface PeerUser {
  id: string
  org_id: string
  office_id: string | null
}

function readCookie(header: string | null, name: string) {
  for (const part of (header ?? '').split(';')) {
    const i = part.indexOf('=')
    if (i > 0 && part.slice(0, i).trim() === name) return decodeURIComponent(part.slice(i + 1).trim())
  }
  return null
}

/**
 * Realtime endpoint (ws[s]://<host>/_ws). Authenticated with the same session
 * cookie as the API. Server → client frames are `{ event, payload }`.
 * Client → server: `{ type: 'join' | 'leave', documentId }` for document threads.
 */
export default defineWebSocketHandler({
  async upgrade(request) {
    const session = await resolveSession(readCookie(request.headers.get('cookie'), SESSION_COOKIE))
    if (!session) throw new Response('Unauthorized', { status: 401 })
    const { actor } = session
    request.context.user = { id: actor.id, org_id: actor.org_id, office_id: actor.office_id } satisfies PeerUser
  },

  open(peer) {
    const user = peer.context.user as PeerUser | undefined
    if (!user) return peer.close(4401, 'unauthorized')
    subscribe(peer, `user:${user.id}`)
    subscribe(peer, `org:${user.org_id}`)
    if (user.office_id) subscribe(peer, `office:${user.office_id}`)
  },

  async message(peer, message) {
    const user = peer.context.user as PeerUser | undefined
    if (!user) return
    let data: { type?: string; documentId?: string }
    try {
      data = JSON.parse(message.text())
    } catch {
      return
    }
    if (typeof data.documentId !== 'string') return
    if (data.type === 'leave') return unsubscribe(peer, `doc:${data.documentId}`)
    if (data.type === 'join') {
      // Only documents in the user's own organization.
      const doc = await Document.findByPk(data.documentId, { attributes: ['org_id'] })
      if (doc?.org_id === user.org_id) subscribe(peer, `doc:${data.documentId}`)
    }
  },

  close(peer) {
    unsubscribeAll(peer)
  },
})
