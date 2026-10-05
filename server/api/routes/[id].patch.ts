import { inFlightCounts, updateRoute } from '~~/server/lib/routes.ts'
import { audit } from '~~/server/lib/audit.ts'
import { routeDto } from '~~/server/lib/serializers.ts'
import * as v from '~~/server/lib/validate.ts'

const stepSummary = (steps: any[]) => steps.map((s) => ({ step: s.step_number, office_id: s.office_id, action: s.action_description, sla_days: s.sla_days, sla_hours: s.sla_hours }))

/**
 * Edit a Document Route: `name`, `description`, `steps` (each optional). The route keeps its id;
 * documents already in flight finish on the steps they started with.
 */
export default defineApiHandler(async (event) => {
  const user = await requireUser(event, 'CLIENT')
  const body = await readJson(event)
  const { route, before, stepsChanged, movedDocuments } = await updateRoute(user.org_id, routeParam(event, 'id'), {
    ...('name' in body && { name: v.reqStr(body, 'name', { max: 255, label: 'Route name' }) }),
    ...('description' in body && { description: v.str(body, 'description', { max: 2000 }) }),
    ...('steps' in body && { steps: body.steps }),
  })
  await audit(requestMeta(event), {
    action: 'ROUTE_UPDATE',
    entityType: 'organization_route',
    entityId: route.id,
    before: stepsChanged ? { steps: stepSummary(before) } : null,
    after: { name: route.name, ...(stepsChanged && { steps: stepSummary(route.steps), documents_kept_on_previous_steps: movedDocuments }) },
  })
  const inFlight = await inFlightCounts([route.id])
  return { route: { ...routeDto(route)!, in_flight_documents: inFlight.get(route.id) ?? 0 }, moved_documents: movedDocuments }
})
