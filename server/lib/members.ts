import type { Transaction } from 'sequelize'
import { sequelize, ACCOUNT_TYPES, User, type Row } from './models.ts'
import { fullNameOf, generateTempPassword, hashPassword, type RequestMeta } from './auth.ts'
import { audit } from './audit.ts'
import { conflict, forbidden } from './errors.ts'
import { assertManagerPlacement, managedTypesOf, readPageAccess, resolveOffice, syncLiaisonProfile } from './team.ts'
import { readGrantedPermissions, recordAssignment } from './dh-access.ts'
import * as v from './validate.ts'

/**
 * Create an account the way the Accounts / team pages do (POST /api/users), so every path that
 * makes accounts — including a head created together with an umbrella office — follows the same
 * rules: the role must be one the actor manages, the office must be theirs to place people in,
 * the email unique, the password a one-time temporary one (bcrypt-hashed, status 'pending'), and a
 * Department Head made by a Department Head is a delegate with only the permissions granted.
 *
 * `transaction`: run inside the caller's transaction (e.g. together with the office it belongs to).
 */
export async function createMember(actor: Row, body: Record<string, unknown>, meta: RequestMeta, { transaction }: { transaction?: Transaction } = {}) {
  const managedTypes = managedTypesOf(actor)
  const inOwnOffice = managedTypes !== null
  const accountType = v.oneOf(body, 'account_type', (managedTypes ?? ACCOUNT_TYPES) as readonly string[], { required: true })!
  if (inOwnOffice && !actor.office_id) throw forbidden('You need to belong to an office to create accounts')
  const email = v.email(body)
  const firstName = v.reqStr(body, 'first_name', { max: 100, label: 'First name' })
  const lastName = v.reqStr(body, 'last_name', { max: 100, label: 'Last name' })
  const phone = v.str(body, 'phone', { max: 20 })
  const pageAccess = readPageAccess(body, accountType, actor)
  if (await User.count({ where: { email }, transaction })) throw conflict('An account with that email already exists', 'EMAIL_TAKEN')

  const tempPassword = generateTempPassword()
  const passwordHash = await hashPassword(tempPassword)

  const run = async (t: Transaction) => {
    // Accounts a DEPARTMENT_HEAD or STAFF member creates belong to their own office — or, for a
    // DEPARTMENT_HEAD, to one of its umbrella offices.
    const office = await resolveOffice(inOwnOffice ? body.office_id || actor.office_id : body.office_id, actor.org_id, accountType, t)
    if (inOwnOffice) await assertManagerPlacement(actor, accountType, office)
    // A Department Head added by a Department Head is a delegate: assigned by them, with only the
    // permissions they grant (each one they hold themselves). One the ADMIN adds is a managing head.
    const delegated = accountType === 'DEPARTMENT_HEAD' && actor.account_type === 'DEPARTMENT_HEAD'
    const permissions = delegated ? readGrantedPermissions(body, actor, office) : null
    const created = await User.create(
      {
        org_id: actor.org_id,
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
        ...(delegated && { assigned_by: actor.id, assigned_at: new Date(), permissions: JSON.stringify(permissions) }),
      },
      { transaction: t },
    )
    await syncLiaisonProfile(created, office, t)
    if (delegated) await recordAssignment({ orgId: actor.org_id, userId: created.id, officeId: office?.id ?? null, action: 'ASSIGNED', permissions, changedBy: actor.id }, t)
    await audit(
      meta,
      { action: 'USER_INVITE', entityType: 'user', entityId: created.id, after: { email, account_type: accountType, office_id: office?.id ?? null, page_access: pageAccess, ...(delegated && { assigned_by: actor.id, permissions }) } },
      t,
    )
    return created.id as string
  }
  const userId = transaction ? await run(transaction) : await sequelize.transaction(run)
  return { userId, temporaryPassword: tempPassword, email }
}
