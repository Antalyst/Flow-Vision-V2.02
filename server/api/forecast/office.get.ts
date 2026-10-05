import { officeForecastFor } from '~~/server/lib/office-forecast.ts'

/** Predictive analytics for an employee's office and its staff. Query: days (30 | 60 | 90), horizon (1–14). */
export default defineApiHandler(async (event) => {
  const user = await requireUser(event)
  return officeForecastFor(user, getQuery(event))
})
