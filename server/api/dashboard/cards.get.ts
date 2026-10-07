import { dashboardCards } from '~~/server/lib/dashboard.ts'
import * as v from '~~/server/lib/validate.ts'

/** The client dashboard's headline cards, for the organization or one office. Query: office_id. */
export default defineApiHandler(async (event) => {
  const user = await requireUser(event, 'CLIENT')
  return dashboardCards(user, v.q(getQuery(event), 'office_id', 36) || null)
})
