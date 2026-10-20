/**
 * QR access, issue input and return-pickup liaisons, without a database (models stubbed):
 *
 *   npm run test:qr-issue-return
 *
 * The same rules against a running app: tests/qr-issue-return-api.test.ts.
 */
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { canAccessQr, receivedAtHolder, routingSlipOf } from '../server/lib/qr-access.ts'
import { readIssueInput } from '../server/lib/issues.ts'
import { availableActions, returnLiaisons } from '../server/lib/documents.ts'
import { Liaison, Office, User, sequelize } from '../server/lib/models.ts'
import { ISSUE_CATEGORIES, ISSUE_CATEGORY_META, priorityOf } from '../shared/issue-categories.ts'

const ORG = 'org-1'
const at = (i: number) => new Date(Date.UTC(2026, 9, 20, 1, 0, i)).toISOString()
const log = (...types: string[]) => JSON.stringify(types.map((type, i) => ({ id: `e${i}`, type, at: at(i), by: 'x', status: 'ARRIVED_AT_OFFICE' })))
const visit = (types: string[], extra: Record<string, unknown> = {}) => ({ notes: log(...types), handler_id: null, liaison_id: null, ...extra }) as any
const doc = (extra: Record<string, unknown> = {}) =>
  ({ id: 'd', org_id: ORG, status: 'ARRIVED_AT_OFFICE', submitted_by: 'uploader', current_office_id: 'hr', current_step_number: 2, ...extra }) as any
const user = (id: string, account_type: string, office_id: string | null) => ({ id, org_id: ORG, account_type, office_id, permissions: null, assigned_by: null }) as any
const facts = (d: any, v: any, incomingHere = false) => ({ doc: d, visit: v, incomingHere })

describe('received at the current holder', () => {
  it('an arrival with its receipt counts; a hand-over without one does not', () => {
    assert.equal(receivedAtHolder(visit(['ARRIVED', 'RECEIVED'])), true)
    assert.equal(receivedAtHolder(visit(['ARRIVED', 'RECEIVED', 'PASSED_TO_STAFF'])), true, 'a desk-to-desk pass keeps it received in the office')
    assert.equal(receivedAtHolder(visit(['ARRIVED', 'RECEIVED', 'HANDED_TO_UMBRELLA'])), false, 'handed to a unit, not scanned in there')
    assert.equal(receivedAtHolder(visit(['ARRIVED', 'RECEIVED', 'HANDED_TO_UMBRELLA', 'RECEIVED'])), true)
    assert.equal(receivedAtHolder(visit(['ARRIVED', 'RECEIVED', 'INTERNAL_ROUTE_STARTED', 'RECEIVED', 'INTERNAL_ROUTE_MOVED'])), false)
    assert.equal(receivedAtHolder(visit(['ARRIVED', 'RECEIVED', 'INTERNAL_ROUTE_COMPLETED'])), false, 'back at the office: scanned in again first')
    assert.equal(receivedAtHolder(visit(['ARRIVED', 'RECEIVED', 'DELIVERY_FAILED'])), false)
    assert.equal(receivedAtHolder(null), false)
  })
})

describe('who may see the QR code', () => {
  const received = visit(['ARRIVED', 'RECEIVED'])
  it('the office holding it, once received; not before', () => {
    assert.equal(canAccessQr(user('s', 'STAFF', 'hr'), facts(doc(), received)), true)
    assert.equal(canAccessQr(user('h', 'DEPARTMENT_HEAD', 'hr'), facts(doc(), received)), true)
    assert.equal(canAccessQr(user('s', 'STAFF', 'hr'), facts(doc(), visit(['RETURNED_FROM_UMBRELLA']))), false)
  })
  it('the destination never while it is on its way — not even its uploader', () => {
    const carried = doc({ status: 'IN_TRANSIT', current_office_id: 'hr' })
    assert.equal(canAccessQr(user('r', 'STAFF', 'rec'), facts(carried, received, true)), false)
    assert.equal(canAccessQr(user('uploader', 'STAFF', 'rec'), facts(carried, received, true)), false)
    assert.equal(canAccessQr(user('s', 'STAFF', 'hr'), facts(carried, received)), true, 'the sending office keeps it')
  })
  it('during an internal route: the unit that received it, not a sibling unit, not the parent office', () => {
    const atUnit = doc({ current_office_id: 'u1' })
    const scannedAtUnit = visit(['ARRIVED', 'RECEIVED', 'INTERNAL_ROUTE_STARTED', 'RECEIVED'], { office_id: 'hr' })
    assert.equal(canAccessQr(user('a', 'STAFF', 'u1'), facts(atUnit, scannedAtUnit)), true)
    assert.equal(canAccessQr(user('b', 'STAFF', 'u2'), facts(atUnit, scannedAtUnit)), false, 'sibling umbrella office')
    assert.equal(canAccessQr(user('h', 'DEPARTMENT_HEAD', 'hr'), facts(atUnit, scannedAtUnit)), false, 'the parent office while a unit has it')
    const notYet = visit(['ARRIVED', 'RECEIVED', 'INTERNAL_ROUTE_STARTED'], { office_id: 'hr' })
    assert.equal(canAccessQr(user('a', 'STAFF', 'u1'), facts(atUnit, notYet)), false, 'the unit before scanning it in')
  })
  it('the creator, the messenger carrying it, the admin; nobody else', () => {
    assert.equal(canAccessQr(user('uploader', 'STAFF', 'other'), facts(doc(), received)), true)
    assert.equal(canAccessQr(user('m', 'LIAISON', 'hr'), facts(doc({ status: 'IN_TRANSIT' }), visit(['PICKED_UP'], { liaison_id: 'm' }))), true)
    assert.equal(canAccessQr(user('m2', 'LIAISON', 'hr'), facts(doc({ status: 'IN_TRANSIT' }), visit(['PICKED_UP'], { liaison_id: 'm' }))), false)
    assert.equal(canAccessQr(user('a', 'ADMIN', null), facts(doc(), received)), true)
    assert.equal(canAccessQr(user('x', 'STAFF', 'elsewhere'), facts(doc(), received)), false)
    assert.equal(canAccessQr({ ...user('a', 'ADMIN', null), org_id: 'other-org' }, facts(doc(), received)), false)
  })
  it('a draft only to its uploader; at the origin the origin office; a completed one the last office', () => {
    assert.equal(canAccessQr(user('s', 'STAFF', 'hr'), facts(doc({ status: 'CREATED' }), null)), false)
    assert.equal(canAccessQr(user('uploader', 'STAFF', 'hr'), facts(doc({ status: 'CREATED' }), null)), true)
    assert.equal(canAccessQr(user('s', 'STAFF', 'hr'), facts(doc({ status: 'START', current_step_number: 0 }), visit(['SUBMITTED']))), true)
    assert.equal(canAccessQr(user('s', 'STAFF', 'hr'), facts(doc({ status: 'COMPLETED' }), received)), true)
    assert.equal(canAccessQr(user('s', 'STAFF', 'hr'), facts(doc({ status: 'RETURNED' }), received)), false)
  })
})

describe('issue input: the priority follows the category', () => {
  it('every category has a priority (the agreed mapping)', () => {
    assert.deepEqual(Object.fromEntries(ISSUE_CATEGORIES.map((c) => [c, priorityOf(c)])), {
      MISSING_DOCUMENT: 'HIGH',
      DELAY: 'MEDIUM',
      DAMAGE: 'HIGH',
      INCORRECT_ROUTING: 'MEDIUM',
      SYSTEM: 'MEDIUM',
      OTHER: 'MEDIUM',
    })
    assert.ok(ISSUE_CATEGORIES.every((c) => ISSUE_CATEGORY_META[c].label))
  })
  it('a priority from the browser is ignored', () => {
    assert.equal(readIssueInput({ title: 'Missing page', category: 'DELAY', severity: 'CRITICAL', priority: 'CRITICAL' }).priority, 'MEDIUM')
    assert.equal(readIssueInput({ title: 'x', category: 'missing_document' }).priority, 'HIGH')
  })
  it('the category is required and must be known', () => {
    assert.throws(() => readIssueInput({ title: 'x' }), /category is required/)
    assert.throws(() => readIssueInput({ title: 'x', category: 'URGENT' }), /category must be one of/)
  })
  it('"Other" needs a real description; the others don’t', () => {
    assert.throws(() => readIssueInput({ title: 'x', category: 'OTHER' }), /Describe what’s wrong/)
    assert.throws(() => readIssueInput({ title: 'x', category: 'OTHER', description: '   \n ' }), /Describe what’s wrong/)
    assert.equal(readIssueInput({ title: 'x', category: 'OTHER', description: '  Wrong form  ' }).description, 'Wrong form')
    assert.equal(readIssueInput({ title: 'x', category: 'DAMAGE' }).description, null)
    assert.throws(() => readIssueInput({ title: 'x', category: 'OTHER', description: 'a'.repeat(5001) }), /5000/)
  })
})

describe('routing slip table', () => {
  it('from what was registered: origin, the route’s first and last office, registration time', () => {
    const slip = routingSlipOf(
      { title: 'Leave form', document_type: 'Leave Application', priority: 'HIGH', created_at: '2026-10-20T00:15:00.000Z', origin: { name: 'HR Office' }, submitter: { first_name: 'Ana', last_name: 'Cruz' } },
      { steps: [{ step_number: 2, office: { name: 'Budget' } }, { step_number: 1, office: { name: 'Records' } }, { step_number: 3, office: { name: 'Mayor' } }] },
    )
    assert.deepEqual(slip, {
      subject: 'Leave form',
      document_type: 'Leave Application',
      origin_office: 'HR Office',
      first_destination: 'Records',
      final_destination: 'Mayor',
      priority: 'HIGH',
      registered_by: 'Ana Cruz',
      registered_at: '2026-10-20T00:15:00.000Z',
    })
  })
  it('missing values stay empty instead of breaking', () => {
    const slip = routingSlipOf({ title: 'x', priority: 'NORMAL' }, null)
    assert.equal(slip.first_destination, null)
    assert.equal(slip.registered_by, null)
    assert.equal(slip.document_type, null)
  })
})

describe('return pickups', () => {
  it('liaisons of the office it goes back to and its units; the uploader’s unit first, then free, fewest deliveries', async (t) => {
    t.mock.method(Office, 'findAll', async () => [{ id: 'hr-u1' }])
    t.mock.method(User, 'findAll', async () => [
      { id: 'a', first_name: 'Ana', last_name: 'A', office_id: 'hr', office: { id: 'hr', name: 'HR' } },
      { id: 'b', first_name: 'Ben', last_name: 'B', office_id: 'hr-u1', office: { id: 'hr-u1', name: 'HR Unit' } },
      { id: 'c', first_name: 'Cy', last_name: 'C', office_id: 'hr', office: { id: 'hr', name: 'HR' } },
      { id: 'd', first_name: 'Di', last_name: 'D', office_id: 'hr-u1', office: { id: 'hr-u1', name: 'HR Unit' } },
      { id: 'e', first_name: 'Ed', last_name: 'E', office_id: 'hr', office: { id: 'hr', name: 'HR' } },
    ])
    t.mock.method(Liaison, 'findAll', async () => [
      { user_id: 'a', available: true, deliveries_today: 3 },
      { user_id: 'b', available: true, deliveries_today: 0 },
      { user_id: 'c', available: true, deliveries_today: 1 },
      { user_id: 'd', available: false, deliveries_today: 0 },
      // e has no messenger profile: not offered
    ])
    t.mock.method(sequelize, 'query', async () => [{ id: 'b', n: 1 }])
    const list = await returnLiaisons(ORG, 'hr', 'hr-u1')
    // The uploader's unit first (b busy, d off duty), then the office: c (1 delivery) before a (3).
    assert.deepEqual(list.map((l) => l.id), ['b', 'd', 'c', 'a'])
    assert.deepEqual(list.filter((l) => l.recommended).map((l) => l.id), ['c'], 'nobody in the uploader’s unit is free: the first free one of the office')
    assert.equal(list.find((l) => l.id === 'b')!.uploader_unit, true)
  })

  it('buttons: the office cancels an open return; an eligible liaison claims; the claimer may give it up', () => {
    const d = doc({ current_office_id: 'rec' })
    const ctx = { received: true, handlerId: 'r', visitLiaisonId: null, isFinalStep: false, nextOfficeId: 'hr', passedBy: null, pendingApproval: null, sendingBack: true, returnOpen: true }
    const holder = availableActions(d, user('r', 'STAFF', 'rec'), ctx)
    assert.equal(holder.canCancelPickup, true)
    assert.equal(holder.canRequestPickup || holder.canSendBack || holder.canPassToStaff || holder.canReassign, false)
    assert.equal(availableActions(d, user('m', 'LIAISON', 'hr'), { ...ctx, returnEligible: true }).canClaimReturn, true)
    assert.equal(availableActions(d, user('m', 'LIAISON', 'other'), { ...ctx, returnEligible: false }).canClaimReturn, false)
    const claimed = { ...ctx, returnOpen: false, visitLiaisonId: 'm' }
    assert.equal(availableActions(d, user('m', 'LIAISON', 'hr'), claimed).canReleaseReturnClaim, true)
    assert.equal(availableActions(d, user('m2', 'LIAISON', 'hr'), claimed).canReleaseReturnClaim, false)
  })
})
