import { sequelize, ACCOUNT_TYPES, Liaison, User } from '~~/server/lib/models.ts'
import { fullNameOf, revokeAllSessions } from '~~/server/lib/auth.ts'
import { audit } from '~~/server/lib/audit.ts'
import { badRequest, forbidden, notFound } from '~~/server/lib/errors.ts'
import { assertManagerPlacement, canManageMember, managedTypesOf, officeInclude, readPageAccess, requirePage, resolveOffice, syncLiaisonProfile, TEAM_PAGE } from '~~/server/lib/team.ts'
import { memberDto } from '~~/server/lib/serializers.ts'
import { cascadeToDelegates, readGrantedPermissions, recordAssignment } from '~~/server/lib/dh-access.ts'
import { MAIN_OFFICE_ONLY, parsePermissions, type DhPermission } from '../../../shared/dh-permissions.ts'
import * as v from '~~/server/lib/validate.ts'

export default defineApiHandler(async (event) => {
  const admin = await requireUser(event, 'ADMIN', 'DEPARTMENT_HEAD', 'STAFF')
  requirePage(admin, TEAM_PAGE[admin.account_type]!)
  const user = await User.findOne({ where: { id: routeParam(event, 'id'), org_id: admin.org_id }, include: [officeInclude] })
  // A DEPARTMENT_HEAD / STAFF member only sees (and manages) the accounts they may create: their own office and its umbrella offices.
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

  if (user.id === admin.id && (status === 'SUSPENDED' || (updates.account_type && updates.account_type !== 'ADMIN'))) {
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

  // Not part of the row: the office is reloaded for the response.
  const before = { ...(user.toJSON() as Record<string, unknown>), office: undefined }
  const meta = requestMeta(event)
  let cascaded = 0
  await sequelize.transaction(async (transaction) => {
    const accountType = (updates.account_type as string) ?? user.account_type
    // A DEPARTMENT_HEAD can move people between their office and its umbrella offices; a STAFF member can't move anyone.
    const movable = !inOwnOffice || admin.account_type === 'DEPARTMENT_HEAD'
    const officeId = movable && 'office_id' in body ? body.office_id || null : user.office_id
    const office = await resolveOffice(officeId, admin.org_id, accountType, transaction)
    if (inOwnOffice) await assertManagerPlacement(admin, accountType, office)
    updates.office_id = office?.id ?? null
    updates.department = office?.department ?? null

    // Delegated Department Heads: assignment, permission changes and revocation, each recorded.
    const wasDelegate = user.account_type === 'DEPARTMENT_HEAD' && Boolean(user.assigned_by)
    const isHead = accountType === 'DEPARTMENT_HEAD'
    let history: { action: 'ASSIGNED' | 'UPDATED' | 'REVOKED' | 'REINSTATED'; permissions: DhPermission[] | null } | null = null
    if (isHead && !wasDelegate && user.account_type !== 'DEPARTMENT_HEAD' && admin.account_type === 'DEPARTMENT_HEAD') {
      // Made a Department Head by a Department Head: a delegate, with only what is granted now.
      const permissions = readGrantedPermissions(body, admin, office)
      Object.assign(updates, { assigned_by: admin.id, assigned_at: new Date(), permissions: JSON.stringify(permissions) })
      history = { action: 'ASSIGNED', permissions }
    } else if (isHead && wasDelegate) {
      let permissions = parsePermissions(user.permissions)
      if ('permissions' in body) permissions = readGrantedPermissions(body, admin, office)
      // Moved to an umbrella office: what only a main office's head may do no longer applies.
      if (office?.parent_office_id) permissions = permissions.filter((p) => !MAIN_OFFICE_ONLY.includes(p))
      if (JSON.stringify(permissions) !== JSON.stringify(parsePermissions(user.permissions)) || office?.id !== user.office_id) {
        updates.permissions = JSON.stringify(permissions)
        history = { action: 'UPDATED', permissions }
      }
    } else if (!isHead && wasDelegate) {
      Object.assign(updates, { assigned_by: null, assigned_at: null, permissions: null })
      history = { action: 'REVOKED', permissions: null }
    } else if ('permissions' in body && isHead) {
      throw badRequest('Permissions apply only to Department Heads assigned by a Department Head; this one manages its office', { field: 'permissions' })
    }
    if (wasDelegate && isHead && updates.status === 'inactive' && user.status !== 'inactive') history = { action: 'REVOKED', permissions: parsePermissions(updates.permissions ?? user.permissions) }
    if (wasDelegate && isHead && updates.status === 'active' && user.status === 'inactive') history = { action: 'REINSTATED', permissions: parsePermissions(updates.permissions ?? user.permissions) }

    await user.update(updates, { transaction })
    if (history) await recordAssignment({ orgId: admin.org_id, userId: user.id, officeId: office?.id ?? null, ...history, changedBy: admin.id }, transaction)
    // Least privilege: whatever this account no longer has, the delegates it assigned lose too (recorded).
    const grantor = { id: user.id as string, name: (user.full_name as string) || 'their grantor' }
    if (history?.action === 'UPDATED' && history.permissions) cascaded = await cascadeToDelegates(grantor, history.permissions, admin.id, transaction)
    else if (user.account_type !== 'DEPARTMENT_HEAD' && (before as Record<string, unknown>).account_type === 'DEPARTMENT_HEAD') cascaded = await cascadeToDelegates(grantor, [], admin.id, transaction)
    await syncLiaisonProfile(user, office, transaction)
    await audit(meta, { action: 'USER_UPDATE', entityType: 'user', entityId: user.id, before, after: user.toJSON() }, transaction)
  })
  // Suspension takes effect immediately: every session is revoked.
  if (updates.status === 'inactive') await revokeAllSessions(user.id)

  const fresh = await User.findByPk(user.id, { include: [officeInclude, { model: Liaison, as: 'liaisonProfile' }] })
  return { user: memberDto(fresh!), ...(cascaded && { delegates_updated: cascaded }) }
})
