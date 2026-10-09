/**
 * Working-time arithmetic, shared by the server (deadlines) and the browser (time left).
 *
 * Processing time only runs while the organization works: inside its working hours, on its
 * working days, and not on its holidays. Outside them a document's clock is paused, e.g. with
 * 8:00–17:00 Monday to Friday, a document still in progress at 17:00 on Friday picks up again at
 * 8:00 on Monday. A processing time of N days means N working days (each the length of one
 * working day) plus its hours as working hours.
 *
 * Everything is in Philippine time (UTC+8 all year, no daylight saving), like the rest of the app.
 */

export interface WorkCalendar {
  /** Start and end of the working day, in minutes after midnight (end > start). */
  start: number
  end: number
  /** Working days of the week: 0 = Sunday … 6 = Saturday. */
  days: number[]
  /** No-work days, YYYY-MM-DD. */
  holidays: string[]
  /** No-work days every year, MM-DD. */
  recurring: string[]
}

/** No working hours set: the clock runs around the clock, every day (how deadlines worked before). */
export const AROUND_THE_CLOCK: WorkCalendar = { start: 0, end: 1440, days: [0, 1, 2, 3, 4, 5, 6], holidays: [], recurring: [] }

export const WEEKDAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'] as const

const OFFSET_MS = 8 * 3_600_000
const DAY_MS = 86_400_000
const MIN_MS = 60_000
// A calendar can only be walked this many days (≈ 11 years) before giving up.
const MAX_DAYS = 4000

/** "08:30" → 510. Null when it isn't a time of day. */
export function parseClock(value: unknown): number | null {
  const m = typeof value === 'string' ? /^([01]\d|2[0-3]):([0-5]\d)$/.exec(value.trim()) : null
  return m ? Number(m[1]) * 60 + Number(m[2]) : null
}

/** 510 → "08:30" */
export const formatClock = (minutes: number) => `${String(Math.floor(minutes / 60)).padStart(2, '0')}:${String(minutes % 60).padStart(2, '0')}`

/** 510 → "8:30 AM" */
export function clockLabel(minutes: number) {
  const h = Math.floor(minutes / 60) % 24
  return `${h % 12 || 12}:${String(minutes % 60).padStart(2, '0')} ${h < 12 ? 'AM' : 'PM'}`
}

/** How long one working day is, in minutes. */
export const dayMinutes = (cal: WorkCalendar) => Math.max(1, cal.end - cal.start)

export const isAroundTheClock = (cal: WorkCalendar) => cal.start === 0 && cal.end >= 1440 && cal.days.length === 7 && !cal.holidays.length && !cal.recurring.length

/** A processing time (days + hours) in working minutes. */
export const allowanceMinutes = (days: number, hours: number, cal: WorkCalendar) => Math.max(0, days) * dayMinutes(cal) + Math.max(0, hours) * 60

interface Lookup {
  start: number
  end: number
  days: Set<number>
  holidays: Set<string>
  recurring: Set<string>
}
const lookups = new WeakMap<WorkCalendar, Lookup>()
function lookup(cal: WorkCalendar): Lookup {
  let l = lookups.get(cal)
  if (!l) {
    l = { start: cal.start, end: Math.min(1440, cal.end), days: new Set(cal.days), holidays: new Set(cal.holidays), recurring: new Set(cal.recurring) }
    lookups.set(cal, l)
  }
  return l
}

/** Midnight (Philippine time) of the day `localMs` falls on, on the shifted clock. */
const dayStartOf = (localMs: number) => Math.floor(localMs / DAY_MS) * DAY_MS

/** The working window of the day starting at `dayStart` (shifted clock), or null on a day off. */
function windowOf(dayStart: number, l: Lookup): [number, number] | null {
  const date = new Date(dayStart)
  if (!l.days.has(date.getUTCDay())) return null
  const key = date.toISOString().slice(0, 10)
  if (l.holidays.has(key) || l.recurring.has(key.slice(5))) return null
  return [dayStart + l.start * MIN_MS, dayStart + l.end * MIN_MS]
}

const toMs = (d: Date | number | string) => (d instanceof Date ? d.getTime() : typeof d === 'number' ? d : new Date(d).getTime())

/** The moment `minutes` of working time after `from`: where a processing time starting then ends. */
export function addWorkingMinutes(from: Date | number | string, minutes: number, cal: WorkCalendar): Date {
  const start = toMs(from)
  if (!(minutes > 0)) return new Date(start)
  const l = lookup(cal)
  let local = start + OFFSET_MS
  let left = minutes * MIN_MS
  for (let i = 0; i < MAX_DAYS; i++) {
    const dayStart = dayStartOf(local)
    const win = windowOf(dayStart, l)
    if (win) {
      const begin = Math.max(local, win[0])
      if (begin < win[1]) {
        const available = win[1] - begin
        if (available >= left) return new Date(begin + left - OFFSET_MS)
        left -= available
      }
    }
    local = dayStart + DAY_MS
  }
  // A calendar with (almost) no working time left: fall back to plain time.
  return new Date(start + minutes * MIN_MS)
}

/** Working minutes between two moments (0 when `to` is not after `from`). */
export function workingMinutesBetween(from: Date | number | string, to: Date | number | string, cal: WorkCalendar): number {
  const a = toMs(from) + OFFSET_MS
  const b = toMs(to) + OFFSET_MS
  if (!(b > a)) return 0
  const l = lookup(cal)
  let total = 0
  let dayStart = dayStartOf(a)
  for (let i = 0; i < MAX_DAYS && dayStart < b; i++, dayStart += DAY_MS) {
    const win = windowOf(dayStart, l)
    if (!win) continue
    const overlap = Math.min(b, win[1]) - Math.max(a, win[0])
    if (overlap > 0) total += overlap
  }
  return total / MIN_MS
}

/** Whether the clock runs at this moment (inside working hours on a working day). */
export function isWorkingTime(at: Date | number | string, cal: WorkCalendar) {
  const local = toMs(at) + OFFSET_MS
  const win = windowOf(dayStartOf(local), lookup(cal))
  return Boolean(win && local >= win[0] && local < win[1])
}

/** When the clock runs again: `at` itself during working time, else the start of the next working window. */
export function nextWorkingStart(at: Date | number | string, cal: WorkCalendar): Date | null {
  const l = lookup(cal)
  const local = toMs(at) + OFFSET_MS
  let dayStart = dayStartOf(local)
  for (let i = 0; i < MAX_DAYS; i++, dayStart += DAY_MS) {
    const win = windowOf(dayStart, l)
    if (!win || local >= win[1]) continue
    return new Date(Math.max(local, win[0]) - OFFSET_MS)
  }
  return null
}

/** "Mon–Fri, 8:00 AM – 5:00 PM" */
export function describeCalendar(cal: WorkCalendar) {
  if (isAroundTheClock(cal)) return 'Around the clock, every day'
  const days = [...cal.days].sort((a, b) => a - b)
  const short = (d: number) => WEEKDAYS[d]!.slice(0, 3)
  const consecutive = days.length > 2 && days.every((d, i) => i === 0 || d === days[i - 1]! + 1)
  const dayText = days.length === 7 ? 'Every day' : consecutive ? `${short(days[0]!)}–${short(days.at(-1)!)}` : days.map(short).join(', ')
  return `${dayText}, ${clockLabel(cal.start)} – ${clockLabel(cal.end % 1440)}`
}
