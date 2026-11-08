import { officePerformanceDetail } from '~~/server/lib/office-performance.ts'

/**
 * One office of the signed-in Department Head's scope in detail: its own office, or (a main office's head)
 * one of the umbrella offices directly under it. Any other office id: 404. Query: days (7, 30 or 90).
 */
export default defineApiHandler(async (event) => {
  const user = await requireUser(event, 'DEPARTMENT_HEAD')
  return officePerformanceDetail(user, routeParam(event, 'officeId'), getQuery(event))
})
