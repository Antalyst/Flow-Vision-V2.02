import { internalRouteDto, updateInternalRoute } from '~~/server/lib/internal-routes.ts'

/** Edit an internal route of the office (its Department Head, or staff it made responsible): name, description, steps, is_active (deactivate / reactivate). */
export default defineApiHandler(async (event) => {
  const actor = await requireUser(event, 'DEPARTMENT_HEAD', 'STAFF')
  return { route: internalRouteDto(await updateInternalRoute(actor, routeParam(event, 'id'), await readJson(event), requestMeta(event))) }
})
