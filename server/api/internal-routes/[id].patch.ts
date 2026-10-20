import { internalRouteDto, updateInternalRoute } from '~~/server/lib/internal-routes.ts'

/** Edit an internal route of the Department Head's office: name, description, steps, is_active (deactivate / reactivate). */
export default defineApiHandler(async (event) => {
  const actor = await requireUser(event, 'DEPARTMENT_HEAD')
  return { route: internalRouteDto(await updateInternalRoute(actor, routeParam(event, 'id'), await readJson(event), requestMeta(event))) }
})
