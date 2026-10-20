import { DepartmentHeadAssignment, User } from '~~/server/lib/models.ts'
import { notFound } from '~~/server/lib/errors.ts'
import { canManageMember, officeInclude, requirePage, TEAM_PAGE } from '~~/server/lib/team.ts'
import { userSummary } from '~~/server/lib/serializers.ts'
import { parsePermissions } from '../../../../shared/dh-permissions.ts'

/** A delegated Department Head's assignment history: who assigned it, each permission change and revocation, and when. */
export default defineApiHandler(async (event) => {
  const actor = await requireUser(event, 'ADMIN', 'DEPARTMENT_HEAD')
  requirePage(actor, TEAM_PAGE[actor.account_type]!)
  const user = await User.findOne({ where: { id: routeParam(event, 'id'), org_id: actor.org_id }, include: [officeInclude] })
  if (!user || !canManageMember(actor, user)) throw notFound('User')
  const rows = await DepartmentHeadAssignment.findAll({
    where: { user_id: user.id, org_id: actor.org_id },
    include: [{ model: User, as: 'changedBy', attributes: ['id', 'first_name', 'last_name', 'full_name', 'email', 'account_type'] }],
    order: [['created_at', 'DESC']],
    limit: 100,
  })
  return {
    data: rows.map((r) => ({
      id: r.id,
      action: r.action,
      permissions: r.permissions == null ? null : parsePermissions(r.permissions),
      office_id: r.office_id ?? null,
      changed_by: userSummary(r.changedBy),
      note: (r.note as string | null) ?? null,
      created_at: new Date(r.created_at).toISOString(),
    })),
  }
})
