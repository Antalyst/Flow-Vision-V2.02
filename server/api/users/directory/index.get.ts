import { ACCOUNT_TYPES, Liaison, Office, User } from '~~/server/lib/models.ts'
import { directoryWhere, resolveDirectoryScope } from '~~/server/lib/directory.ts'
import { canManageMember } from '~~/server/lib/team.ts'
import { badRequest } from '~~/server/lib/errors.ts'
import { memberDto } from '~~/server/lib/serializers.ts'
import * as v from '~~/server/lib/validate.ts'

/**
 * One page of the users of an office family (server/lib/directory.ts decides the scope):
 *   office_id    the main office (or 'none': accounts without an office — ADMIN only)
 *   umbrella_id  optional: 'main' (the main office only) or one of its umbrella offices
 *   account_type optional role filter · q optional search · page, limit (≤ 100)
 * Filters combine (AND). The total counts the same filtered, scoped set. `can_manage` says whether
 * this account may edit the row (team.ts canManageMember — the same rule PATCH /api/users enforces).
 */
export default defineApiHandler(async (event) => {
  const actor = await requireUser(event, 'ADMIN', 'DEPARTMENT_HEAD')
  const query = getQuery(event)
  const officeId = v.q(query, 'office_id', 64)
  if (!officeId) throw badRequest('office_id is required', { field: 'office_id' })
  const { limit, offset, page } = v.pagination(query, { defaultLimit: 20, maxLimit: 100 })
  const parsed = {
    officeId,
    umbrellaId: v.q(query, 'umbrella_id', 64) || null,
    accountType: v.oneOf(query, 'account_type', ACCOUNT_TYPES),
    q: v.q(query, 'q') || null,
    page,
    limit,
  }
  const { officeIds } = await resolveDirectoryScope(actor, parsed)
  const { rows, count } = await User.findAndCountAll({
    where: directoryWhere(actor.org_id as string, officeIds, parsed),
    include: [
      { model: Office, as: 'office', include: [{ model: Office, as: 'parent', attributes: ['id', 'name', 'code'] }] },
      { model: Liaison, as: 'liaisonProfile' },
    ],
    order: [['account_type', 'ASC'], ['last_name', 'ASC'], ['first_name', 'ASC'], ['id', 'ASC']],
    limit,
    offset,
    distinct: true,
  })
  return {
    data: rows.map((u) => ({ ...memberDto(u), can_manage: canManageMember(actor, u) })),
    meta: { total: count, page, limit, pages: Math.max(1, Math.ceil(count / limit)) },
  }
})
