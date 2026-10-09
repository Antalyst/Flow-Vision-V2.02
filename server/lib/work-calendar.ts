import { Op, type Transaction } from 'sequelize'
import { sequelize, Document, OrganizationHoliday, OrganizationSettings, type Row } from './models.ts'
import { httpError } from './errors.ts'
import { addWorkingMinutes, allowanceMinutes, AROUND_THE_CLOCK, dayMinutes, formatClock, parseClock, workingMinutesBetween, type WorkCalendar } from '../../shared/work-calendar.ts'

/**
 * An organization's working calendar (Organization Settings): working hours, working days and
 * holidays. Processing time only runs inside it — see shared/work-calendar.ts.
 * No working hours set = around the clock (minus any holidays), which is also what is used while
 * the tables don't exist yet (before `npm run db:add-settings`), so nothing else breaks.
 */

export interface LoadedCalendar {
  calendar: WorkCalendar
  /** The organization set working hours or holidays (otherwise the clock never pauses). */
  configured: boolean
  /** The settings tables exist in this database. */
  available: boolean
}

// Statuses of a document still in progress (serializers.ts AT_OFFICE + CARRYING).
const IN_PROGRESS = ['START', 'ARRIVED_AT_OFFICE', 'PICKED_UP', 'IN_TRANSIT']
const TTL_MS = 60_000
const cache = new Map<string, { at: number; value: LoadedCalendar }>()
let warned = false

/** MySQL "table doesn't exist": the settings tables haven't been created in this database yet. */
export const isMissingTable = (err: unknown) => {
  const parent = (err as { parent?: { code?: string; errno?: number } })?.parent
  return parent?.code === 'ER_NO_SUCH_TABLE' || parent?.errno === 1146
}

export function settingsUnavailable() {
  if (!warned) {
    warned = true
    console.warn('[settings] organization_settings / organization_holidays / document_templates are missing — run `npm run db:add-settings` (add --remote for the hosted database)')
  }
}

/** For a change that needs the settings tables, while they don't exist yet. */
export const settingsTablesMissing = () =>
  httpError(503, 'Working hours, holidays and templates need their database tables first. Run: npm run db:add-settings', 'SETTINGS_TABLES_MISSING')

export const parseWorkDays = (raw: unknown) =>
  [...new Set(String(raw ?? '').split(',').map((s) => Number(s.trim())).filter((n) => Number.isInteger(n) && n >= 0 && n <= 6))].sort((a, b) => a - b)

/** Build a calendar from the settings row (null = around the clock) and the organization's holidays. */
export function calendarOf(settings: Record<string, any> | null, holidays: Array<Record<string, any>>): WorkCalendar {
  const off = {
    holidays: holidays.filter((h) => !h.recurring).map((h) => String(h.holiday_date).slice(0, 10)),
    recurring: holidays.filter((h) => h.recurring).map((h) => String(h.holiday_date).slice(5, 10)),
  }
  if (!settings) return off.holidays.length || off.recurring.length ? { ...AROUND_THE_CLOCK, ...off } : AROUND_THE_CLOCK
  const start = parseClock(settings.work_start) ?? 8 * 60
  const end = parseClock(settings.work_end) ?? 17 * 60
  const days = parseWorkDays(settings.work_days)
  return { start, end: end > start ? end : start + 60, days: days.length ? days : [1, 2, 3, 4, 5], ...off }
}

/** The organization's calendar, cached for a minute (`fresh` skips the cache). */
export async function loadWorkCalendar(orgId: string, { fresh = false, transaction }: { fresh?: boolean; transaction?: Transaction } = {}): Promise<LoadedCalendar> {
  const hit = cache.get(orgId)
  if (!fresh && hit && Date.now() - hit.at < TTL_MS) return hit.value
  let value: LoadedCalendar
  try {
    const [settings, holidays] = await Promise.all([
      OrganizationSettings.findByPk(orgId, { transaction }),
      OrganizationHoliday.findAll({ where: { org_id: orgId }, attributes: ['holiday_date', 'recurring'], transaction }),
    ])
    value = { calendar: calendarOf(settings, holidays), configured: Boolean(settings) || holidays.length > 0, available: true }
  } catch (err) {
    if (!isMissingTable(err)) throw err
    settingsUnavailable()
    value = { calendar: AROUND_THE_CLOCK, configured: false, available: false }
  }
  cache.set(orgId, { at: Date.now(), value })
  if (cache.size > 500) for (const [k, v] of cache) if (Date.now() - v.at > TTL_MS) cache.delete(k)
  return value
}

export const invalidateWorkCalendar = (orgId: string) => cache.delete(orgId)

/** The deadline of a processing time (days + hours) that starts at `from`, on the organization's calendar. */
export const deadlineFrom = (from: Date, time: { days: number; hours: number }, cal: WorkCalendar) => addWorkingMinutes(from, allowanceMinutes(time.days, time.hours, cal), cal)

/**
 * The working hours, days or holidays changed: move the deadline of every document still in
 * progress so it keeps the processing time it was given — the same number of working days plus
 * hours, now counted on the new calendar (e.g. a new holiday adds a day to a document due after it).
 */
export async function rescheduleActiveDeadlines(orgId: string, before: WorkCalendar, after: WorkCalendar, transaction?: Transaction) {
  const docs = await Document.findAll({
    where: { org_id: orgId, status: { [Op.in]: IN_PROGRESS }, target_completion_date: { [Op.ne]: null } },
    attributes: ['id', 'submitted_at', 'target_completion_date'],
    transaction,
  })
  const oldDay = dayMinutes(before)
  const newDay = dayMinutes(after)
  let moved = 0
  for (const doc of docs) {
    const given = workingMinutesBetween(doc.submitted_at, doc.target_completion_date, before)
    const days = Math.floor(given / oldDay)
    const minutes = days * newDay + (given - days * oldDay)
    const target = addWorkingMinutes(doc.submitted_at, minutes, after)
    if (Math.abs(target.getTime() - new Date(doc.target_completion_date).getTime()) < 60_000) continue
    // Only the deadline changes: keep updated_at, so lists don't reorder.
    await Document.update({ target_completion_date: target }, { where: { id: doc.id }, transaction, silent: true })
    moved++
  }
  return moved
}

/**
 * Change the working hours or holidays (`change` writes them) and move the deadlines of documents
 * in progress to match, in one transaction. `rescheduled` = how many deadlines moved.
 */
export async function changeCalendar<T>(orgId: string, change: (transaction: Transaction) => Promise<T>) {
  try {
    return await sequelize.transaction(async (transaction) => {
      const before = await loadWorkCalendar(orgId, { fresh: true, transaction })
      if (!before.available) throw settingsTablesMissing()
      const result = await change(transaction)
      const after = await loadWorkCalendar(orgId, { fresh: true, transaction })
      const rescheduled = await rescheduleActiveDeadlines(orgId, before.calendar, after.calendar, transaction)
      return { result, rescheduled }
    })
  } catch (err) {
    throw isMissingTable(err) ? settingsTablesMissing() : err
  } finally {
    invalidateWorkCalendar(orgId)
  }
}

/** The working hours as the settings page shows them (the usual 8:00–17:00, Monday to Friday until set). */
export function workCalendarDto(settings: Row | null, available: boolean) {
  const cal = calendarOf(settings ?? { work_start: '08:00', work_end: '17:00', work_days: '1,2,3,4,5' }, [])
  return { configured: Boolean(settings), available, work_start: formatClock(cal.start), work_end: formatClock(cal.end), work_days: cal.days }
}

export function holidayDto(h: Row) {
  return { id: h.id as string, date: String(h.holiday_date).slice(0, 10), name: h.name as string, recurring: Boolean(h.recurring) }
}
