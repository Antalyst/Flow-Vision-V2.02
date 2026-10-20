import { Op } from 'sequelize'
import { ACCOUNT_TYPES, Liaison, User } from '~~/server/lib/models.ts'
import { managedOfficeIds, managedTypesOf, officeInclude } from '~~/server/lib/team.ts'
import { isDelegatedHead } from '~~/server/lib/dh-access.ts'
import { memberDto, userSummary } from '~~/server/lib/serializers.ts'
import * as v from '~~/server/lib/validate.ts'

/**
 * ADMIN sees the full roster. With `managed=1`, a DEPARTMENT_HEAD gets the accounts it manages in its office and
 * umbrella offices (STAFF, LIAISON and delegated Department Heads, as its permissions allow) and a STAFF member
 * the LIAISON accounts of its office. Everyone else gets a lightweight
 * directory (for messaging and liaison search) without contact details.
 */
export default defineApiHandler(async (event) => {
  const user = await requireUser(event)
  const query = getQuery(event)
  const where: Record<string | symbol, unknown> = { org_id: user.org_id }

  const accountType = v.oneOf(query, 'account_type', ACCOUNT_TYPES)
  if (accountType) where.account_type = accountType
  const search = v.q(query, 'q')
  if (search) {
    where[Op.or] = ['first_name', 'last_name', 'full_name', 'email'].map((c) => ({ [c]: { [Op.like]: `%${search}%` } }))
  }

  const managedTypes = managedTypesOf(user)
  const managed = Boolean(managedTypes?.length) && ['1', 'true'].includes(String(query.managed ?? ''))
  if (managed) {
    // Their own office, and (for a DEPARTMENT_HEAD) its umbrella offices. Other Department Heads of
    // their own office aren't theirs to manage, only the heads of their umbrella offices.
    const offices = user.account_type === 'DEPARTMENT_HEAD' ? await managedOfficeIds(user) : [user.office_id ?? null]
    where.office_id = { [Op.in]: offices.length ? offices : [null] }
    where.account_type = accountType && managedTypes!.includes(accountType) ? accountType : { [Op.in]: managedTypes }
    where.id = { [Op.ne]: user.id }
    if (user.account_type === 'DEPARTMENT_HEAD') {
      // Department Heads listed here are delegates only (never a managing head); a delegate sees only
      // the delegates it assigned itself — the same rule as team.ts canManageMember.
      const heads = isDelegatedHead(user) ? { assigned_by: user.id } : { assigned_by: { [Op.ne]: null } }
      where[Op.and] = [{ [Op.or]: [{ account_type: { [Op.ne]: 'DEPARTMENT_HEAD' } }, heads] }]
    }
  }

  const isClient = user.account_type === 'ADMIN'
  const fullDetails = isClient || managed
  if (!fullDetails) {
    where.status = { [Op.ne]: 'inactive' }
    // An account whose stored role isn't valid can't sign in, so it isn't someone to message. (The
    // admin's full roster still lists it, labelled "Unknown role", so it can be found and fixed.)
    if (!where.account_type) where.account_type = { [Op.in]: ACCOUNT_TYPES }
  }

  const users = await User.findAll({
    where,
    include: [officeInclude, ...(fullDetails ? [{ model: Liaison, as: 'liaisonProfile' }] : [])],
    order: [['account_type', 'ASC'], ['last_name', 'ASC'], ['first_name', 'ASC']],
  })
  return { data: users.map((u) => (fullDetails ? memberDto(u) : { ...userSummary(u), office_id: u.office_id ?? null })) }
})
