import { Op } from 'sequelize'
import { ACCOUNT_TYPES, Liaison, User } from '~~/server/lib/models.ts'
import { managedTypesOf, officeInclude } from '~~/server/lib/team.ts'
import { memberDto, userSummary } from '~~/server/lib/serializers.ts'
import * as v from '~~/server/lib/validate.ts'

/**
 * CLIENT sees the full roster. An EMPLOYEE (or STAFF) with `managed=1` gets the STAFF and LIAISON (or LIAISON)
 * accounts of their own office (the ones they manage). Everyone else gets a lightweight
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
    where.office_id = user.office_id ?? null
    where.account_type = accountType && managedTypes!.includes(accountType) ? accountType : { [Op.in]: managedTypes }
  }

  const isClient = user.account_type === 'CLIENT'
  const fullDetails = isClient || managed
  if (!fullDetails) where.status = { [Op.ne]: 'inactive' }

  const users = await User.findAll({
    where,
    include: [officeInclude, ...(fullDetails ? [{ model: Liaison, as: 'liaisonProfile' }] : [])],
    order: [['account_type', 'ASC'], ['last_name', 'ASC'], ['first_name', 'ASC']],
  })
  return { data: users.map((u) => (fullDetails ? memberDto(u) : { ...userSummary(u), office_id: u.office_id ?? null })) }
})
