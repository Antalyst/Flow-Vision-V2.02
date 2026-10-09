import { OrganizationSettings } from '~~/server/lib/models.ts'
import { audit } from '~~/server/lib/audit.ts'
import { requirePage } from '~~/server/lib/team.ts'
import { changeCalendar, workCalendarDto } from '~~/server/lib/work-calendar.ts'

/** Stop using working hours (CLIENT only): processing time runs around the clock again (holidays still pause it). */
export default defineApiHandler(async (event) => {
  const user = await requireUser(event, 'CLIENT')
  requirePage(user, '/client/settings')
  const { rescheduled } = await changeCalendar(user.org_id, (transaction) => OrganizationSettings.destroy({ where: { org_id: user.org_id }, transaction }))
  await audit(requestMeta(event), { action: 'ORG_WORK_HOURS_UPDATE', entityType: 'organization', entityId: user.org_id, after: { around_the_clock: true, rescheduled } })
  return { work_calendar: workCalendarDto(null, true), rescheduled }
})
