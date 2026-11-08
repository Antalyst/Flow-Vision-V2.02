import { createInternalRoute, internalRouteDto } from '~~/server/lib/internal-routes.ts'

/** Create an internal route for the office of its Department Head (or staff it made responsible): { name, description?, steps: [{ office_id, action_label? }], is_active? }. */
export default defineApiHandler(async (event) => {
  const actor = await requireUser(event, 'DEPARTMENT_HEAD', 'STAFF')
  const route = await createInternalRoute(actor, await readJson(event), requestMeta(event))
  setResponseStatus(event, 201)
  return { route: internalRouteDto(route) }
})
