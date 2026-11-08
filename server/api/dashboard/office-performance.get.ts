import { organizationPerformance } from '~~/server/lib/office-performance.ts'

/**
 * The ADMIN's organization-wide office performance: every main office and umbrella office of the ADMIN's own
 * organization, and organization totals (office-performance.ts). Query: days (7, 30 or 90), kind (all, main,
 * umbrella), main_office_id (one main office and its umbrella offices), office_id (one office).
 */
export default defineApiHandler(async (event) => {
  const user = await requireUser(event, 'ADMIN')
  return organizationPerformance(user, getQuery(event))
})
