import { RouteStep } from '~~/server/lib/models.ts'
import { updateRoute } from '~~/server/lib/routes.ts'
import { audit } from '~~/server/lib/audit.ts'
import { routeDto } from '~~/server/lib/serializers.ts'
import { badRequest } from '~~/server/lib/errors.ts'

/** Append steps to a Document Route (an edit: documents in flight keep their current steps). */
export default defineApiHandler(async (event) => {
  const user = await requireUser(event, 'CLIENT')
  const routeId = routeParam(event, 'id')
  const body = await readJson(event)
  const added = Array.isArray(body.steps) ? body.steps : body.office_id ? [body] : []
  if (!added.length) throw badRequest('Provide steps: [{ office_id, action_label, sla_days, sla_hours }]')

  // updateRoute re-reads and locks the route; this read only builds the new step list.
  const existing = await RouteStep.findAll({ where: { route_id: routeId }, order: [['step_number', 'ASC']] })
  const { route } = await updateRoute(user.org_id, routeId, {
    steps: [...existing.map((s) => ({ office_id: s.office_id, action_label: s.action_description, sla_days: s.sla_days, sla_hours: s.sla_hours })), ...added],
  })
  await audit(requestMeta(event), { action: 'ROUTE_ADD_STEPS', entityType: 'organization_route', entityId: route.id, after: { added } })
  return { route: routeDto(route) }
})
