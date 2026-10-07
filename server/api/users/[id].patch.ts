import { sequelize, ACCOUNT_TYPES, Liaison, User } from '~~/server/lib/models.ts'
import { fullNameOf, revokeAllSessions } from '~~/server/lib/auth.ts'
import { audit } from '~~/server/lib/audit.ts'
import { forbidden, notFound } from '~~/server/lib/errors.ts'
import { canManageMember, managedTypesOf, officeInclude, readPageAccess, requirePage, resolveOffice, syncLiaisonProfile, TEAM_PAGE } from '~~/server/lib/team.ts'
import { memberDto } from '~~/server/lib/serializers.ts'
import * as v from '~~/server/lib/validate.ts'

export default defineApiHandler(async (event) => {
  const admin = await requireUser(event, 'CLIENT', 'EMPLOYEE', 'STAFF')
  requirePage(admin, TEAM_PAGE[admin.account_type]!)
  const user = await User.findOne({ where: { id: routeParam(event, 'id'), org_id: admin.org_id } })
  // An EMPLOYEE / STAFF member only sees (and manages) the accounts they may create, in their own office.
  if (!user || !canManageMember(admin, user)) throw notFound('User')
  const managedTypes = managedTypesOf(admin)
  const inOwnOffice = managedTypes !== null

  const body = await readJson(event)
  const updates: Record<string, unknown> = {}
  if ('first_name' in body) updates.first_name = v.reqStr(body, 'first_name', { max: 100 })
  if ('last_name' in body) updates.last_name = v.reqStr(body, 'last_name', { max: 100 })
  if ('phone' in body) updates.phone = v.str(body, 'phone', { max: 20 })
  if ('account_type' in body) updates.account_type = v.oneOf(body, 'account_type', (managedTypes ?? ACCOUNT_TYPES) as readonly string[], { required: true })
  const status = 'status' in body ? v.oneOf(body, 'status', ['ACTIVE', 'SUSPENDED'] as const, { required: true }) : null

  if (user.id === admin.id && (status === 'SUSPENDED' || (updates.account_type && updates.account_type !== 'CLIENT'))) {
    throw forbidden('You cannot suspend or demote your own account')
  }
  // Pages are granted by whoever manages the account — never by the account itself.
  if ('page_access' in body) {
    if (user.id === admin.id) throw forbidden('You cannot change which pages your own account can open')
    const pageAccess = readPageAccess(body, (updates.account_type as string) ?? user.account_type, admin)
    updates.page_access = pageAccess ? JSON.stringify(pageAccess) : null
  } else if (updates.account_type && updates.account_type !== user.account_type) {
    // Pages are role-specific: a new role starts from every page (within what the manager may grant).
    const pageAccess = readPageAccess({}, updates.account_type as string, admin)
    updates.page_access = pageAccess ? JSON.stringify(pageAccess) : null
  }
  // SUSPENDED → 'inactive'. Reactivating keeps 'pending' for people who never set a password.
  if (status === 'SUSPENDED') updates.status = 'inactive'
  if (status === 'ACTIVE' && user.status === 'inactive') updates.status = 'active'
  updates.full_name = fullNameOf((updates.first_name as string) ?? user.first_name, (updates.last_name as string) ?? user.last_name)

  const before = user.toJSON()
  const meta = requestMeta(event)
  await sequelize.transaction(async (transaction) => {
    const accountType = (updates.account_type as string) ?? user.account_type
    // An EMPLOYEE or STAFF member can't move people to another office.
    const officeId = !inOwnOffice && 'office_id' in body ? body.office_id || null : user.office_id
    const office = await resolveOffice(officeId, admin.org_id, accountType, transaction)
    updates.office_id = office?.id ?? null
    updates.department = office?.department ?? null

    await user.update(updates, { transaction })
    await syncLiaisonProfile(user, office, transaction)
    await audit(meta, { action: 'USER_UPDATE', entityType: 'user', entityId: user.id, before, after: user.toJSON() }, transaction)
  })
  // Suspension takes effect immediately: every session is revoked.
  if (updates.status === 'inactive') await revokeAllSessions(user.id)

  const fresh = await User.findByPk(user.id, { include: [officeInclude, { model: Liaison, as: 'liaisonProfile' }] })
  return { user: memberDto(fresh!) }
})
