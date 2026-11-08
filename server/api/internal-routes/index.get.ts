import { Office } from '~~/server/lib/models.ts'
import { canManageInternalRoutes, internalRouteDto, listInternalRoutes, readableOfficeId } from '~~/server/lib/internal-routes.ts'
import * as v from '~~/server/lib/validate.ts'

/**
 * Internal routes: a Department Head's or STAFF member's own office's (of an umbrella office: its parent's); the
 * ADMIN any office (query office_id) or all. `units`: the active umbrella offices a route of that office can use.
 * `can_manage`: whether this account may create and edit them (a Department Head, or staff it made responsible).
 */
export default defineApiHandler(async (event) => {
  const actor = await requireUser(event, 'ADMIN', 'DEPARTMENT_HEAD', 'STAFF')
  const { officeId } = readableOfficeId(actor, v.q(getQuery(event), 'office_id', 36) || null)
  const [routes, units] = await Promise.all([
    listInternalRoutes(actor.org_id as string, officeId),
    officeId ? Office.findAll({ where: { org_id: actor.org_id, parent_office_id: officeId, status: 'active' }, attributes: ['id', 'name', 'code'], order: [['name', 'ASC']] }) : [],
  ])
  return {
    data: routes.map(internalRouteDto),
    units: units.map((u) => ({ id: u.id as string, name: u.name as string, code: u.code as string })),
    can_manage: canManageInternalRoutes(actor),
  }
})
