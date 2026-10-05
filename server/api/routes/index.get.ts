import { inFlightCounts, listActiveRoutes } from '~~/server/lib/routes.ts'
import { routeDto } from '~~/server/lib/serializers.ts'

/** The organization's active Document Routes (the ones new documents can follow). */
export default defineApiHandler(async (event) => {
  const user = await requireUser(event)
  const routes = await listActiveRoutes(user.org_id)
  const inFlight = await inFlightCounts(routes.map((r) => r.id))
  return { data: routes.map((r) => ({ ...routeDto(r)!, in_flight_documents: inFlight.get(r.id) ?? 0 })) }
})
