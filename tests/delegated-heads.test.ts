/**
 * Delegated Department Head permissions, without a database (no model is called).
 *
 *   npm run test:delegated-heads
 *
 * The rules the server enforces (server/lib/dh-access.ts, team.ts, documents.ts availableActions):
 * managing heads hold every permission; delegates only what was granted; nobody grants what they
 * don't hold; delegates can't touch managing heads or delegates they didn't assign; other roles are
 * unchanged. tests/delegated-heads-api.test.ts checks the same against a running app.
 */
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { cascadeToDelegates, effectivePermissions, hasPermission, isDelegatedHead, readGrantedPermissions, requirePermission } from '../server/lib/dh-access.ts'
import { canManageMember, managedTypesOf } from '../server/lib/team.ts'
import { approverIds, atUnit, availableActions } from '../server/lib/documents.ts'
import { sortVisits } from '../server/lib/tracking-log.ts'
import { DepartmentHeadAssignment, User } from '../server/lib/models.ts'
import { DH_PERMISSIONS, parsePermissions } from '../shared/dh-permissions.ts'

const ORG = 'org-1'
const CHO = { id: 'cho', org_id: ORG, parent_office_id: null, status: 'active', is_final_checkpoint: false }
const SNTR = { id: 'sntr', org_id: ORG, parent_office_id: 'cho', status: 'active', is_final_checkpoint: false }
const HR = { id: 'hr', org_id: ORG, parent_office_id: null, status: 'active', is_final_checkpoint: false }
const user = (id: string, account_type: string, office: any, extra: Record<string, unknown> = {}) =>
  ({ id, org_id: ORG, account_type, office_id: office?.id ?? null, office, status: 'active', page_access: null, assigned_by: null, permissions: null, ...extra }) as any

const managing = user('m', 'DEPARTMENT_HEAD', CHO)
const delegate = (perms: string[], office: any = SNTR, extra = {}) => user(`d-${perms.join('-') || 'none'}`, 'DEPARTMENT_HEAD', office, { assigned_by: 'm', permissions: JSON.stringify(perms), ...extra })

describe('who holds which permission', () => {
  it('a managing Department Head holds every permission; other roles are not limited', () => {
    assert.deepEqual(effectivePermissions(managing), [...DH_PERMISSIONS])
    assert.equal(isDelegatedHead(managing), false)
    for (const role of ['ADMIN', 'STAFF', 'LIAISON']) {
      assert.equal(effectivePermissions(user('x', role, CHO)), null)
      assert.equal(hasPermission(user('x', role, CHO), 'DECIDE_APPROVALS'), true, role)
    }
  })

  it('a delegate holds only what was granted — nothing by default', () => {
    assert.deepEqual(effectivePermissions(delegate([])), [])
    assert.deepEqual(effectivePermissions(delegate(['RECEIVE_DOCUMENTS'])), ['RECEIVE_DOCUMENTS'])
    assert.deepEqual(effectivePermissions(user('d', 'DEPARTMENT_HEAD', SNTR, { assigned_by: 'm', permissions: null })), [])
    assert.throws(() => requirePermission(delegate([]), 'MANAGE_UMBRELLAS'), /Manage umbrella offices/)
    // Unknown or tampered values in the stored list are dropped.
    assert.deepEqual(parsePermissions('["RECEIVE_DOCUMENTS","SUPERPOWER"]'), ['RECEIVE_DOCUMENTS'])
    assert.deepEqual(parsePermissions('not json'), [])
  })
})

describe('granting permissions', () => {
  it('the managing head grants any of them; the list is kept in a fixed order', () => {
    assert.deepEqual(readGrantedPermissions({ permissions: ['ASSIGN_HEADS', 'RECEIVE_DOCUMENTS'] }, managing, CHO), ['RECEIVE_DOCUMENTS', 'ASSIGN_HEADS'])
    assert.deepEqual(readGrantedPermissions({}, managing, CHO), [])
  })

  it('nobody grants a permission they do not hold', () => {
    const d = delegate(['RECEIVE_DOCUMENTS', 'ASSIGN_HEADS'], CHO)
    assert.deepEqual(readGrantedPermissions({ permissions: ['RECEIVE_DOCUMENTS'] }, d, CHO), ['RECEIVE_DOCUMENTS'])
    assert.throws(() => readGrantedPermissions({ permissions: ['DECIDE_APPROVALS'] }, d, CHO), /your own account doesn’t have it/)
  })

  it('umbrella management only for a main office; unknown names refused', () => {
    assert.throws(() => readGrantedPermissions({ permissions: ['MANAGE_UMBRELLAS'] }, managing, SNTR), /main office/)
    assert.deepEqual(readGrantedPermissions({ permissions: ['MANAGE_UMBRELLAS'] }, managing, CHO), ['MANAGE_UMBRELLAS'])
    assert.throws(() => readGrantedPermissions({ permissions: ['ADMIN'] }, managing, CHO), /Unknown permission/)
    assert.throws(() => readGrantedPermissions({ permissions: 'ALL' }, managing, CHO), /must be a list/)
  })
})

describe('managing accounts', () => {
  it('a delegate may add only what its permissions allow — no heads by default', () => {
    assert.deepEqual([...managedTypesOf(managing)!], ['STAFF', 'LIAISON', 'DEPARTMENT_HEAD'])
    assert.deepEqual([...managedTypesOf(delegate(['RECEIVE_DOCUMENTS']))!], [])
    assert.deepEqual([...managedTypesOf(delegate(['MANAGE_TEAM']))!], ['STAFF', 'LIAISON'])
    assert.deepEqual([...managedTypesOf(delegate(['ASSIGN_HEADS']))!], ['DEPARTMENT_HEAD'])
  })

  it('managing head: its delegates in the office and umbrellas, never another managing head', () => {
    assert.equal(canManageMember(managing, delegate([], SNTR)), true)
    assert.equal(canManageMember(managing, delegate([], CHO)), true)
    assert.equal(canManageMember(managing, user('m2', 'DEPARTMENT_HEAD', CHO)), false)
    assert.equal(canManageMember(managing, delegate([], HR)), false, 'another office')
    assert.equal(canManageMember(managing, { ...delegate([], SNTR), org_id: 'org-2' }), false, 'another organization')
  })

  it("a delegate with Assign heads manages only the delegates it assigned itself, never its grantor or itself", () => {
    const d = user('d1', 'DEPARTMENT_HEAD', CHO, { assigned_by: 'm', permissions: JSON.stringify(['ASSIGN_HEADS', 'MANAGE_TEAM']) })
    assert.equal(canManageMember(d, user('d2', 'DEPARTMENT_HEAD', SNTR, { assigned_by: 'd1' })), true)
    assert.equal(canManageMember(d, user('d3', 'DEPARTMENT_HEAD', SNTR, { assigned_by: 'm' })), false, "the managing head's delegate")
    assert.equal(canManageMember(d, managing), false, 'its grantor')
    assert.equal(canManageMember(d, d), false, 'itself')
    assert.equal(canManageMember(d, user('s', 'STAFF', SNTR)), true, 'staff with Manage team')
  })

  it('an umbrella delegate manages only its own umbrella', () => {
    const d = user('du', 'DEPARTMENT_HEAD', SNTR, { assigned_by: 'm', permissions: JSON.stringify(['MANAGE_TEAM']) })
    assert.equal(canManageMember(d, user('s', 'STAFF', SNTR)), true)
    assert.equal(canManageMember(d, user('s2', 'STAFF', CHO)), false, 'the main office')
  })
})

describe('document buttons follow the permissions (the server checks the same in each command)', () => {
  // A document received at the umbrella office, released to nobody yet, not at the last step.
  const doc = { id: 'doc', org_id: ORG, status: 'ARRIVED_AT_OFFICE', current_step_number: 2, current_office_id: 'sntr', submitted_by: 'someone' }
  const ctx = (handlerId: string) => ({ received: true, handlerId, visitLiaisonId: null, isFinalStep: false, nextOfficeId: 'hr', passedBy: null, pendingApproval: null })

  it('granted actions show; ungranted ones do not', () => {
    const d = delegate(['RELEASE_DOCUMENTS'])
    const a = availableActions(doc, d, ctx(d.id))
    assert.equal(a.canRequestPickup, true)
    assert.equal(a.canPassToStaff, false)
    assert.equal(a.canSendBack, false)
  })

  it('with no permissions, a delegate only views', () => {
    const d = delegate([])
    const a = availableActions(doc, d, ctx(d.id))
    assert.deepEqual(Object.entries(a).filter(([, v]) => v).map(([k]) => k), [])
  })

  it('the managing head and staff keep every action they had', () => {
    const staff = user('st', 'STAFF', SNTR)
    for (const actor of [user('mh', 'DEPARTMENT_HEAD', SNTR), staff]) {
      const a = availableActions(doc, actor, ctx(actor.id))
      assert.equal(a.canRequestPickup && a.canPassToStaff && a.canSendBack, true, actor.account_type)
    }
  })

  it('permissions never open another office: a delegate of the main office gets nothing on an umbrella document', () => {
    const d = delegate([...DH_PERMISSIONS], CHO)
    const a = availableActions(doc, d, ctx(d.id))
    assert.equal(a.canRequestPickup || a.canPassToStaff || a.canSendBack || a.canScanReceive, false)
  })
})

describe('umbrella offices are units: a hand-off inside the route step', () => {
  const ctx = (handlerId: string, extra = {}) => ({ received: true, handlerId, visitLiaisonId: null, isFinalStep: false, nextOfficeId: 'hr', passedBy: null, pendingApproval: null, ...extra })
  // Step 2 belongs to the CHO; the document is either at the CHO or handed to its unit SNTR.
  const atCho = { id: 'doc', org_id: ORG, status: 'ARRIVED_AT_OFFICE', current_step_number: 2, current_office_id: 'cho', submitted_by: 'someone' }
  const atSntr = { ...atCho, current_office_id: 'sntr' }
  const visit = { office_id: 'cho' }

  it('atUnit: only when the document is with a unit of the step’s office — never at the origin or on a legacy umbrella step', () => {
    assert.equal(atUnit(atSntr, visit), true)
    assert.equal(atUnit(atCho, visit), false)
    assert.equal(atUnit({ ...atSntr, current_step_number: 0 }, { office_id: 'cho' }), false)
    assert.equal(atUnit(atSntr, { office_id: 'sntr' }), false) // a route step that is itself the umbrella (legacy)
    assert.equal(atUnit(atSntr, null), false)
  })

  it('the office’s receiver may hand off only with the permission, an umbrella to hand to, and no messenger or pending pass', () => {
    const staff = user('st', 'STAFF', CHO)
    assert.equal(availableActions(atCho, staff, ctx('st', { umbrellaCount: 1 })).canHandToUmbrella, true)
    assert.equal(availableActions(atCho, staff, ctx('st', { umbrellaCount: 0 })).canHandToUmbrella, false)
    assert.equal(availableActions(atCho, staff, ctx('other', { umbrellaCount: 1 })).canHandToUmbrella, false)
    assert.equal(availableActions(atCho, staff, ctx('st', { umbrellaCount: 1, visitLiaisonId: 'msg' })).canHandToUmbrella, false)
    assert.equal(availableActions(atCho, staff, ctx('st', { umbrellaCount: 1, passedBy: 'x' })).canHandToUmbrella, false)
    const without = delegate(['RECEIVE_DOCUMENTS', 'RELEASE_DOCUMENTS'], CHO)
    assert.equal(availableActions(atCho, without, ctx(without.id, { umbrellaCount: 1 })).canHandToUmbrella, false)
    const withIt = delegate(['UMBRELLA_HANDOFF'], CHO)
    assert.equal(availableActions(atCho, withIt, ctx(withIt.id, { umbrellaCount: 1 })).canHandToUmbrella, true)
  })

  it('at the unit: return only; no release, send-back, approval or second hand-off', () => {
    const unitStaff = user('us', 'STAFF', SNTR)
    const a = availableActions(atSntr, unitStaff, ctx('us', { atUnit: true, umbrellaCount: 1, isFinalStep: true, pendingApproval: { id: 'ap' } }))
    assert.equal(a.canReturnFromUmbrella, true)
    assert.equal(a.canRequestPickup || a.canSendBack || a.canApprove || a.canHandToUmbrella, false)
    assert.equal(availableActions(atSntr, delegate(['RECEIVE_DOCUMENTS'], SNTR), ctx('d-RECEIVE_DOCUMENTS', { atUnit: true })).canReturnFromUmbrella, false)
    // Staff of the parent office can't act on it while the unit has it.
    const parentStaff = user('ps', 'STAFF', CHO)
    const p = availableActions(atSntr, parentStaff, ctx('us', { atUnit: true }))
    assert.equal(p.canRequestPickup || p.canSendBack || p.canReturnFromUmbrella || p.canPassToStaff, false)
  })
})

describe('visit order is deterministic', () => {
  const v = (id: string, step: number, created: string, firstEvent?: string) => ({ id, step_number: step, created_at: created, notes: firstEvent ? JSON.stringify([{ id: 'e', type: 'ARRIVED', at: firstEvent }]) : null }) as any
  it('orders by the millisecond event time, even when created_at ties at the second', () => {
    const sameSecond = '2026-10-20T08:00:00.000Z'
    const visits = [v('c', 3, sameSecond, '2026-10-20T08:00:00.900Z'), v('a', 1, sameSecond, '2026-10-20T08:00:00.100Z'), v('b', 2, sameSecond, '2026-10-20T08:00:00.500Z')]
    assert.deepEqual(sortVisits(visits).map((x) => x.id), ['a', 'b', 'c'])
  })
  it('falls back to created_at, then step, then id; never depends on input order', () => {
    const t = '2026-10-20T08:00:00.000Z'
    const visits = [v('z', 2, t), v('y', 1, t), v('x', 1, t), v('w', 1, '2026-10-20T07:59:59.000Z')]
    const expected = ['w', 'x', 'y', 'z']
    assert.deepEqual(sortVisits(visits).map((x) => x.id), expected)
    assert.deepEqual(sortVisits([...visits].reverse()).map((x) => x.id), expected)
  })
})

describe('least privilege down the chain (models stubbed — no database)', () => {
  it('a grantor’s lost permissions are removed from its delegates, recursively, each with a history note', async (t) => {
    const rows: Record<string, any> = {
      d1: { id: 'd1', org_id: ORG, office_id: 'sntr', full_name: 'Ana', assigned_by: 'g', permissions: JSON.stringify(['RECEIVE_DOCUMENTS', 'DECIDE_APPROVALS']) },
      d2: { id: 'd2', org_id: ORG, office_id: 'sntr', full_name: 'Ben', assigned_by: 'd1', permissions: JSON.stringify(['DECIDE_APPROVALS']) },
      d3: { id: 'd3', org_id: ORG, office_id: 'sntr', full_name: 'Cy', assigned_by: 'g', permissions: JSON.stringify(['RECEIVE_DOCUMENTS']) },
    }
    for (const r of Object.values(rows)) r.update = async (patch: any) => Object.assign(r, patch)
    t.mock.method(User, 'findAll', async ({ where }: any) => Object.values(rows).filter((r) => r.assigned_by === where.assigned_by))
    const history: any[] = []
    t.mock.method(DepartmentHeadAssignment, 'create', async (row: any) => history.push(row))

    const changed = await cascadeToDelegates({ id: 'g', name: 'Grace' }, ['RECEIVE_DOCUMENTS'], 'admin')
    assert.equal(changed, 2) // d1 and (through it) d2; d3 already within
    assert.deepEqual(JSON.parse(rows.d1.permissions), ['RECEIVE_DOCUMENTS'])
    assert.deepEqual(JSON.parse(rows.d2.permissions), [])
    assert.deepEqual(JSON.parse(rows.d3.permissions), ['RECEIVE_DOCUMENTS'])
    assert.deepEqual(history.map((h) => [h.user_id, h.action, h.changed_by]), [['d1', 'UPDATED', 'admin'], ['d2', 'UPDATED', 'admin']])
    assert.match(history[0].note, /Grace, who assigned this account, no longer has: Approve or return/)
    assert.match(history[1].note, /Ana/)
  })

  it('a demoted grantor (no permissions left) leaves its delegates with none', async (t) => {
    const d = { id: 'd', org_id: ORG, office_id: 'cho', full_name: 'D', assigned_by: 'g', permissions: JSON.stringify(['RECEIVE_DOCUMENTS']), update: async function (p: any) { Object.assign(this, p) } }
    t.mock.method(User, 'findAll', async ({ where }: any) => (where.assigned_by === 'g' ? [d] : []))
    t.mock.method(DepartmentHeadAssignment, 'create', async () => ({}))
    assert.equal(await cascadeToDelegates({ id: 'g', name: 'G' }, [], 'admin'), 1)
    assert.deepEqual(JSON.parse(d.permissions), [])
  })
})

describe('approval requests go only to those who may decide (models stubbed)', () => {
  it('approverIds skips delegates without "Approve or return"', async (t) => {
    t.mock.method(User, 'findAll', async () => [
      user('st', 'STAFF', CHO),
      user('mh', 'DEPARTMENT_HEAD', CHO),
      delegate(['DECIDE_APPROVALS'], CHO, { id: 'yes' }),
      delegate(['RECEIVE_DOCUMENTS'], CHO, { id: 'no' }),
    ])
    assert.deepEqual(await approverIds('cho'), ['st', 'mh', 'yes'])
    assert.deepEqual(await approverIds(null), [])
  })
})
