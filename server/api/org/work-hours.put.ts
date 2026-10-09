import { OrganizationSettings } from '~~/server/lib/models.ts'
import { audit } from '~~/server/lib/audit.ts'
import { badRequest } from '~~/server/lib/errors.ts'
import { requirePage } from '~~/server/lib/team.ts'
import { changeCalendar, workCalendarDto } from '~~/server/lib/work-calendar.ts'
import { formatClock, parseClock } from '../../../shared/work-calendar.ts'

/**
 * Set the organization's working hours and days (CLIENT only): { work_start: "08:00",
 * work_end: "17:00", work_days: [1, 2, 3, 4, 5] } (0 = Sunday … 6 = Saturday, Philippine time).
 * Processing time only runs inside them; deadlines of documents in progress move to match.
 */
export default defineApiHandler(async (event) => {
  const user = await requireUser(event, 'CLIENT')
  requirePage(user, '/client/settings')
  const body = await readJson(event)
  const start = parseClock(body.work_start)
  const end = parseClock(body.work_end)
  if (start == null) throw badRequest('Start of work must be a time like 08:00', { field: 'work_start' })
  if (end == null) throw badRequest('End of work must be a time like 17:00', { field: 'work_end' })
  if (end <= start) throw badRequest('End of work must be later than the start', { field: 'work_end' })
  const days = Array.isArray(body.work_days) ? [...new Set(body.work_days.map(Number))].filter((d) => Number.isInteger(d) && d >= 0 && d <= 6).sort() : []
  if (!days.length) throw badRequest('Pick at least one working day', { field: 'work_days' })

  const values = { work_start: formatClock(start), work_end: formatClock(end), work_days: days.join(','), updated_by: user.id }
  const { result: settings, rescheduled } = await changeCalendar(user.org_id, async (transaction) => {
    const row = await OrganizationSettings.findByPk(user.org_id, { transaction, lock: transaction.LOCK.UPDATE })
    if (row) return row.update(values, { transaction })
    return OrganizationSettings.create({ org_id: user.org_id, ...values }, { transaction })
  })
  await audit(requestMeta(event), { action: 'ORG_WORK_HOURS_UPDATE', entityType: 'organization', entityId: user.org_id, after: { ...values, rescheduled } })
  return { work_calendar: workCalendarDto(settings, true), rescheduled }
})
