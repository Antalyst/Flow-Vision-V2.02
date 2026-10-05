import type { Transaction } from 'sequelize'

/**
 * Topic registry for the native WebSocket endpoint (server/routes/_ws.ts).
 * Topics: user:{id} · org:{id} · office:{id} · doc:{id}.
 *
 * State lives in this process. Running several server instances would need a
 * shared pub/sub (e.g. Redis) in front of `emit`.
 */
export interface RealtimePeer {
  id: string
  send(data: string): unknown
}

const subscribers = new Map<string, Set<RealtimePeer>>()
const peerTopics = new Map<string, Set<string>>()

export function subscribe(peer: RealtimePeer, topic: string) {
  if (!subscribers.has(topic)) subscribers.set(topic, new Set())
  subscribers.get(topic)!.add(peer)
  if (!peerTopics.has(peer.id)) peerTopics.set(peer.id, new Set())
  peerTopics.get(peer.id)!.add(topic)
}

export function unsubscribe(peer: RealtimePeer, topic: string) {
  subscribers.get(topic)?.delete(peer)
  if (subscribers.get(topic)?.size === 0) subscribers.delete(topic)
  peerTopics.get(peer.id)?.delete(topic)
}

export function unsubscribeAll(peer: RealtimePeer) {
  for (const topic of peerTopics.get(peer.id) ?? []) unsubscribe(peer, topic)
  peerTopics.delete(peer.id)
}

/** Send `{ event, payload }` once to every peer subscribed to any of `topics`. */
export function emit(topics: string | Array<string | null | undefined>, event: string, payload: unknown) {
  const targets = new Set<RealtimePeer>()
  for (const topic of (Array.isArray(topics) ? topics : [topics]).filter(Boolean) as string[]) {
    subscribers.get(topic)?.forEach((peer) => targets.add(peer))
  }
  if (!targets.size) return
  const message = JSON.stringify({ event, payload })
  for (const peer of targets) {
    try {
      peer.send(message)
    } catch {
      unsubscribeAll(peer)
    }
  }
}

/** Emit only once the surrounding transaction commits, so clients never see rolled-back state. */
export function emitAfterCommit(transaction: Transaction | null | undefined, topics: string | Array<string | null | undefined>, event: string, payload: unknown) {
  if (transaction) transaction.afterCommit(() => emit(topics, event, payload))
  else emit(topics, event, payload)
}
