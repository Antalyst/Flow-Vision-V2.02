import { sequelize, ACCOUNT_TYPES, Liaison, User } from '~~/server/lib/models.ts'
import { fullNameOf, generateTempPassword, hashPassword } from '~~/server/lib/auth.ts'
import { audit } from '~~/server/lib/audit.ts'
import { conflict, forbidden } from '~~/server/lib/errors.ts'
import { managedTypesOf, officeInclude, readPageAccess, requirePage, resolveOffice, syncLiaisonProfile, TEAM_PAGE } from '~~/server/lib/team.ts'
import { memberDto } from '~~/server/lib/serializers.ts'
import * as v from '~~/server/lib/validate.ts'

/**
 * Invite a team member. The account starts as status 'pending' with a one-time
 * temporary password the inviter shares; it becomes 'active' when they set their own.
 * The CLIENT invites anyone; an EMPLOYEE creates STAFF and LIAISON (messenger) accounts for their own office;
 * a STAFF member creates LIAISON accounts for their own office.
 * The inviter also chooses which pages the new account may open (`page_access`, omitted = every page).
 */
export default defineApiHandler(async (event) => {
  const admin = await requireUser(event, 'CLIENT', 'EMPLOYEE', 'STAFF')
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
    // Accounts an EMPLOYEE or STAFF member creates always belong to their own office.
    const office = await resolveOffice(inOwnOffice ? admin.office_id : body.office_id, admin.org_id, accountType, transaction)
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
      },
      { transaction },
    )
    await syncLiaisonProfile(created, office, transaction)
    await audit(meta, { action: 'USER_INVITE', entityType: 'user', entityId: created.id, after: { email, account_type: accountType, office_id: office?.id ?? null, page_access: pageAccess } }, transaction)
    return created.id as string
  })

  setResponseStatus(event, 201)
  const user = await User.findByPk(userId, { include: [officeInclude, { model: Liaison, as: 'liaisonProfile' }] })
  return { user: memberDto(user!), temporary_password: tempPassword }
})
