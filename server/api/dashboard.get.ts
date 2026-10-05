import { clientDashboard, liaisonDashboard, officeDashboard } from '~~/server/lib/dashboard.ts'

/** Role-specific aggregates for the dashboard pages (A1 / B1 / C1 / D1). */
export default defineApiHandler(async (event) => {
  const user = await requireUser(event)
  const data =
    user.account_type === 'CLIENT'
      ? await clientDashboard(user)
      : user.account_type === 'LIAISON'
        ? await liaisonDashboard(user)
        : await officeDashboard(user)
  return { account_type: user.account_type, ...data }
})
