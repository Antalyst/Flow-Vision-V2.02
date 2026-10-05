import { forecastFor } from '~~/server/lib/forecast.ts'

/** Predictive analytics for the dashboard forecast carousel. Query: from, to (YYYY-MM-DD), office_id, horizon. */
export default defineApiHandler(async (event) => {
  const user = await requireUser(event)
  return forecastFor(user, getQuery(event))
})
