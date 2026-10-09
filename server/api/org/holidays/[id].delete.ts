import { OrganizationHoliday } from '~~/server/lib/models.ts'
import { audit } from '~~/server/lib/audit.ts'
import { notFound } from '~~/server/lib/errors.ts'
import { requirePage } from '~~/server/lib/team.ts'
import { changeCalendar } from '~~/server/lib/work-calendar.ts'

/** Remove a holiday (CLIENT only): that day counts as a working day again. */
export default defineApiHandler(async (event) => {
  const user = await requireUser(event, 'CLIENT')
  requirePage(user, '/client/settings')
  const id = routeParam(event, 'id')
  const { result: holiday, rescheduled } = await changeCalendar(user.org_id, async (transaction) => {
    const row = await OrganizationHoliday.findOne({ where: { id, org_id: user.org_id }, transaction })
    if (!row) throw notFound('Holiday')
    await row.destroy({ transaction })
    return row
  })
  await audit(requestMeta(event), { action: 'HOLIDAY_DELETE', entityType: 'organization', entityId: user.org_id, before: { name: holiday.name, date: String(holiday.holiday_date) }, after: { rescheduled } })
  return { ok: true, rescheduled }
})
