import crypto from 'node:crypto'
import type { Row } from './models.ts'
import { badRequest } from './errors.ts'

/**
 * document_tracking has one row per office visit. What happened during the visit
 * (received, pickup requested, picked up, notes, decisions…) is kept as a JSON array
 * in the row's `notes` column so the full timeline survives without extra tables.
 */
export interface LogEvent {
  id: string
  type: string
  at: string // ISO timestamp with milliseconds
  by: string | null // users.id
  status: string // document status after the event
  remarks?: string | null
  meta?: Record<string, unknown> | null
}

// notes is a TEXT column (64 KB). Leave headroom.
const MAX_NOTES_BYTES = 60_000

export function readLog(visit: Row): LogEvent[] {
  const raw = visit.notes as string | null
  if (!raw) return []
  try {
    const parsed = JSON.parse(raw)
    if (Array.isArray(parsed)) return parsed.filter((e) => e && typeof e.type === 'string' && typeof e.at === 'string')
  } catch {
    /* plain-text notes written by another tool */
  }
  // Show foreign free text as a single note rather than dropping it.
  return [{ id: `note-${visit.id}`, type: 'NOTE', at: new Date(visit.created_at).toISOString(), by: null, status: visit.status, remarks: raw }]
}

/** Append an event to a visit (mutates `visit.notes`; the caller saves the row). */
export function appendLog(visit: Row, event: Omit<LogEvent, 'id' | 'at'> & { at?: Date }) {
  const entry: LogEvent = {
    id: crypto.randomUUID(),
    type: event.type,
    at: (event.at ?? new Date()).toISOString(),
    by: event.by,
    status: event.status,
    ...(event.remarks ? { remarks: event.remarks } : {}),
    ...(event.meta ? { meta: event.meta } : {}),
  }
  const next = JSON.stringify([...readLog(visit), entry])
  if (Buffer.byteLength(next) > MAX_NOTES_BYTES) throw badRequest('This step has too many notes — continue the conversation in the document thread')
  visit.notes = next
  return entry
}

/**
 * Where the visit's open release takes the document when it is a send-back: flagged with an issue
 * and carried back to the previous office. Every event that opens or closes a release (assigned,
 * reassigned, sent back, unassigned, delivery failed) records `send_back_to` — an office id, or
 * null for a normal release forward — and the last one decides. Null = forward along the route.
 * (document-queries.ts sendBackSql reads the same marker in SQL.)
 */
export function sendBackTarget(visit: Row | null | undefined): { officeId: string; step: number; issueId: string | null } | null {
  if (!visit) return null
  const last = readLog(visit)
    .filter((e) => e.meta && 'send_back_to' in e.meta)
    .at(-1)
  if (typeof last?.meta?.send_back_to !== 'string') return null
  return { officeId: last.meta.send_back_to, step: Number(last.meta.target_step ?? 0), issueId: (last.meta.issue_id as string | undefined) ?? null }
}

// Events that change who holds the document inside an office.
const DESK_EVENTS = ['RECEIVED', 'PASSED_TO_STAFF', 'PASS_CANCELLED', 'DELIVERY_FAILED']

/**
 * The visit's open desk-to-desk hand-off: a staff member passed the document to the next staff
 * of the same office (handler_id cleared) and nobody has scanned it in since. Null otherwise.
 */
export function pendingPass(visit: Row | null | undefined): LogEvent | null {
  if (!visit || visit.handler_id) return null
  const last = readLog(visit)
    .filter((e) => DESK_EVENTS.includes(e.type))
    .at(-1)
  return last?.type === 'PASSED_TO_STAFF' ? last : null
}
