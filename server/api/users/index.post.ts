import { sequelize, ACCOUNT_TYPES, Liaison, User } from '~~/server/lib/models.ts'
import { fullNameOf, generateTempPassword, hashPassword } from '~~/server/lib/auth.ts'
import { audit } from '~~/server/lib/audit.ts'
import { conflict, forbidden } from '~~/server/lib/errors.ts'
import { assertManagerPlacement, managedTypesOf, officeInclude, readPageAccess, requirePage, resolveOffice, syncLiaisonProfile, TEAM_PAGE } from '~~/server/lib/team.ts'
import { memberDto } from '~~/server/lib/serializers.ts'
import { readGrantedPermissions, recordAssignment } from '~~/server/lib/dh-access.ts'
import * as v from '~~/server/lib/validate.ts'

/**
 * Invite a team member. The account starts as status 'pending' with a one-time
 * temporary password the inviter shares; it becomes 'active' when they set their own.
 * The ADMIN invites anyone; a DEPARTMENT_HEAD creates STAFF and LIAISON (messenger) accounts for their own office
 * and its umbrella offices, and the head (DEPARTMENT_HEAD) of each umbrella office; a STAFF member creates LIAISON
 * accounts for their own office.
 * The inviter also chooses which pages the new account may open (`page_access`, omitted = every page).
 */
export default defineApiHandler(async (event) => {
  const admin = await requireUser(event, 'ADMIN', 'DEPARTMENT_HEAD', 'STAFF')
  requirePage(admin, TEAM_PAGE[admin.account_type]!)
  const body = await readJson(event)
  const managedTypes = managedTypesOf(admin)
  const inOwnOffice = managedTypes !== null
  const accountType = v.oneOf(body, 'account_type', (managedTypes ?? ACCOUNT_TYPES) as readonly string[], { required: true })!
  if (inOwnOffice && !admin.office_id) throw forbidden('You need to belong to an office to create accounts')
  const email = v.email(body)
  const firstName = v.reqStr(body, 'first_name', { max: 100, label: 'First name' })
  const lastName = v.reqStr(body, 'last_name', { max: 100, label: 'Last name' })
  const phone = v.str(body, 'phone', { max: 20 })
  const pageAccess = readPageAccess(body, accountType, admin)
  if (await User.count({ where: { email } })) throw conflict('An account with that email already exists', 'EMAIL_TAKEN')

  const tempPassword = generateTempPassword()
  const passwordHash = await hashPassword(tempPassword)
  const meta = requestMeta(event)

  const userId = await sequelize.transaction(async (transaction) => {
    // Accounts a DEPARTMENT_HEAD or STAFF member creates belong to their own office — or, for a
    // DEPARTMENT_HEAD, to one of its umbrella offices.
    const office = await resolveOffice(inOwnOffice ? body.office_id || admin.office_id : body.office_id, admin.org_id, accountType, transaction)
    if (inOwnOffice) await assertManagerPlacement(admin, accountType, office)
    // A Department Head added by a Department Head is a delegate: assigned by them, with only the
    // permissions they grant (each one they hold themselves). One the ADMIN adds is a managing head.
    const delegated = accountType === 'DEPARTMENT_HEAD' && admin.account_type === 'DEPARTMENT_HEAD'
    const permissions = delegated ? readGrantedPermissions(body, admin, office) : null
    const created = await User.create(
      {
        org_id: admin.org_id,
        office_id: office?.id ?? null,
        account_type: accountType,
        email,
        first_name: firstName,
        last_name: lastName,
        full_name: fullNameOf(firstName, lastName),
        phone,
        department: office?.department ?? null,
        password_hash: passwordHash,
        status: 'pending',
        page_access: pageAccess ? JSON.stringify(pageAccess) : null,
        ...(delegated && { assigned_by: admin.id, assigned_at: new Date(), permissions: JSON.stringify(permissions) }),
      },
      { transaction },
    )
    await syncLiaisonProfile(created, office, transaction)
    if (delegated) await recordAssignment({ orgId: admin.org_id, userId: created.id, officeId: office?.id ?? null, action: 'ASSIGNED', permissions, changedBy: admin.id }, transaction)
    await audit(
      meta,
      { action: 'USER_INVITE', entityType: 'user', entityId: created.id, after: { email, account_type: accountType, office_id: office?.id ?? null, page_access: pageAccess, ...(delegated && { assigned_by: admin.id, permissions }) } },
      transaction,
    )
    return created.id as string
  })

  setResponseStatus(event, 201)
  const user = await User.findByPk(userId, { include: [officeInclude, { model: Liaison, as: 'liaisonProfile' }] })
  return { user: memberDto(user!), temporary_password: tempPassword }
})
