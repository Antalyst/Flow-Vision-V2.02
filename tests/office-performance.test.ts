/**
 * Office performance, the pure half (server/lib/office-stints.ts): an office's stints replayed from a visit's
 * log, and the metrics over them. No database, no running app.
 *
 *   npm run test:office-performance
 */
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { metricsOf, stintsOfVisit, type VisitInput } from '../server/lib/office-stints.ts'

const MAIN = 'main'
const U1 = 'unit-1'
const U2 = 'unit-2'
const NEXT = 'records'
let seq = 0
const at = (minute: number) => new Date(Date.UTC(2026, 10, 2, 1, minute)).toISOString()
const e = (type: string, minute: number, by: string | null = 'staff-a', meta: Record<string, unknown> = {}) => ({ id: String(++seq), type, at: at(minute), by, status: 'ARRIVED_AT_OFFICE', meta })
const visit = (log: VisitInput['log'], extra: Partial<VisitInput> = {}): VisitInput => ({ id: `v${++seq}`, document_id: 'doc-1', office_id: MAIN, step_number: 1, log, ...extra })
const START = new Date(at(0)).getTime()

describe('stintsOfVisit', () => {
  it('a visit received and forwarded: one STEP stint, forwarded (not completed)', () => {
    const [s, ...rest] = stintsOfVisit(visit([e('ARRIVED', 0, 'liaison'), e('RECEIVED', 5), e('PICKUP_REQUESTED', 20), e('PICKED_UP', 30, 'liaison', { next_office_id: NEXT })]))
    assert.equal(rest.length, 0)
    assert.equal(s!.kind, 'STEP')
    assert.equal(s!.receivedAt, at(5))
    assert.equal(s!.clearedAt, at(20), 'cleared at the release, as in the office forecast')
    assert.equal(s!.outcome, 'FORWARDED')
    assert.equal(s!.endedAt, at(30), 'ended when the paper left')
    assert.equal(s!.nextOfficeId, NEXT)
  })

  it('released but not picked up yet: still open (pending), though cleared', () => {
    const [s] = stintsOfVisit(visit([e('ARRIVED', 0), e('RECEIVED', 5), e('PICKUP_REQUESTED', 20)]))
    assert.equal(s!.outcome, null)
    assert.equal(s!.clearedAt, at(20))
  })

  it('a failed delivery brings it back: not forwarded until picked up again', () => {
    const [s] = stintsOfVisit(visit([e('ARRIVED', 0), e('RECEIVED', 5), e('PICKUP_REQUESTED', 10), e('PICKED_UP', 12, 'liaison', { next_office_id: NEXT }), e('DELIVERY_FAILED', 40, 'liaison', { send_back_to: null })]))
    assert.equal(s!.outcome, null)
    const [again] = stintsOfVisit(visit([e('ARRIVED', 0), e('RECEIVED', 5), e('PICKUP_REQUESTED', 10), e('PICKED_UP', 12, 'liaison'), e('DELIVERY_FAILED', 40, 'liaison'), e('PICKED_UP', 50, 'liaison')]))
    assert.equal(again!.outcome, 'FORWARDED')
    assert.equal(again!.endedAt, at(50))
  })

  it('approved at the final checkpoint: COMPLETED; returned by the decision: RETURNED', () => {
    const [ok] = stintsOfVisit(visit([e('ARRIVED', 0), e('RECEIVED', 5), e('APPROVAL_REQUESTED', 5, null), e('APPROVED', 60, 'head')]))
    assert.equal(ok!.outcome, 'COMPLETED')
    assert.equal(ok!.clearedAt, at(60))
    assert.equal(ok!.clearedBy, 'head')
    const [back] = stintsOfVisit(visit([e('ARRIVED', 0), e('RECEIVED', 5), e('RETURNED', 60, 'head')]))
    assert.equal(back!.outcome, 'RETURNED')
  })

  it('sent back: SENT_BACK, cleared at the send-back; a cancelled send-back then a release is FORWARDED', () => {
    const [s] = stintsOfVisit(visit([e('ARRIVED', 0), e('RECEIVED', 5), e('SENT_BACK', 15, 'staff-a', { send_back_to: 'prev' }), e('RETURN_PICKUP_CLAIMED', 20, 'liaison'), e('PICKED_UP', 25, 'liaison', { next_office_id: 'prev' })]))
    assert.equal(s!.outcome, 'SENT_BACK')
    assert.equal(s!.clearedAt, at(15))
    const [f] = stintsOfVisit(visit([e('ARRIVED', 0), e('RECEIVED', 5), e('SENT_BACK', 15, 'staff-a', { send_back_to: 'prev' }), e('NOTE', 16, 'staff-a', { send_back_to: null }), e('PICKUP_REQUESTED', 20), e('PICKED_UP', 25, 'liaison', { next_office_id: NEXT })]))
    assert.equal(f!.outcome, 'FORWARDED')
  })

  it('hand-off to an umbrella office and back: a UNIT stint for the unit, the office keeps its STEP stint', () => {
    const stints = stintsOfVisit(
      visit([
        e('ARRIVED', 0),
        e('RECEIVED', 2, 'main-staff'),
        e('HANDED_TO_UMBRELLA', 3, 'main-staff', { umbrella_id: U1, from_office_id: MAIN }),
        e('RECEIVED', 10, 'unit-staff'),
        e('RETURNED_FROM_UMBRELLA', 40, 'unit-staff', { umbrella_id: U1, to_office_id: MAIN }),
        e('RECEIVED', 45, 'main-staff-2'),
        e('PICKUP_REQUESTED', 50, 'main-staff-2'),
        e('PICKED_UP', 55, 'liaison', { next_office_id: NEXT }),
      ]),
    )
    const step = stints.find((s) => s.kind === 'STEP')!
    const unit = stints.find((s) => s.kind === 'UNIT')!
    assert.equal(step.receivedBy, 'main-staff', "the office's receipt is its first, not the unit's")
    assert.equal(step.outcome, 'FORWARDED')
    assert.deepEqual([unit.officeId, unit.arrivedAt, unit.receivedAt, unit.receivedBy, unit.outcome, unit.endedAt], [U1, at(3), at(10), 'unit-staff', 'RETURNED_TO_OFFICE', at(40)])
  })

  it('an internal route through two units: MOVED, then RETURNED_TO_OFFICE', () => {
    const stints = stintsOfVisit(
      visit([
        e('ARRIVED', 0),
        e('RECEIVED', 1, 'main-staff'),
        e('INTERNAL_ROUTE_STARTED', 2, 'main-staff', { from_office_id: MAIN, to_office_id: U1 }),
        e('RECEIVED', 5, 'u1-staff'),
        e('INTERNAL_ROUTE_MOVED', 20, 'u1-staff', { from_office_id: U1, to_office_id: U2 }),
        e('RECEIVED', 25, 'u2-staff'),
        e('INTERNAL_ROUTE_COMPLETED', 40, 'u2-staff', { from_office_id: U2, to_office_id: MAIN }),
      ]),
    )
    const units = stints.filter((s) => s.kind === 'UNIT')
    assert.deepEqual(units.map((u) => [u.officeId, u.receivedBy, u.outcome, u.nextOfficeId]), [
      [U1, 'u1-staff', 'MOVED', U2],
      [U2, 'u2-staff', 'RETURNED_TO_OFFICE', MAIN],
    ])
    assert.equal(stints.find((s) => s.kind === 'STEP')!.outcome, null, 'back at the office, not yet released')
  })

  it('an internal route ended early counts as returned to the office', () => {
    const units = stintsOfVisit(visit([e('ARRIVED', 0), e('RECEIVED', 1), e('INTERNAL_ROUTE_STARTED', 2, 'x', { to_office_id: U1 }), e('INTERNAL_ROUTE_ENDED', 9, 'u', { from_office_id: U1 })])).filter((s) => s.kind === 'UNIT')
    assert.equal(units[0]!.outcome, 'RETURNED_TO_OFFICE')
    assert.equal(units[0]!.receivedAt, null, 'never received at the unit: no receipt is invented')
  })

  it('step 0 (the origin) is not received work', () => {
    assert.deepEqual(stintsOfVisit(visit([e('SUBMITTED', 0), e('PICKUP_REQUESTED', 1)], { step_number: 0 })), [])
  })

  it('missing timestamps: arrival falls back to the visit row; no receipt means no processing time', () => {
    const [s] = stintsOfVisit(visit([], { arrived_at: at(3) }))
    assert.equal(s!.arrivedAt, at(3))
    assert.equal(s!.receivedAt, null)
    const [none] = stintsOfVisit(visit([]))
    assert.equal(none!.arrivedAt, null)
  })
})

describe('metricsOf', () => {
  it('counts distinct documents, keeps completed apart from forwarded, and averages receipt → cleared', () => {
    const stints = [
      ...stintsOfVisit(visit([e('ARRIVED', 0), e('RECEIVED', 10, 'a'), e('PICKUP_REQUESTED', 40, 'a'), e('PICKED_UP', 45, 'l', { next_office_id: NEXT })], { document_id: 'd1' })),
      ...stintsOfVisit(visit([e('ARRIVED', 0), e('RECEIVED', 10, 'b'), e('APPROVED', 30, 'h')], { document_id: 'd2' })),
      ...stintsOfVisit(visit([e('ARRIVED', 0), e('RECEIVED', 20, 'a')], { document_id: 'd3' })),
    ]
    const m = metricsOf(stints, START)
    assert.equal(m.received, 3)
    assert.equal(m.forwarded, 1)
    assert.equal(m.completed, 1, 'only the approved one; the forwarded one is not completed')
    assert.equal(m.clearance_rate, round3(2 / 3))
    assert.equal(m.completion_rate, round3(1 / 3))
    assert.equal(m.avg_processing_minutes, 25, '(30 + 20) / 2; the open one has no time yet')
    assert.equal(m.processing_measured, 2)
    assert.equal(m.active_personnel, 3, 'a, b and h')
  })

  it('a send-back and its re-arrival, or a resubmission, do not count the document twice', () => {
    const stints = [
      ...stintsOfVisit(visit([e('ARRIVED', 0), e('RECEIVED', 1), e('SENT_BACK', 5, 'a', { send_back_to: 'prev' }), e('PICKED_UP', 6, 'l')], { document_id: 'd1' })),
      ...stintsOfVisit(visit([e('ARRIVED', 30), e('RECEIVED', 31), e('PICKUP_REQUESTED', 40), e('PICKED_UP', 41, 'l', { next_office_id: NEXT })], { document_id: 'd1' })),
      ...stintsOfVisit(visit([e('RESUBMITTED', 50), e('RECEIVED', 51)], { document_id: 'd1' })),
    ]
    const m = metricsOf(stints, START)
    assert.equal(m.received, 1)
    assert.equal(m.sent_back, 1)
    assert.equal(m.forwarded, 1)
  })

  it('an office with nothing in the period: zeros and nulls, not errors', () => {
    const m = metricsOf([], START)
    assert.deepEqual([m.received, m.completed, m.forwarded, m.clearance_rate, m.completion_rate, m.avg_processing_minutes, m.processing_measured], [0, 0, 0, null, null, null, 0])
  })

  it('activity before the period is left out', () => {
    const stints = stintsOfVisit(visit([e('ARRIVED', 0), e('RECEIVED', 1), e('APPROVED', 2, 'h')]))
    const m = metricsOf(stints, new Date(at(10)).getTime())
    assert.deepEqual([m.received, m.completed, m.avg_processing_minutes], [0, 0, null])
  })

  it('a receipt time after the clearance (clock skew) is not averaged', () => {
    const stints = stintsOfVisit(visit([e('ARRIVED', 0), e('PICKUP_REQUESTED', 5), e('RECEIVED', 9)]))
    assert.equal(metricsOf(stints, START).processing_measured, 0)
  })
})

function round3(n: number) {
  return Math.round(n * 1000) / 1000
}
