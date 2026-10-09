import { OrganizationHoliday } from '~~/server/lib/models.ts'
import { audit } from '~~/server/lib/audit.ts'
import { badRequest, conflict } from '~~/server/lib/errors.ts'
import { requirePage } from '~~/server/lib/team.ts'
import { changeCalendar, holidayDto } from '~~/server/lib/work-calendar.ts'
import * as v from '~~/server/lib/validate.ts'

/**
 * Mark a day as a holiday / no-work day (CLIENT only): { date: "2026-12-25", name, recurring }.
 * `recurring` = the same month and day every year. Processing time pauses that day; deadlines of
 * documents in progress move to match.
 */
export default defineApiHandler(async (event) => {
  const user = await requireUser(event, 'CLIENT')
  requirePage(user, '/client/settings')
  const body = await readJson(event)
  const date = v.dateOnly(body, 'date')
  if (!date) throw badRequest('Pick the date', { field: 'date' })
  const [y, m, d] = date.split('-').map(Number)
  const check = new Date(Date.UTC(y!, m! - 1, d!))
  if (check.getUTCMonth() !== m! - 1 || check.getUTCDate() !== d) throw badRequest('That date does not exist', { field: 'date' })
  const name = v.reqStr(body, 'name', { max: 150, label: 'Name' })
  const recurring = Boolean(body.recurring)

  const { result: holiday, rescheduled } = await changeCalendar(user.org_id, async (transaction) => {
    if (await OrganizationHoliday.count({ where: { org_id: user.org_id, holiday_date: date }, transaction })) throw conflict('That date is already marked as a holiday', 'DUPLICATE')
    return OrganizationHoliday.create({ org_id: user.org_id, holiday_date: date, name, recurring, created_by: user.id }, { transaction })
  })
  await audit(requestMeta(event), { action: 'HOLIDAY_CREATE', entityType: 'organization', entityId: user.org_id, after: { name, date, recurring, rescheduled } })
  setResponseStatus(event, 201)
  return { holiday: holidayDto(holiday), rescheduled }
})
