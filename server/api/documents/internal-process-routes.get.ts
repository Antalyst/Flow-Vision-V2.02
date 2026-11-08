import { SUBMITTER_TYPES } from '~~/server/lib/documents.ts'
import { internalRouteDto, usableInternalRoutes } from '~~/server/lib/internal-routes.ts'
import { requirePage } from '~~/server/lib/team.ts'

/**
 * The internal routes the signed-in account can choose for an Internal Process at upload: the active, usable
 * routes of its own main office, found from the session (never from the request), with their steps. An umbrella
 * office, the ADMIN, or an office without umbrella offices or routes gets none, with the reason.
 */
export default defineApiHandler(async (event) => {
  const user = await requireUser(event, ...SUBMITTER_TYPES)
  requirePage(user, '/documents/new')
  const { office, reason, routes } = await usableInternalRoutes(user)
  return {
    available: routes.length > 0,
    reason,
    office: office ? { id: office.id as string, name: office.name as string, code: office.code as string } : null,
    data: routes.map(internalRouteDto),
  }
})
