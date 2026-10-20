import { findInternalRoute, internalRouteDto, readableOfficeId } from '~~/server/lib/internal-routes.ts'

/** One internal route, if it belongs to an office this account may read. */
export default defineApiHandler(async (event) => {
  const actor = await requireUser(event, 'ADMIN', 'DEPARTMENT_HEAD')
  const { officeId } = readableOfficeId(actor, null)
  return { route: internalRouteDto(await findInternalRoute(actor.org_id as string, officeId, routeParam(event, 'id'))) }
})
