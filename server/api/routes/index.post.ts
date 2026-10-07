import { createRoute } from '~~/server/lib/routes.ts'
import { audit } from '~~/server/lib/audit.ts'
import { routeDto } from '~~/server/lib/serializers.ts'
import * as v from '~~/server/lib/validate.ts'
import { requirePage } from '~~/server/lib/team.ts'

/** Add a Document Route. An organization can have as many as it needs. */
export default defineApiHandler(async (event) => {
  const user = await requireUser(event, 'CLIENT')
  requirePage(user, '/client/routes')
  const body = await readJson(event)
  const route = await createRoute(user.org_id, user.id, {
    name: v.reqStr(body, 'name', { max: 255, label: 'Route name' }),
    description: v.str(body, 'description', { max: 2000 }),
    steps: body.steps,
  })
  await audit(requestMeta(event), {
    action: 'ROUTE_CREATE',
    entityType: 'organization_route',
    entityId: route.id,
    after: { name: route.name, steps: route.steps.map((s: any) => ({ step: s.step_number, office: s.office?.code, sla_days: s.sla_days, sla_hours: s.sla_hours })) },
  })
  setResponseStatus(event, 201)
  return { route: { ...routeDto(route)!, in_flight_documents: 0 } }
})
