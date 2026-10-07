import { removeRoute } from '~~/server/lib/routes.ts'
import { audit } from '~~/server/lib/audit.ts'
import { requirePage } from '~~/server/lib/team.ts'

/** Remove a Document Route from the list. Deleted if unused, otherwise retired (documents keep their history). */
export default defineApiHandler(async (event) => {
  const user = await requireUser(event, 'CLIENT')
  requirePage(user, '/client/routes')
  const { route, deleted } = await removeRoute(user.org_id, routeParam(event, 'id'))
  await audit(requestMeta(event), {
    action: deleted ? 'ROUTE_DELETE' : 'ROUTE_RETIRE',
    entityType: 'organization_route',
    entityId: route.id,
    before: { name: route.name },
  })
  return { ok: true, retired: !deleted }
})
