import { Op } from 'sequelize'
import { Document, DocumentTracking, Office, User, type Row } from './models.ts'
import { AT_OFFICE, trackingNumber } from './serializers.ts'
import { readLog } from './tracking-log.ts'
import { forbidden } from './errors.ts'
import { DAY_MS, PH_OFFSET_MS, changePct, daysBetween, phDay, phHour, project, round, weekday, type Point } from './forecast.ts'
import type { Actor } from './auth.ts'

/**
 * Predictive analytics for an EMPLOYEE's office dashboard: what the office will receive and
 * clear over the coming days, where its backlog is heading, which documents are likely to
 * miss their deadline, and the same workload outlook for each staff member of the office.
 *
 * History is bucketed by Philippine day and projected with the Holt smoothing in forecast.ts.
 */

const MEMBER_TYPES = ['EMPLOYEE', 'STAFF']
const WEEKDAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday']
const sum = (a: number[]) => a.reduce((x, y) => x + y, 0)
const avg = (a: number[]) => (a.length ? sum(a) / a.length : null)
const minutes = (from: string | Date, to: string | Date) => (new Date(to).getTime() - new Date(from).getTime()) / 60_000
const isoDay = (ts: number) => new Date(ts).toISOString().slice(0, 10)
const zeros = (n: number) => Array(n).fill(0) as number[]

/** Daily averages with empty days carrying the last known value, so smoothing isn't dragged to zero. */
function carrySeries(sums: number[], counts: number[], fallback: number) {
  let carry = fallback
  return sums.map((s, i) => (counts[i] ? (carry = s / counts[i]!) : carry))
}

interface VisitFacts {
  docId: string
  arrivedAt: string
  receivedAt: string | null
  receivedBy: string | null
  releasedAt: string | null
  releasedBy: string | null
  /** The paper left the office: picked up, or decided at the final checkpoint. */
  leftAt: string | null
  /** Receipt → release/decision. */
  processing: number | null
}

function factsOf(visit: Row): VisitFacts {
  const log = readLog(visit)
  const firstOf = (...t: string[]) => log.find((e) => t.includes(e.type))
  const lastOf = (...t: string[]) => log.filter((e) => t.includes(e.type)).at(-1)
  const arrivedAt = firstOf('ARRIVED', 'SUBMITTED', 'RESUBMITTED')?.at ?? new Date(visit.arrived_at ?? visit.created_at).toISOString()
  const received = firstOf('RECEIVED')
  const release = firstOf('PICKUP_REQUESTED')
  const decision = lastOf('APPROVED', 'RETURNED')
  const failed = lastOf('DELIVERY_FAILED')
  // A failed delivery brings the paper back: it hasn't left until it is picked up again.
  const lastPickup = lastOf('PICKED_UP')
  const picked = lastPickup && (!failed || lastPickup.at > failed.at) ? lastPickup : undefined
  const doneAt = release?.at ?? decision?.at ?? null
  return {
    docId: visit.document_id,
    arrivedAt,
    receivedAt: received?.at ?? null,
    receivedBy: received?.by ?? null,
    releasedAt: doneAt,
    releasedBy: release?.by ?? decision?.by ?? null,
    leftAt: picked?.at ?? decision?.at ?? null,
    processing: received && doneAt && doneAt >= received.at ? minutes(received.at, doneAt) : null,
  }
}

export async function officeForecastFor(user: Actor, query: Record<string, unknown>) {
  if (user.account_type !== 'EMPLOYEE') throw forbidden('Office forecasts are for office employees')
  const officeId = user.office_id as string | null
  if (!officeId) return { office: null }

  const lookback = [30, 60, 90].includes(Number(query.days)) ? Number(query.days) : 30
  const horizon = Math.min(14, Math.max(1, Number(query.horizon) || 7))
  const today = phDay(new Date())
  const from = today - (lookback - 1) * DAY_MS
  const days = daysBetween(from, today)
  const dayIndex = new Map(days.map((d, i) => [d, i]))
  const indexOf = (at: string | Date | null | undefined) => (at ? dayIndex.get(phDay(at)) : undefined)
  const start = new Date(from - PH_OFFSET_MS)
  const now = new Date()

  const orgDoc = { model: Document, as: 'document', attributes: ['id', 'title', 'priority', 'status', 'target_completion_date', 'current_office_id'], where: { org_id: user.org_id }, required: true }
  const [office, members, visits, uploads] = await Promise.all([
    Office.findByPk(officeId, { attributes: ['id', 'name', 'code'] }),
    User.findAll({
      where: { org_id: user.org_id, office_id: officeId, account_type: { [Op.in]: MEMBER_TYPES }, status: { [Op.ne]: 'inactive' } },
      attributes: ['id', 'first_name', 'last_name', 'full_name', 'email', 'account_type', 'position'],
      order: [['first_name', 'ASC']],
    }),
    // Every office visit in the window, plus the ones still open here from before it.
    DocumentTracking.findAll({
      where: {
        office_id: officeId,
        step_number: { [Op.gt]: 0 },
        [Op.or]: [{ arrived_at: { [Op.gte]: start } }, { completed_at: null }, { completed_at: { [Op.gte]: start } }],
      },
      attributes: ['id', 'document_id', 'status', 'handler_id', 'liaison_id', 'arrived_at', 'completed_at', 'created_at', 'notes'],
      include: [orgDoc],
      order: [['created_at', 'ASC']],
    }),
    Document.findAll({
      where: { org_id: user.org_id, status: { [Op.ne]: 'CREATED' }, submitted_at: { [Op.gte]: start } },
      attributes: ['submitted_by', 'submitted_at'],
      include: [{ model: User, as: 'submitter', attributes: [], where: { office_id: officeId }, required: true }],
      raw: true,
    }) as unknown as Promise<Array<{ submitted_by: string; submitted_at: Date }>>,
  ])

  const facts = visits.map((v) => ({ visit: v, f: factsOf(v) }))

  // ── Office: arrivals, throughput, processing time ─────────────────────────────────
  const arrivals = zeros(days.length)
  const cleared = zeros(days.length)
  const procSum = zeros(days.length)
  const procCount = zeros(days.length)
  const receiptWaits: number[] = []
  const processingAll: number[] = []
  const totalsAtOffice: number[] = []
  const hourly = zeros(24)
  const byWeekday = zeros(7)
  for (const { f } of facts) {
    const a = indexOf(f.arrivedAt)
    if (a != null && new Date(f.arrivedAt) >= start) {
      arrivals[a]! += 1
      hourly[phHour(f.arrivedAt)]! += 1
      byWeekday[weekday(phDay(f.arrivedAt))]! += 1
    }
    const c = indexOf(f.releasedAt)
    if (c != null) cleared[c]! += 1
    if (f.processing != null && c != null) {
      procSum[c]! += f.processing
      procCount[c]! += 1
      processingAll.push(f.processing)
    }
    if (f.receivedAt && new Date(f.arrivedAt) >= start) receiptWaits.push(minutes(f.arrivedAt, f.receivedAt))
    if (f.leftAt && new Date(f.arrivedAt) >= start) totalsAtOffice.push(minutes(f.arrivedAt, f.leftAt))
  }

  const arrivalsProj = project(days, arrivals, horizon)
  const clearedProj = project(days, cleared, horizon)
  const avgProcessing = avg(processingAll)
  const procProj = project(days, carrySeries(procSum, procCount, avgProcessing ?? 0), horizon, { seasonal: false, alpha: 0.3, beta: 0.08 })
  const predictedProcessing = processingAll.length ? avg(procProj.forecast.map(([, v]) => v)) : null
  const expectedArrivals = sum(arrivalsProj.forecast.map(([, v]) => v))
  const expectedCleared = sum(clearedProj.forecast.map(([, v]) => v))

  // ── Backlog: what's here now, rolled forward with predicted arrivals minus clearances ──
  const openHere = facts.filter(({ visit }) => AT_OFFICE.includes(visit.document.status) && visit.document.current_office_id === officeId && !visit.completed_at)
  const backlogNow = openHere.length
  let level = backlogNow
  const backlog: Point[] = arrivalsProj.forecast.map(([d, inbound], i) => {
    level = Math.max(0, level + inbound - (clearedProj.forecast[i]?.[1] ?? 0))
    return [d, round(level)]
  })
  const dailyNet = (expectedCleared - expectedArrivals) / horizon
  const avgCleared = avg(cleared) ?? 0
  const clearanceDays = !backlogNow ? 0 : dailyNet > 0.05 ? Math.ceil(backlogNow / dailyNet) : avgCleared > 0 && dailyNet >= -0.05 ? Math.ceil(backlogNow / avgCleared) : null

  // ── Deadline risk for documents at the office now ─────────────────────────────────
  // Expected time left here = typical time-at-office minus time already spent (at least the
  // typical processing still ahead when not yet released).
  const typicalStay = avg(totalsAtOffice) ?? (avgProcessing != null ? avgProcessing + (avg(receiptWaits) ?? 0) : null)
  const risks = openHere
    .map(({ visit, f }) => {
      const target = visit.document.target_completion_date as Date | null
      const spent = minutes(f.arrivedAt, now)
      const left = typicalStay == null ? null : Math.max(f.releasedAt ? 15 : (predictedProcessing ?? avgProcessing ?? 60) * 0.25, typicalStay - spent)
      const expectedOut = left == null ? null : new Date(now.getTime() + left * 60_000)
      const level: 'overdue' | 'at_risk' | 'on_track' | 'no_deadline' = !target
        ? 'no_deadline'
        : target < now
          ? 'overdue'
          : expectedOut && expectedOut > target
            ? 'at_risk'
            : 'on_track'
      return {
        id: visit.document.id as string,
        tracking_number: trackingNumber(visit.document.id),
        title: visit.document.title as string,
        priority: visit.document.priority as string,
        stage: f.releasedAt ? 'Waiting for messenger' : f.receivedAt ? 'Processing' : 'Waiting to be received',
        holder: f.receivedBy,
        minutes_here: round(spent),
        expected_out_at: expectedOut?.toISOString() ?? null,
        target_at: target ? new Date(target).toISOString() : null,
        risk: level,
      }
    })
  const riskOrder = { overdue: 0, at_risk: 1, on_track: 2, no_deadline: 3 }
  const memberById = new Map(members.map((m) => [m.id as string, m]))
  const atRisk = risks
    .filter((r) => r.risk === 'overdue' || r.risk === 'at_risk')
    .sort((a, b) => riskOrder[a.risk] - riskOrder[b.risk] || (a.target_at ?? '').localeCompare(b.target_at ?? ''))

  const peakHour = sum(hourly) ? hourly.indexOf(Math.max(...hourly)) : null
  const peakWeekday = sum(byWeekday) ? byWeekday.indexOf(Math.max(...byWeekday)) : null
  const peakAhead = arrivalsProj.forecast.reduce((best, p) => (p[1] > best[1] ? p : best), arrivalsProj.forecast[0] ?? [today, 0])

  // ── Staff: who received, released and uploaded what, and where their load is heading ──
  const staff = members.map((m) => {
    const id = m.id as string
    const received = zeros(days.length)
    const released = zeros(days.length)
    const uploaded = zeros(days.length)
    const processing: number[] = []
    for (const { f } of facts) {
      const r = f.receivedBy === id ? indexOf(f.receivedAt) : undefined
      if (r != null) received[r]! += 1
      const c = f.releasedBy === id ? indexOf(f.releasedAt) : undefined
      if (c != null) released[c]! += 1
      if (f.receivedBy === id && f.processing != null && c != null) processing.push(f.processing)
    }
    for (const u of uploads) {
      if (u.submitted_by !== id) continue
      const i = indexOf(u.submitted_at)
      if (i != null) uploaded[i]! += 1
    }
    const holding = openHere.filter(({ f }) => f.receivedBy === id && !f.releasedAt).length
    const receivedProj = project(days, received, horizon)
    const uploadedProj = project(days, uploaded, horizon)
    const expectedReceived = sum(receivedProj.forecast.map(([, v]) => v))
    const avgProc = avg(processing)
    return {
      id,
      first_name: (m.first_name ?? String(m.full_name ?? m.email).split(' ')[0]) as string,
      last_name: (m.last_name ?? '') as string,
      account_type: m.account_type as string,
      position: (m.position ?? null) as string | null,
      holding,
      received_total: sum(received),
      released_total: sum(released),
      uploads_total: sum(uploaded),
      avg_processing_minutes: avgProc == null ? null : round(avgProc),
      expected_received: round(expectedReceived),
      expected_uploads: round(sum(uploadedProj.forecast.map(([, v]) => v))),
      change_pct: changePct(received, receivedProj.forecast),
      // Work predicted on their desk over the horizon: what they hold now plus what they're expected to receive.
      predicted_load: round(holding + expectedReceived),
      // Last two weeks of receipts, then the forecast, for the sparkline.
      history: days.slice(-14).map((d, i) => [d, received[days.length - 14 + i] ?? 0] as Point),
      forecast: receivedProj.forecast,
    }
  })
  const loads = staff.map((s) => s.predicted_load)
  const meanLoad = avg(loads) ?? 0
  const staffOut = staff
    .map((s) => ({ ...s, load_level: (meanLoad > 0 && s.predicted_load > meanLoad * 1.5 && s.predicted_load >= 3 ? 'high' : meanLoad > 0 && s.predicted_load < meanLoad * 0.5 ? 'light' : 'normal') as 'high' | 'normal' | 'light' }))
    .sort((a, b) => b.predicted_load - a.predicted_load)
  const busiest = staffOut.find((s) => s.load_level === 'high')
  const lightest = staffOut.at(-1)

  return {
    office: office ? { id: office.id, name: office.name, code: office.code } : null,
    range: { from: isoDay(from), to: isoDay(today), days: lookback, horizon },
    arrivals: {
      history: days.map((d, i) => [d, arrivals[i]!] as Point),
      forecast: arrivalsProj.forecast,
      band: arrivalsProj.band,
      total: sum(arrivals),
      avg_daily: round(sum(arrivals) / days.length),
      expected: round(expectedArrivals),
      change_pct: changePct(arrivals, arrivalsProj.forecast),
      peak_day: peakAhead && peakAhead[1] > 0 ? { date: isoDay(peakAhead[0]), value: round(peakAhead[1]) } : null,
      peak_hour: peakHour,
      busiest_weekday: peakWeekday == null ? null : WEEKDAYS[peakWeekday],
    },
    throughput: {
      history: days.map((d, i) => [d, cleared[i]!] as Point),
      forecast: clearedProj.forecast,
      total: sum(cleared),
      expected: round(expectedCleared),
      change_pct: changePct(cleared, clearedProj.forecast),
    },
    backlog: {
      now: backlogNow,
      forecast: backlog,
      end: backlog.at(-1)?.[1] ?? backlogNow,
      trend: dailyNet > 0.05 ? 'shrinking' : dailyNet < -0.05 ? 'growing' : 'steady',
      clearance_days: clearanceDays,
    },
    processing: {
      avg_minutes: avgProcessing == null ? null : round(avgProcessing),
      predicted_minutes: predictedProcessing == null ? null : round(predictedProcessing),
      avg_receipt_wait_minutes: receiptWaits.length ? round(avg(receiptWaits)!) : null,
      typical_stay_minutes: typicalStay == null ? null : round(typicalStay),
      measured: processingAll.length,
    },
    deadlines: {
      overdue: risks.filter((r) => r.risk === 'overdue').length,
      at_risk: risks.filter((r) => r.risk === 'at_risk').length,
      on_track: risks.filter((r) => r.risk === 'on_track').length,
      documents: atRisk.slice(0, 6).map((r) => {
        const holder = r.holder ? memberById.get(r.holder) : null
        return { ...r, holder: holder ? `${holder.first_name ?? ''} ${holder.last_name ?? ''}`.trim() : null }
      }),
    },
    staff: staffOut,
    suggestion:
      busiest && lightest && lightest.id !== busiest.id
        ? `${busiest.first_name} is heading for the heaviest desk (≈${busiest.predicted_load} documents in ${horizon} days). Route new arrivals to ${lightest.first_name} (≈${lightest.predicted_load}) to even out the load.`
        : null,
  }
}
