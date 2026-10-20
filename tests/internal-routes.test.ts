/**
 * Internal routes, without a database (models stubbed):
 *
 *   npm run test:internal-routes
 *
 * Step validation (readInternalSteps), who may manage routes (requireInternalRouteManager), whose routes an
 * account may read (readableOfficeId), and the document buttons (availableActions). The whole lifecycle
 * against a running app is in tests/office-workflow-api.test.ts.
 */
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { readInternalSteps, readableOfficeId, requireInternalRouteManager } from '../server/lib/internal-routes.ts'
import { availableActions } from '../server/lib/documents.ts'
import { Office } from '../server/lib/models.ts'
import { DH_PERMISSIONS, MAIN_OFFICE_ONLY } from '../shared/dh-permissions.ts'

const ORG = 'org-1'
const HR = { id: 'hr', org_id: ORG, parent_office_id: null, status: 'active' }
const U1 = { id: 'u1', org_id: ORG, parent_office_id: 'hr', status: 'active', name: 'Unit 1' }
const U2 = { id: 'u2', org_id: ORG, parent_office_id: 'hr', status: 'active', name: 'Unit 2' }
const OFF = { id: 'off', org_id: ORG, parent_office_id: 'hr', status: 'inactive', name: 'Old unit' }
const REC_UNIT = { id: 'ru', org_id: ORG, parent_office_id: 'rec', status: 'active', name: 'Records unit' }
const user = (id: string, account_type: string, office: any, extra: Record<string, unknown> = {}) =>
  ({ id, org_id: ORG, account_type, office_id: office?.id ?? null, office, status: 'active', page_access: null, assigned_by: null, permissions: null, ...extra }) as any

describe('the permission', () => {
  it('"Manage internal routes" exists and is for main offices only', () => {
    assert.ok(DH_PERMISSIONS.includes('MANAGE_INTERNAL_ROUTES'))
    assert.ok(MAIN_OFFICE_ONLY.includes('MANAGE_INTERNAL_ROUTES'))
  })
})

describe('who manages and who reads internal routes', () => {
  it('the managing head of a main office manages them; a delegate only with the permission', () => {
    assert.equal(requireInternalRouteManager(user('m', 'DEPARTMENT_HEAD', HR)).id, 'hr')
    assert.throws(() => requireInternalRouteManager(user('d', 'DEPARTMENT_HEAD', HR, { assigned_by: 'm', permissions: '["UMBRELLA_HANDOFF"]' })), /Manage internal routes/)
    assert.equal(requireInternalRouteManager(user('d', 'DEPARTMENT_HEAD', HR, { assigned_by: 'm', permissions: '["MANAGE_INTERNAL_ROUTES"]' })).id, 'hr')
  })
  it('never an umbrella office, staff, or the admin', () => {
    assert.throws(() => requireInternalRouteManager(user('uh', 'DEPARTMENT_HEAD', U1)), /umbrella office/)
    assert.throws(() => requireInternalRouteManager(user('s', 'STAFF', HR)), /Department Head/)
    assert.throws(() => requireInternalRouteManager(user('a', 'ADMIN', null)), /Department Head/)
  })
  it('reading: a head its own office, an umbrella head its parent, the admin any office; nobody picks another office', () => {
    assert.deepEqual(readableOfficeId(user('m', 'DEPARTMENT_HEAD', HR), 'rec'), { officeId: 'hr' })
    assert.deepEqual(readableOfficeId(user('uh', 'DEPARTMENT_HEAD', U1), null), { officeId: 'hr' })
    assert.deepEqual(readableOfficeId(user('a', 'ADMIN', null), 'rec'), { officeId: 'rec' })
    assert.throws(() => readableOfficeId(user('s', 'STAFF', HR), null), /Department Heads/)
  })
})

describe('internal route steps (models stubbed)', () => {
  const stub = (t: any) => t.mock.method(Office, 'findAll', async ({ where }: any) => [U1, U2, OFF, REC_UNIT].filter((o) => where.id[Object.getOwnPropertySymbols(where.id)[0]!].includes(o.id)))
  it('accepts 2+ active umbrella offices of the office, in order', async (t) => {
    stub(t)
    assert.deepEqual(await readInternalSteps(ORG, 'hr', [{ office_id: 'u2', action_label: ' Check ' }, { office_id: 'u1' }]), [
      { office_id: 'u2', action_label: 'Check', step_number: 1 },
      { office_id: 'u1', action_label: null, step_number: 2 },
    ])
  })
  it('refuses one step, repeats, other offices, other offices’ units, inactive units, and garbage', async (t) => {
    stub(t)
    await assert.rejects(readInternalSteps(ORG, 'hr', [{ office_id: 'u1' }]), /at least 2/)
    await assert.rejects(readInternalSteps(ORG, 'hr', [{ office_id: 'u1' }, { office_id: 'u2' }, { office_id: 'u1' }]), /only once/)
    await assert.rejects(readInternalSteps(ORG, 'hr', [{ office_id: 'u1' }, { office_id: 'ru' }]), /not an umbrella office of your office/)
    await assert.rejects(readInternalSteps(ORG, 'hr', [{ office_id: 'u1' }, { office_id: 'nope' }]), /not an umbrella office of your office/)
    await assert.rejects(readInternalSteps(ORG, 'hr', [{ office_id: 'u1' }, { office_id: 'off' }]), /deactivated/)
    await assert.rejects(readInternalSteps(ORG, 'hr', 'u1,u2'), /must be a list/)
    await assert.rejects(readInternalSteps(ORG, 'hr', [{ office_id: 'u1' }, {}]), /needs an umbrella office/)
    await assert.rejects(readInternalSteps(ORG, 'hr', Array.from({ length: 11 }, (_, i) => ({ office_id: `x${i}` }))), /at most 10/)
  })
})

describe('document buttons for internal routes', () => {
  const ctx = (handlerId: string, extra = {}) => ({ received: true, handlerId, visitLiaisonId: null, isFinalStep: false, nextOfficeId: 'rec', passedBy: null, pendingApproval: null, ...extra })
  const atHr = { id: 'doc', org_id: ORG, status: 'ARRIVED_AT_OFFICE', current_step_number: 1, current_office_id: 'hr', submitted_by: 'x' }
  const atU1 = { ...atHr, current_office_id: 'u1' }
  const staff = user('st', 'STAFF', HR)
  const unitStaff = user('us', 'STAFF', U1)

  it('the office’s receiver may start one when the office has routes and nothing else is going on', () => {
    assert.equal(availableActions(atHr, staff, ctx('st', { internalRouteCount: 1 })).canStartInternalRoute, true)
    assert.equal(availableActions(atHr, staff, ctx('st', { internalRouteCount: 0 })).canStartInternalRoute, false)
    assert.equal(availableActions(atHr, staff, ctx('other', { internalRouteCount: 1 })).canStartInternalRoute, false)
    assert.equal(availableActions(atHr, staff, ctx('st', { internalRouteCount: 1, visitLiaisonId: 'm' })).canStartInternalRoute, false)
    assert.equal(availableActions(atHr, staff, ctx('st', { internalRouteCount: 1, passedBy: 'p' })).canStartInternalRoute, false)
    assert.equal(availableActions(atHr, staff, ctx('st', { internalRouteCount: 1, internalActive: true })).canStartInternalRoute, false)
    const noPerm = user('d', 'DEPARTMENT_HEAD', HR, { assigned_by: 'm', permissions: '["RECEIVE_DOCUMENTS"]' })
    assert.equal(availableActions(atHr, noPerm, ctx('d', { internalRouteCount: 1 })).canStartInternalRoute, false)
  })
  it('at a unit on the route: pass on (or end early), nothing that leaves the office', () => {
    const a = availableActions(atU1, unitStaff, ctx('us', { atUnit: true, internalActive: true, umbrellaCount: 1, internalRouteCount: 1 }))
    assert.equal(a.canAdvanceInternalRoute, true)
    assert.equal(a.canReturnFromUmbrella, true)
    assert.equal(a.canRequestPickup || a.canSendBack || a.canApprove || a.canHandToUmbrella || a.canStartInternalRoute, false)
  })
  it('a plain hand-off is not an internal route: no "pass on" there', () => {
    assert.equal(availableActions(atU1, unitStaff, ctx('us', { atUnit: true, internalActive: false })).canAdvanceInternalRoute, false)
  })
  it('a unit member who did not receive it, or the office’s staff, cannot move it', () => {
    assert.equal(availableActions(atU1, unitStaff, ctx('someone', { atUnit: true, internalActive: true })).canAdvanceInternalRoute, false)
    assert.equal(availableActions(atU1, staff, ctx('us', { atUnit: true, internalActive: true })).canAdvanceInternalRoute, false)
  })
})
