import { organizationOfficeDetail } from '~~/server/lib/office-performance.ts'

/** One office of the ADMIN's organization in detail; any other office id: 404. Query: days (7, 30 or 90). */
export default defineApiHandler(async (event) => {
  const user = await requireUser(event, 'ADMIN')
  return organizationOfficeDetail(user, routeParam(event, 'officeId'), getQuery(event))
})
