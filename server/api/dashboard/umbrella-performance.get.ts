import { umbrellaPerformance } from '~~/server/lib/office-performance.ts'

/**
 * Performance of the signed-in Department Head's main office and its umbrella offices, each office and the
 * department as a whole (office-performance.ts). Query: days (7, 30 or 90). The offices come from the account,
 * never from the request.
 */
export default defineApiHandler(async (event) => {
  const user = await requireUser(event, 'DEPARTMENT_HEAD')
  return umbrellaPerformance(user, getQuery(event))
})
