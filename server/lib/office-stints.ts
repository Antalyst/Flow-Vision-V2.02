import type { LogEvent } from './tracking-log.ts'

/**
 * The pure half of office performance (office-performance.ts): an office's *stints* replayed from one
 * document_tracking visit, and the metrics over them. No database access, so it is unit-tested directly
 * (tests/office-performance.test.ts). The definitions are documented in office-performance.ts.
 */

const round = (n: number, p = 1) => Math.round(n * 10 ** p) / 10 ** p

// ── The stints of one visit (pure) ───────────────────────────────────────────────────────────────────

export type Outcome = 'COMPLETED' | 'RETURNED' | 'FORWARDED' | 'SENT_BACK' | 'MOVED' | 'RETURNED_TO_OFFICE'

export interface Stint {
  officeId: string
  docId: string
  visitId: string
  kind: 'STEP' | 'UNIT'
  arrivedAt: string | null
  receivedAt: string | null
  receivedBy: string | null
  /** The office's part is done: released, sent back or decided (STEP); passed back or on (UNIT). */
  clearedAt: string | null
  clearedBy: string | null
  /** How it ended; null while the office still holds it (or the paper hasn't left yet). */
  outcome: Outcome | null
  endedAt: string | null
  /** FORWARDED / MOVED: where it went next, when the log says. */
  nextOfficeId: string | null
}

export interface VisitInput {
  id: string
  document_id: string
  office_id: string | null
  step_number: number
  arrived_at?: Date | string | null
  created_at?: Date | string | null
  log: LogEvent[]
}

const iso = (d: Date | string | null | undefined) => (d ? new Date(d).toISOString() : null)
const str = (v: unknown) => (typeof v === 'string' && v ? v : null)

/** Replay one visit's log into the stints of its office and of any of its units. */
export function stintsOfVisit(v: VisitInput): Stint[] {
  if (!v.office_id || v.step_number <= 0) return []
  const office = v.office_id
  const arrival = v.log.find((e) => ['ARRIVED', 'SUBMITTED', 'RESUBMITTED'].includes(e.type))
  const step: Stint = {
    officeId: office,
    docId: v.document_id,
    visitId: v.id,
    kind: 'STEP',
    arrivedAt: arrival?.at ?? iso(v.arrived_at) ?? iso(v.created_at),
    receivedAt: null,
    receivedBy: null,
    clearedAt: null,
    clearedBy: null,
    outcome: null,
    endedAt: null,
    nextOfficeId: null,
  }
  const units: Stint[] = []
  // Set inside the helpers below; typed explicitly so the narrowing at `= null` doesn't stick.
  let unit = null as Stint | null
  let holder = office
  let sendingBack = false
  let pickup: { at: string; next: string | null; sendBack: boolean } | null = null
  let decision: { outcome: 'COMPLETED' | 'RETURNED'; at: string; by: string | null } | null = null

  const openUnit = (officeId: string | null, at: string) => {
    if (!officeId) return
    unit = { officeId, docId: v.document_id, visitId: v.id, kind: 'UNIT', arrivedAt: at, receivedAt: null, receivedBy: null, clearedAt: null, clearedBy: null, outcome: null, endedAt: null, nextOfficeId: null }
    units.push(unit)
    holder = officeId
  }
  const closeUnit = (outcome: 'MOVED' | 'RETURNED_TO_OFFICE', e: LogEvent, next: string | null) => {
    if (unit) Object.assign(unit, { outcome, endedAt: e.at, clearedAt: e.at, clearedBy: e.by, nextOfficeId: next })
    unit = null
    holder = office
  }

  for (const e of v.log) {
    const meta = e.meta ?? {}
    if ('send_back_to' in meta) sendingBack = Boolean(meta.send_back_to)
    switch (e.type) {
      case 'RECEIVED': {
        const current = unit as Stint | null
        if (current && holder === current.officeId) {
          if (!current.receivedAt) Object.assign(current, { receivedAt: e.at, receivedBy: e.by })
        } else if (!step.receivedAt) Object.assign(step, { receivedAt: e.at, receivedBy: e.by })
        break
      }
      case 'HANDED_TO_UMBRELLA':
        openUnit(str(meta.umbrella_id), e.at)
        break
      case 'INTERNAL_ROUTE_STARTED':
        openUnit(str(meta.to_office_id), e.at)
        break
      case 'INTERNAL_ROUTE_MOVED':
        closeUnit('MOVED', e, str(meta.to_office_id))
        openUnit(str(meta.to_office_id), e.at)
        break
      case 'INTERNAL_ROUTE_COMPLETED':
      case 'INTERNAL_ROUTE_ENDED':
      case 'RETURNED_FROM_UMBRELLA':
        closeUnit('RETURNED_TO_OFFICE', e, office)
        break
      case 'PICKUP_REQUESTED':
      case 'SENT_BACK':
        if (!step.clearedAt) Object.assign(step, { clearedAt: e.at, clearedBy: e.by })
        break
      case 'PICKED_UP':
        pickup = { at: e.at, next: str(meta.next_office_id), sendBack: sendingBack }
        break
      case 'DELIVERY_FAILED':
        pickup = null // back at the office: it hasn't left until it is picked up again
        break
      case 'APPROVED':
        decision = { outcome: 'COMPLETED', at: e.at, by: e.by }
        break
      case 'RETURNED':
        decision = { outcome: 'RETURNED', at: e.at, by: e.by }
        break
    }
  }

  if (decision) {
    Object.assign(step, { outcome: decision.outcome, endedAt: decision.at, clearedAt: step.clearedAt ?? decision.at, clearedBy: step.clearedBy ?? decision.by })
  } else if (pickup) {
    const p = pickup as { at: string; next: string | null; sendBack: boolean }
    Object.assign(step, { outcome: p.sendBack ? 'SENT_BACK' : 'FORWARDED', endedAt: p.at, nextOfficeId: p.next })
  }
  return [step, ...units]
}

// ── Metrics over stints (pure) ───────────────────────────────────────────────────────────────────────

export const minutesBetween = (from: string, to: string) => (new Date(to).getTime() - new Date(from).getTime()) / 60_000
export const inRange = (at: string | null, start: number) => Boolean(at) && new Date(at!).getTime() >= start
export const avg = (a: number[]) => (a.length ? a.reduce((x, y) => x + y, 0) / a.length : null)

export interface OfficeMetrics {
  /** Distinct documents the office received (scanned in) in the period. */
  received: number
  /** Distinct documents approved here (final checkpoint) in the period. */
  completed: number
  /** Distinct documents returned to their uploader by a decision here in the period. */
  returned: number
  /** Distinct documents passed on in the period: onward on the route, or (a unit) back to its office / to the next unit. */
  forwarded: number
  /** Distinct documents flagged here and sent back to the previous office in the period. */
  sent_back: number
  /** Of the documents received in the period: the share whose part here has ended (any outcome). */
  clearance_rate: number | null
  /** Of the documents received in the period: the share approved here. Only meaningful where the office decides. */
  completion_rate: number | null
  /** Receipt → cleared, for stints cleared in the period with both times known. */
  avg_processing_minutes: number | null
  processing_measured: number
  /** Distinct accounts that received or cleared a document here in the period. */
  active_personnel: number
}

/** The metrics of one office's stints, for the period starting at `start` (ms). */
export function metricsOf(stints: Stint[], start: number): OfficeMetrics & { activeIds: Set<string> } {
  const docs = (pred: (s: Stint) => boolean) => new Set(stints.filter(pred).map((s) => s.docId))
  const received = docs((s) => inRange(s.receivedAt, start))
  const ended = (o: Outcome[]) => docs((s) => Boolean(s.outcome && o.includes(s.outcome)) && inRange(s.endedAt, start))
  // The cohort received in the period: has its part here ended, and was it approved here?
  const cohort = stints.filter((s) => inRange(s.receivedAt, start))
  const clearedDocs = new Set(cohort.filter((s) => s.outcome).map((s) => s.docId))
  const completedDocs = new Set(cohort.filter((s) => s.outcome === 'COMPLETED').map((s) => s.docId))
  const timed = stints.filter((s) => s.receivedAt && s.clearedAt && inRange(s.clearedAt, start) && s.clearedAt >= s.receivedAt)
  const processing = avg(timed.map((s) => minutesBetween(s.receivedAt!, s.clearedAt!)))
  const activeIds = new Set<string>()
  for (const s of stints) {
    if (s.receivedBy && inRange(s.receivedAt, start)) activeIds.add(s.receivedBy)
    if (s.clearedBy && inRange(s.clearedAt, start)) activeIds.add(s.clearedBy)
  }
  return {
    received: received.size,
    completed: ended(['COMPLETED']).size,
    returned: ended(['RETURNED']).size,
    forwarded: ended(['FORWARDED', 'MOVED', 'RETURNED_TO_OFFICE']).size,
    sent_back: ended(['SENT_BACK']).size,
    clearance_rate: received.size ? round(clearedDocs.size / received.size, 3) : null,
    completion_rate: received.size ? round(completedDocs.size / received.size, 3) : null,
    avg_processing_minutes: processing == null ? null : round(processing),
    processing_measured: timed.length,
    active_personnel: activeIds.size,
    activeIds,
  }
}

