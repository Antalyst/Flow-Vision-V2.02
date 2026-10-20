/**
 * Role and session rules, without a database or a running app (the model lookups are mocked).
 *
 *   npm run test:roles
 *
 * Covers: the stored role values, where the signed-in user's role comes from (the database row,
 * never the request), refusing accounts with an unknown or blank role, session validation, and
 * the permission boundaries of ADMIN, DEPARTMENT_HEAD, STAFF and LIAISON.
 * tests/roles-api.test.ts checks the same rules end to end against a running app.
 */
import { afterEach, describe, it, mock } from 'node:test'
import assert from 'node:assert/strict'
import { ACCOUNT_TYPES, AuthSession, User } from '../server/lib/models.ts'
import { hasApprovalAuthority, hasKnownRole, loadActor, resolveSession } from '../server/lib/auth.ts'
import { canManageMember, managedTypesOf, readPageAccess, requirePage } from '../server/lib/team.ts'
import { defaultScope, openableWhere, visibleWhere } from '../server/lib/document-queries.ts'
import { canOpenPage } from '../shared/page-access.ts'

const ORG = 'org-1'
const OTHER_ORG = 'org-2'
const person = (account_type: string, extra: Record<string, unknown> = {}) =>
  ({ id: `${account_type || 'blank'}-1`, org_id: ORG, office_id: 'office-a', status: 'active', page_access: null, account_type, office: null, ...extra }) as any

afterEach(() => mock.restoreAll())

describe('stored role values', () => {
  it('are exactly ADMIN, DEPARTMENT_HEAD, STAFF and LIAISON', () => {
    assert.deepEqual([...ACCOUNT_TYPES], ['ADMIN', 'DEPARTMENT_HEAD', 'STAFF', 'LIAISON'])
  })

  it('recognises only those values', () => {
    for (const role of ACCOUNT_TYPES) assert.equal(hasKnownRole(person(role)), true, role)
    for (const role of ['', 'CLIENT', 'EMPLOYEE', 'admin', 'SUPERADMIN', null, undefined]) {
      assert.equal(hasKnownRole(person(role as string)), false, String(role))
    }
  })

  it('every role has a default document scope', () => {
    for (const role of ACCOUNT_TYPES) assert.ok(defaultScope[role], role)
  })
})

describe('loadActor: the role comes from the database row', () => {
  it('returns the user with the role stored in the database', async () => {
    const lookup = mock.method(User, 'findByPk', async () => person('DEPARTMENT_HEAD'))
    const actor = await loadActor('DEPARTMENT_HEAD-1')
    assert.equal(actor?.account_type, 'DEPARTMENT_HEAD')
    // Looked up by id only: nothing the browser sends can choose the role.
    assert.equal(lookup.mock.calls[0]!.arguments[0], 'DEPARTMENT_HEAD-1')
  })

  for (const role of ['', 'CLIENT', 'EMPLOYEE', 'UNKNOWN']) {
    it(`refuses an account whose stored role is ${JSON.stringify(role)}`, async () => {
      mock.method(User, 'findByPk', async () => person(role))
      assert.equal(await loadActor('x'), null)
    })
  }

  it('refuses a suspended account and a missing one', async () => {
    mock.method(User, 'findByPk', async () => person('ADMIN', { status: 'inactive' }))
    assert.equal(await loadActor('x'), null)
    mock.restoreAll()
    mock.method(User, 'findByPk', async () => null)
    assert.equal(await loadActor('x'), null)
  })

  it('lets a pending account (temporary password) in', async () => {
    mock.method(User, 'findByPk', async () => person('STAFF', { status: 'pending' }))
    assert.equal((await loadActor('x'))?.account_type, 'STAFF')
  })
})

describe('resolveSession', () => {
  it('rejects a missing, empty or oversized token without touching the database', async () => {
    const lookup = mock.method(AuthSession, 'findOne', async () => {
      throw new Error('should not query')
    })
    assert.equal(await resolveSession(undefined), null)
    assert.equal(await resolveSession(''), null)
    assert.equal(await resolveSession('x'.repeat(129)), null)
    assert.equal(lookup.mock.callCount(), 0)
  })

  it('looks the token up by its SHA-256 hash, never the raw value, and only unexpired', async () => {
    const lookup = mock.method(AuthSession, 'findOne', async () => null)
    assert.equal(await resolveSession('raw-token'), null)
    const where = lookup.mock.calls[0]!.arguments[0]!.where as Record<string, any>
    assert.notEqual(where.token, 'raw-token')
    assert.match(where.token, /^[0-9a-f]{64}$/)
    assert.ok(where.expires_at, 'filters out expired sessions')
  })

  it('a valid session of an account with a blank role is not a session', async () => {
    mock.method(AuthSession, 'findOne', async () => ({ id: 's1', user_id: 'u1', expires_at: new Date(Date.now() + 86_400_000 * 30) }))
    mock.method(User, 'findByPk', async () => person(''))
    assert.equal(await resolveSession('raw-token'), null)
  })

  it('a valid session of an account with a known role resolves to it', async () => {
    const expires = new Date(Date.now() + 86_400_000 * 30)
    mock.method(AuthSession, 'findOne', async () => ({ id: 's1', user_id: 'u1', expires_at: expires, update: async () => {} }))
    mock.method(User, 'findByPk', async () => person('LIAISON'))
    const session = await resolveSession('raw-token')
    assert.equal(session?.actor.account_type, 'LIAISON')
    assert.equal(session?.sessionId, 's1')
  })
})

describe('approval authority', () => {
  const finalOffice = { is_final_checkpoint: true, status: 'active' }
  it('belongs to STAFF at an active final-checkpoint office only', () => {
    assert.equal(hasApprovalAuthority(person('STAFF', { office: finalOffice })), true)
    assert.equal(hasApprovalAuthority(person('STAFF', { office: { ...finalOffice, is_final_checkpoint: false } })), false)
    assert.equal(hasApprovalAuthority(person('STAFF', { office: { ...finalOffice, status: 'inactive' } })), false)
    for (const role of ['ADMIN', 'DEPARTMENT_HEAD', 'LIAISON']) assert.equal(hasApprovalAuthority(person(role, { office: finalOffice })), false, role)
  })
})

describe('account management boundaries', () => {
  it('who may create which accounts', () => {
    assert.equal(managedTypesOf(person('ADMIN')), null) // everyone in the organization
    // A Department Head also adds the head of each of its umbrella offices.
    assert.deepEqual([...managedTypesOf(person('DEPARTMENT_HEAD'))!], ['STAFF', 'LIAISON', 'DEPARTMENT_HEAD'])
    assert.deepEqual([...managedTypesOf(person('STAFF'))!], ['LIAISON'])
    assert.deepEqual([...managedTypesOf(person('LIAISON'))!], [])
  })

  it('ADMIN manages its own organization only', () => {
    const admin = person('ADMIN', { office_id: null })
    assert.equal(canManageMember(admin, person('DEPARTMENT_HEAD')), true)
    assert.equal(canManageMember(admin, person('DEPARTMENT_HEAD', { org_id: OTHER_ORG })), false)
  })

  it('a page-limited ADMIN cannot manage the unrestricted owner ADMIN', () => {
    const limited = person('ADMIN', { id: 'limited', office_id: null, page_access: JSON.stringify(['/client/accounts']) })
    const owner = person('ADMIN', { id: 'owner', office_id: null })
    assert.equal(canManageMember(limited, owner), false)
  })

  it('DEPARTMENT_HEAD manages STAFF and LIAISON of its own office only', () => {
    const head = person('DEPARTMENT_HEAD')
    assert.equal(canManageMember(head, person('STAFF')), true)
    assert.equal(canManageMember(head, person('LIAISON')), true)
    assert.equal(canManageMember(head, person('STAFF', { office_id: 'office-b' })), false, 'other office')
    assert.equal(canManageMember(head, person('DEPARTMENT_HEAD', { id: 'other-head' })), false, 'another head')
    assert.equal(canManageMember(head, person('ADMIN')), false, 'an admin')
  })

  it('STAFF manages LIAISON of its own office only; LIAISON manages nobody', () => {
    assert.equal(canManageMember(person('STAFF'), person('LIAISON')), true)
    assert.equal(canManageMember(person('STAFF'), person('STAFF', { id: 'other' })), false)
    assert.equal(canManageMember(person('STAFF'), person('LIAISON', { office_id: 'office-b' })), false)
    assert.equal(canManageMember(person('LIAISON'), person('LIAISON', { id: 'other' })), false)
  })

  it('page access can only grant pages of the target role', () => {
    assert.throws(() => readPageAccess({ page_access: ['/client/settings'] }, 'DEPARTMENT_HEAD', person('ADMIN')), /not a page/)
    assert.deepEqual(readPageAccess({ page_access: ['/scan'] }, 'LIAISON', person('ADMIN')), ['/scan'])
  })
})

describe('page access by role', () => {
  it('organization pages are admin pages', () => {
    assert.throws(() => requirePage(person('ADMIN', { page_access: JSON.stringify(['/documents']) }), '/client/settings'), /does not have access/)
    assert.doesNotThrow(() => requirePage(person('ADMIN'), '/client/settings'))
    assert.equal(canOpenPage('DEPARTMENT_HEAD', ['/employee/queue'], '/employee/team'), false)
    assert.equal(canOpenPage('DEPARTMENT_HEAD', ['/employee/team'], '/employee/team'), true)
  })
})

describe('document visibility', () => {
  it('ADMIN sees the whole organization', () => {
    assert.deepEqual(visibleWhere(person('ADMIN')), {})
  })

  it('STAFF sees its own uploads; DEPARTMENT_HEAD and LIAISON are narrowed', () => {
    assert.deepEqual(visibleWhere(person('STAFF')), { submitted_by: 'STAFF-1' })
    assert.notDeepEqual(visibleWhere(person('DEPARTMENT_HEAD')), {})
    assert.notDeepEqual(visibleWhere(person('LIAISON')), {})
  })

  it('an unknown role sees nothing (never the admin view)', () => {
    for (const role of ['', 'CLIENT', 'EMPLOYEE']) {
      assert.deepEqual(visibleWhere(person(role)), { id: null }, role)
      assert.deepEqual(openableWhere(person(role)), { id: null }, role)
    }
  })
})
