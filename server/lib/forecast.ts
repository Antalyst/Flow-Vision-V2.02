import { Op, fn, col } from 'sequelize'
import { Document, DocumentTracking, Office } from './models.ts'
import { AT_OFFICE } from './serializers.ts'
import { readLog } from './tracking-log.ts'
import { badRequest } from './errors.ts'
import type { Actor } from './auth.ts'

/**
 * Predictive analytics for the client dashboard's forecast carousel.
 *
 * Every series is bucketed by Philippine calendar day / hour (UTC+8, no DST), then
 * projected with Holt's linear smoothing on weekday-adjusted values: the level and
 * trend follow recent volume, the weekday index keeps Monday rushes and quiet
 * weekends in the forecast. The band is ±1.28σ of the one-step-ahead errors (≈80%).
 */

export const PH_OFFSET_MS = 8 * 3_600_000
export const DAY_MS = 86_400_000
const MAX_RANGE_DAYS = 366

export type Point = [number, number]
export type BandPoint = [number, number, number]

/** Midnight (as a UTC timestamp Highcharts can plot) of the Philippine day containing `d`. */
export const phDay = (d: Date | string) => Math.floor((new Date(d).getTime() + PH_OFFSET_MS) / DAY_MS) * DAY_MS
export const phHour = (d: Date | string) => new Date(new Date(d).getTime() + PH_OFFSET_MS).getUTCHours()
export const weekday = (dayTs: number) => new Date(dayTs).getUTCDay()
export const round = (n: number, p = 1) => Math.round(n * 10 ** p) / 10 ** p

function parseDay(v: unknown, fallback: number) {
  if (typeof v !== 'string' || !v) return fallback
  if (!/^\d{4}-\d{2}-\d{2}$/.test(v)) throw badRequest('Dates must be YYYY-MM-DD')
  const ts = Date.parse(`${v}T00:00:00Z`)
  if (Number.isNaN(ts)) throw badRequest('Invalid date')
  return ts
}

/** Every Philippine day in [from, to] (inclusive), as day timestamps. */
export function daysBetween(from: number, to: number) {
  const out: number[] = []
  for (let t = from; t <= to; t += DAY_MS) out.push(t)
  return out
}

interface Projection {
  forecast: Point[]
  band: BandPoint[]
  fitted: Point[]
  trendPerDay: number
}

/** Holt's linear smoothing with multiplicative weekday indices. */
export function project(days: number[], values: number[], horizon: number, opts: { seasonal?: boolean; alpha?: number; beta?: number } = {}): Projection {
  const { seasonal = true, alpha = 0.35, beta = 0.12 } = opts
  const n = values.length
  const lastDay = days[n - 1] ?? phDay(new Date())
  const futureDays = Array.from({ length: horizon }, (_, i) => lastDay + (i + 1) * DAY_MS)
  if (!n) return { forecast: futureDays.map((d) => [d, 0]), band: futureDays.map((d) => [d, 0, 0]), fitted: [], trendPerDay: 0 }

  const mean = values.reduce((a, b) => a + b, 0) / n
  const index = Array(7).fill(1) as number[]
  // Weekday indices need at least two full weeks to mean anything.
  if (seasonal && n >= 14 && mean > 0) {
    const sums = Array(7).fill(0) as number[]
    const counts = Array(7).fill(0) as number[]
    days.forEach((d, i) => {
      sums[weekday(d)]! += values[i]!
      counts[weekday(d)]! += 1
    })
    for (let w = 0; w < 7; w++) index[w] = counts[w] ? Math.min(3, sums[w]! / counts[w]! / mean) : 1
  }
  const deseason = (v: number, d: number) => (index[weekday(d)]! > 0.05 ? v / index[weekday(d)]! : mean)

  const z = values.map((v, i) => deseason(v, days[i]!))
  const warm = Math.min(7, n)
  let level = z.slice(0, warm).reduce((a, b) => a + b, 0) / warm
  let trend = n > warm ? (z.slice(warm, warm * 2).reduce((a, b) => a + b, 0) / Math.max(1, Math.min(warm, n - warm)) - level) / warm : 0
  const errors: number[] = []
  const fitted: Point[] = []
  for (let i = 0; i < n; i++) {
    const predicted = Math.max(0, (level + trend) * index[weekday(days[i]!)]!)
    fitted.push([days[i]!, round(predicted, 2)])
    if (i >= warm) errors.push(values[i]! - predicted)
    const prevLevel = level
    level = alpha * z[i]! + (1 - alpha) * (level + trend)
    trend = beta * (level - prevLevel) + (1 - beta) * trend
  }
  const sd = errors.length ? Math.sqrt(errors.reduce((a, e) => a + e * e, 0) / errors.length) : mean * 0.5

  const forecast: Point[] = []
  const band: BandPoint[] = []
  futureDays.forEach((d, i) => {
    const h = i + 1
    const value = Math.max(0, (level + trend * h) * index[weekday(d)]!)
    const spread = 1.28 * sd * Math.sqrt(1 + 0.15 * h)
    forecast.push([d, round(value, 2)])
    band.push([d, round(Math.max(0, value - spread), 2), round(value + spread, 2)])
  })
  return { forecast, band, fitted, trendPerDay: trend }
}

/** Percent change of the next `horizon` days' forecast vs. the last `horizon` days of history. */
export function changePct(history: number[], forecast: Point[]) {
  const recent = history.slice(-forecast.length).reduce((a, b) => a + b, 0)
  const ahead = forecast.reduce((a, [, v]) => a + v, 0)
  if (!recent) return ahead ? 100 : 0
  return round(((ahead - recent) / recent) * 100, 0)
}

export async function forecastFor(user: Actor, query: Record<string, unknown>) {
  const today = phDay(new Date())
  let to = parseDay(query.to, today)
  let from = parseDay(query.from, to - 29 * DAY_MS)
  if (from > to) [from, to] = [to, from]
  if ((to - from) / DAY_MS + 1 > MAX_RANGE_DAYS) throw badRequest(`Pick a range of at most ${MAX_RANGE_DAYS} days`)
  const horizon = Math.min(30, Math.max(1, Number(query.horizon) || 7))

  // Clients see the whole organization; everyone else is held to their own office.
  let officeId = typeof query.office_id === 'string' && query.office_id ? query.office_id : null
  if (user.account_type !== 'CLIENT') officeId = (user.office_id as string | null) ?? null

  const offices = await Office.findAll({ where: { org_id: user.org_id, status: 'active' }, attributes: ['id', 'name', 'code'], order: [['name', 'ASC']] })
  const office = officeId ? offices.find((o) => o.id === officeId) : null
  if (officeId && !office) throw badRequest('Unknown office')

  // Instants bounding the Philippine days [from, to].
  const start = new Date(from - PH_OFFSET_MS)
  const end = new Date(to + DAY_MS - PH_OFFSET_MS)
  const days = daysBetween(from, to)
  const dayIndex = new Map(days.map((d, i) => [d, i]))
  const orgDoc = { model: Document, as: 'document', attributes: [], where: { org_id: user.org_id }, required: true }

  const [submissions, arrivals, pickupVisits, queues] = await Promise.all([
    // Organization-wide, "coming in" means new submissions; per office, arrivals at that office.
    office
      ? Promise.resolve([] as Array<{ submitted_at: Date }>)
      : (Document.findAll({
          where: { org_id: user.org_id, status: { [Op.ne]: 'CREATED' }, submitted_at: { [Op.gte]: start, [Op.lt]: end } },
          attributes: ['submitted_at'],
          raw: true,
        }) as unknown as Promise<Array<{ submitted_at: Date }>>),
    DocumentTracking.findAll({
      where: { step_number: { [Op.gt]: 0 }, arrived_at: { [Op.gte]: start, [Op.lt]: end }, ...(office ? { office_id: office.id } : {}) },
      attributes: ['office_id', 'arrived_at'],
      include: [orgDoc],
      raw: true,
    }) as unknown as Promise<Array<{ office_id: string | null; arrived_at: Date }>>,
    DocumentTracking.findAll({
      where: { liaison_id: { [Op.ne]: null }, updated_at: { [Op.gte]: start }, ...(office ? { office_id: office.id } : {}) },
      attributes: ['id', 'office_id', 'status', 'notes', 'created_at'],
      include: [orgDoc],
    }),
    Document.findAll({
      where: { org_id: user.org_id, status: { [Op.in]: AT_OFFICE }, current_office_id: { [Op.ne]: null } },
      attributes: ['current_office_id', [fn('COUNT', col('id')), 'count']],
      group: ['current_office_id'],
      raw: true,
    }) as unknown as Promise<Array<{ current_office_id: string; count: number }>>,
  ])

  // ── Documents coming in ────────────────────────────────────────────────────────
  const incomingCounts = Array(days.length).fill(0) as number[]
  for (const at of office ? arrivals.map((a) => a.arrived_at) : submissions.map((s) => s.submitted_at)) {
    const i = dayIndex.get(phDay(at))
    if (i != null) incomingCounts[i]! += 1
  }
  const incomingProj = project(days, incomingCounts, horizon)
  const incomingTotal = incomingCounts.reduce((a, b) => a + b, 0)
  const peakAhead = incomingProj.forecast.reduce((best, p) => (p[1] > best[1] ? p : best), incomingProj.forecast[0] ?? [to, 0])

  // ── Office busyness ────────────────────────────────────────────────────────────
  // Hour-of-day profile of arrivals, then the same profile scaled to the next day's forecast.
  const hourly = Array(24).fill(0) as number[]
  for (const a of arrivals) hourly[phHour(a.arrived_at)]! += 1
  const hourlyAvg = hourly.map((h) => round(h / days.length, 2))
  const arrivalsTotal = hourly.reduce((a, b) => a + b, 0)
  const nextDay = incomingProj.forecast[0]
  const nextDayVolume = office ? (nextDay?.[1] ?? 0) : (project(days, countByDay(arrivals, dayIndex, days.length), 1).forecast[0]?.[1] ?? 0)
  const hourlyNext = hourly.map((h) => round(arrivalsTotal ? (h / arrivalsTotal) * nextDayVolume : 0, 2))
  const peakHour = arrivalsTotal ? hourly.indexOf(Math.max(...hourly)) : null
  const workHours = hourly.slice(8, 17)
  const quietHour = arrivalsTotal ? 8 + workHours.indexOf(Math.min(...workHours)) : null

  // Per office: what's waiting now plus what's predicted to arrive over the horizon.
  const queueBy = new Map(queues.map((q) => [q.current_office_id, Number(q.count)]))
  const arrivalsByOffice = new Map<string, number[]>()
  for (const a of arrivals) {
    if (!a.office_id) continue
    const i = dayIndex.get(phDay(a.arrived_at))
    if (i == null) continue
    const series = arrivalsByOffice.get(a.office_id) ?? (Array(days.length).fill(0) as number[])
    series[i]! += 1
    arrivalsByOffice.set(a.office_id, series)
  }
  const officeLoad = (office ? [office] : offices).map((o) => {
    const series = arrivalsByOffice.get(o.id) ?? (Array(days.length).fill(0) as number[])
    const predicted = project(days, series, horizon).forecast.reduce((a, [, v]) => a + v, 0)
    return { id: o.id as string, name: o.name as string, queue: queueBy.get(o.id) ?? 0, predicted: round(predicted, 1) }
  })
  const maxLoad = Math.max(1, ...officeLoad.map((o) => o.queue + o.predicted))
  const busyOffices = officeLoad
    .map((o) => ({ ...o, score: Math.round(((o.queue + o.predicted) / maxLoad) * 100) }))
    .sort((a, b) => b.queue + b.predicted - (a.queue + a.predicted))
    .slice(0, 8)

  // ── Courier pickup times ───────────────────────────────────────────────────────
  // Wait = PICKUP_REQUESTED → PICKED_UP inside the same office visit.
  const waitSum = Array(days.length).fill(0) as number[]
  const waitCount = Array(days.length).fill(0) as number[]
  const pickupHours = Array(24).fill(0) as number[]
  const waits: number[] = []
  for (const visit of pickupVisits) {
    const log = readLog(visit)
    const picked = log.find((e) => e.type === 'PICKED_UP')
    if (!picked) continue
    const pickedAt = new Date(picked.at)
    if (pickedAt < start || pickedAt >= end) continue
    pickupHours[phHour(pickedAt)]! += 1
    const requested = log.filter((e) => e.type === 'PICKUP_REQUESTED' && e.at <= picked.at).at(-1)
    if (!requested) continue
    const minutes = (pickedAt.getTime() - new Date(requested.at).getTime()) / 60_000
    if (minutes < 0) continue
    const i = dayIndex.get(phDay(pickedAt))
    if (i == null) continue
    waitSum[i]! += minutes
    waitCount[i]! += 1
    waits.push(minutes)
  }
  // Days without pickups carry the last known average so the smoothing isn't dragged to zero.
  const avgWaitAll = waits.length ? waits.reduce((a, b) => a + b, 0) / waits.length : 0
  let carry = avgWaitAll
  const waitSeries = days.map((_, i) => (waitCount[i] ? (carry = waitSum[i]! / waitCount[i]!) : carry))
  const waitProj = project(days, waitSeries, horizon, { seasonal: false, alpha: 0.3, beta: 0.08 })
  const sortedWaits = [...waits].sort((a, b) => a - b)
  const pickupTotal = pickupHours.reduce((a, b) => a + b, 0)
  const busiestPickupHour = pickupTotal ? pickupHours.indexOf(Math.max(...pickupHours)) : null
  const predictedWait = waitProj.forecast.length ? waitProj.forecast.reduce((a, [, v]) => a + v, 0) / waitProj.forecast.length : 0

  return {
    range: { from: new Date(from).toISOString().slice(0, 10), to: new Date(to).toISOString().slice(0, 10), days: days.length, horizon },
    office: office ? { id: office.id, name: office.name } : null,
    offices: offices.map((o) => ({ id: o.id, name: o.name, code: o.code })),
    incoming: {
      basis: office ? 'arrivals' : 'submissions',
      history: days.map((d, i) => [d, incomingCounts[i]!] as Point),
      fitted: incomingProj.fitted,
      forecast: incomingProj.forecast,
      band: incomingProj.band,
      total: incomingTotal,
      avg_daily: round(incomingTotal / days.length),
      expected_next: round(incomingProj.forecast.reduce((a, [, v]) => a + v, 0)),
      change_pct: changePct(incomingCounts, incomingProj.forecast),
      peak_day: peakAhead ? { date: new Date(peakAhead[0]).toISOString().slice(0, 10), value: round(peakAhead[1]) } : null,
    },
    busyness: {
      hourly_avg: hourlyAvg,
      hourly_next: hourlyNext,
      next_day: nextDay ? new Date(nextDay[0]).toISOString().slice(0, 10) : null,
      peak_hour: peakHour,
      quiet_hour: quietHour,
      offices: busyOffices,
    },
    pickups: {
      history: days.map((d, i) => [d, waitCount[i] ? round(waitSum[i]! / waitCount[i]!) : null] as [number, number | null]),
      forecast: waitProj.forecast,
      band: waitProj.band,
      hourly: pickupHours,
      count: pickupTotal,
      measured: waits.length,
      avg_wait: waits.length ? round(avgWaitAll) : null,
      median_wait: sortedWaits.length ? round(sortedWaits[Math.floor(sortedWaits.length / 2)]!) : null,
      predicted_wait: waits.length ? round(predictedWait) : null,
      busiest_hour: busiestPickupHour,
    },
  }
}

function countByDay(rows: Array<{ arrived_at: Date }>, dayIndex: Map<number, number>, length: number) {
  const out = Array(length).fill(0) as number[]
  for (const r of rows) {
    const i = dayIndex.get(phDay(r.arrived_at))
    if (i != null) out[i]! += 1
  }
  return out
}
