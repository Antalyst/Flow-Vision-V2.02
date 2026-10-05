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
