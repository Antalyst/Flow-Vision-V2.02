import { Op, fn, col, literal } from 'sequelize'
import { Document, DocumentTracking, Office, User, sequelize, type Row } from './models.ts'
import { forbidden, notFound } from './errors.ts'
import type { Actor } from './auth.ts'
import { isDelegatedHead, hasPermission } from './dh-access.ts'
import { AT_OFFICE, officeDto, trackingNumber } from './serializers.ts'
import { readLog } from './tracking-log.ts'
import { visibleWhere } from './document-queries.ts'
import { DAY_MS, PH_OFFSET_MS, daysBetween, phDay, round } from './forecast.ts'
import { canOpenPage, parsePageAccess } from '../../shared/page-access.ts'
import { avg, inRange, metricsOf, minutesBetween, stintsOfVisit, type Outcome, type Stint } from './office-stints.ts'

export type { Outcome, Stint } from './office-stints.ts'

/**
 * Umbrella office performance: how a main office and each of its umbrella offices (units) handle the
 * documents that reach them, for the main office's Department Head (dashboard). Monitoring only — nothing
 * here grants an action on a unit's documents.
 *
 * Where the numbers come from (never from documents.origin_office_id, never from users.office_id as history):
 *
 *   An office's work is a *stint*: a period during which it held a document on its route.
 *     STEP  a document_tracking visit of the office at a route step (step_number > 0). Started by the visit's
 *           ARRIVED / SUBMITTED / RESUBMITTED event, received by its first RECEIVED while the office holds it,
 *           cleared by the first PICKUP_REQUESTED or SENT_BACK (or the decision), ended by the decision
 *           (APPROVED / RETURNED) or by the paper leaving (the last PICKED_UP not undone by DELIVERY_FAILED).
 *           The same definitions as the office forecast (office-forecast.ts), so the two agree.
 *     UNIT  an umbrella office's part of its parent's visit: it has no visit of its own, so it is replayed from
 *           the parent visit's log. Starts at HANDED_TO_UMBRELLA / INTERNAL_ROUTE_STARTED / INTERNAL_ROUTE_MOVED
 *           into the unit, received by the first RECEIVED while the unit holds it, ended by
 *           RETURNED_FROM_UMBRELLA / INTERNAL_ROUTE_COMPLETED / INTERNAL_ROUTE_ENDED (back to the office) or
 *           INTERNAL_ROUTE_MOVED (on to the next unit).
 *   Step 0 (a document at its origin, before the first office of its route) is the uploader's side, not work
 *   received, and is left out — documents waiting there for a messenger are reported as `awaiting_dispatch`.
 *
 *   Outcomes are kept apart: COMPLETED (approved here, at the final checkpoint) is never counted for a
 *   document that was only passed on. FORWARDED = left onward on its route (a unit: back to its office or
 *   on to the next unit), SENT_BACK = flagged and sent to the previous office, RETURNED = returned to the
 *   uploader by the decision.
 */

// ── Who may see what ─────────────────────────────────────────────────────────────────────────────────

export interface PerformanceScope {
  /** The account's office: a main office (department view) or an umbrella office (its own view only); null for the ADMIN. */
  office: Row | null
  /** The main office whose department is shown; null for an umbrella office's head and the ADMIN. */
  main: Row | null
  /**
   * Offices in scope. A Department Head: the account's office first, then its umbrella offices A–Z.
   * The ADMIN (organizationScope): the organization's offices, each main office followed by its umbrella offices.
   */
  offices: Row[]
}

const OFFICE_ATTRS = ['id', 'org_id', 'name', 'code', 'status', 'parent_office_id', 'is_final_checkpoint']

/**
 * Resolved from the signed-in account as loaded from the database (auth.ts), never from the request:
 *   managing Department Head of a main office          the main office and every umbrella office directly under it
 *   delegated Department Head of a main office         the same with "Manage umbrella offices" and the Umbrella
 *                                                      offices page (as for managing them); else its own office
 *   Department Head of an umbrella office              only its own office (never its siblings or its parent)
 *   no office, or an office of another organization    null (nothing to show)
 *   any other role                                     refused
 */
export async function performanceScope(actor: Actor): Promise<PerformanceScope | null> {
  if (actor.account_type !== 'DEPARTMENT_HEAD') throw forbidden('Office performance is for Department Heads')
  const office = actor.office as Row | null
  if (!office || !actor.office_id || office.id !== actor.office_id || office.org_id !== actor.org_id) return null
  if (office.parent_office_id) return { office, main: null, offices: [office] }
  const seesUnits =
    !isDelegatedHead(actor) || (hasPermission(actor, 'MANAGE_UMBRELLAS') && canOpenPage('DEPARTMENT_HEAD', parsePageAccess(actor.page_access), '/employee/umbrellas'))
  const units = seesUnits ? await Office.findAll({ where: { org_id: actor.org_id, parent_office_id: office.id }, attributes: OFFICE_ATTRS, order: [['name', 'ASC']] }) : []
  return { office, main: office, offices: [office, ...units] }
}

export interface OrganizationFilters {
  /** all (default) · main: main offices only · umbrella: umbrella offices only */
  kind: 'all' | 'main' | 'umbrella'
  /** One main office and its umbrella offices. */
  mainOfficeId: string | null
  /** One office (a main office or an umbrella office). */
  officeId: string | null
}

export function readOrganizationFilters(query: Record<string, unknown>): OrganizationFilters {
  const kind = query.kind === 'main' || query.kind === 'umbrella' ? query.kind : 'all'
  const id = (v: unknown) => (typeof v === 'string' && /^[0-9a-f-]{36}$/i.test(v) ? v : null)
  return { kind, mainOfficeId: id(query.main_office_id), officeId: id(query.office_id) }
}

/**
 * The ADMIN's view: every office of the ADMIN's own organization (actor.org_id, from the session), narrowed by
 * the filters. An office id of another organization (or none at all) is refused like one that doesn't exist.
 * Monitoring only — nothing here lets the ADMIN act for an office. Returns the whole organization's offices too,
 * for the filter choices and the office counts.
 */
export async function organizationScope(actor: Actor, filters: OrganizationFilters) {
  if (actor.account_type !== 'ADMIN') throw forbidden('Organization-wide office performance is for administrators')
  const all = await Office.findAll({ where: { org_id: actor.org_id }, attributes: OFFICE_ATTRS, order: [['name', 'ASC']] })
  const byId = new Map(all.map((o) => [o.id as string, o]))
  if (filters.mainOfficeId && (!byId.has(filters.mainOfficeId) || byId.get(filters.mainOfficeId)!.parent_office_id)) throw notFound('Main office')
  if (filters.officeId && !byId.has(filters.officeId)) throw notFound('Office')

  // Each main office, then its umbrella offices (A–Z); an umbrella office whose parent is missing goes last.
  const mains = all.filter((o) => !o.parent_office_id)
  const ordered = [...mains.flatMap((m) => [m, ...all.filter((u) => u.parent_office_id === m.id)]), ...all.filter((u) => u.parent_office_id && !byId.has(u.parent_office_id as string))]
  const offices = ordered.filter((o) => {
    if (filters.officeId) return o.id === filters.officeId
    if (filters.mainOfficeId && o.id !== filters.mainOfficeId && o.parent_office_id !== filters.mainOfficeId) return false
    if (filters.kind === 'main') return !o.parent_office_id
    if (filters.kind === 'umbrella') return Boolean(o.parent_office_id)
    return true
  })
  return { scope: { office: null, main: null, offices } as PerformanceScope, all: ordered }
}

// ── Loading ──────────────────────────────────────────────────────────────────────────────────────────

const PERSONNEL_TYPES = ['DEPARTMENT_HEAD', 'STAFF', 'LIAISON']

function periodOf(query: Record<string, unknown>) {
  const days = [7, 30, 90].includes(Number(query.days)) ? Number(query.days) : 30
  const today = phDay(new Date())
  const from = today - (days - 1) * DAY_MS
  return { days, today, from, start: from - PH_OFFSET_MS }
}

/**
 * Everything the metrics need, in a fixed number of queries (no per-office or per-document queries):
 * the visits of the offices in scope (and of a unit head's parent office, whose visits hold the unit's
 * stints) with activity in the period or a document still at one of those offices; the documents at each
 * office now; and the personnel per office.
 */
async function loadScope(actor: Actor, scope: PerformanceScope, start: number) {
  const ids = scope.offices.map((o) => o.id as string)
  const visitOffices = [...new Set([...ids, ...scope.offices.map((o) => o.parent_office_id as string | null).filter((x): x is string => Boolean(x))])]
  const esc = (v: string) => sequelize.escape(v)
  const stillHere = `document_tracking.document_id IN (SELECT d.id FROM documents d WHERE d.org_id = ${esc(actor.org_id)} AND d.current_office_id IN (${ids.map(esc).join(', ')}) AND d.status IN (${AT_OFFICE.map(esc).join(', ')}))`

  const [visits, atOffice, personnel] = await Promise.all([
    DocumentTracking.findAll({
      where: {
        office_id: { [Op.in]: visitOffices },
        step_number: { [Op.gt]: 0 },
        [Op.or]: [{ updated_at: { [Op.gte]: new Date(start) } }, literal(stillHere)],
      },
      attributes: ['id', 'document_id', 'office_id', 'step_number', 'handler_id', 'arrived_at', 'created_at', 'notes'],
      // Only the columns used here (never origin_office_id), with the organization checked on the document.
      include: [{ model: Document, as: 'document', attributes: ['id', 'status', 'current_office_id', 'current_step_number', 'target_completion_date'], where: { org_id: actor.org_id }, required: true }],
      order: [['created_at', 'ASC']],
    }),
    Document.findAll({
      where: { org_id: actor.org_id, current_office_id: { [Op.in]: ids }, status: { [Op.in]: AT_OFFICE } },
      attributes: [
        'current_office_id',
        [literal('SUM(CASE WHEN current_step_number > 0 THEN 1 ELSE 0 END)'), 'pending'],
        [literal('SUM(CASE WHEN current_step_number > 0 AND target_completion_date < NOW() THEN 1 ELSE 0 END)'), 'overdue'],
        [literal('SUM(CASE WHEN current_step_number = 0 THEN 1 ELSE 0 END)'), 'awaiting_dispatch'],
      ],
      group: ['current_office_id'],
      raw: true,
    }) as unknown as Promise<Array<{ current_office_id: string; pending: number; overdue: number; awaiting_dispatch: number }>>,
    User.findAll({
      where: { org_id: actor.org_id, office_id: { [Op.in]: ids }, account_type: { [Op.in]: PERSONNEL_TYPES }, status: { [Op.ne]: 'inactive' } },
      attributes: ['office_id', 'account_type', [fn('COUNT', col('id')), 'count']],
      group: ['office_id', 'account_type'],
      raw: true,
    }) as unknown as Promise<Array<{ office_id: string; account_type: string; count: number }>>,
  ])

  const stints = visits.flatMap((v) =>
    stintsOfVisit({ id: v.id, document_id: v.document_id, office_id: v.office_id, step_number: v.step_number, arrived_at: v.arrived_at, created_at: v.created_at, log: readLog(v) }),
  )
  const inScope = new Set(ids)
  return { ids, visits, stints: stints.filter((s) => inScope.has(s.officeId)), atOffice, personnel }
}

function officeSummary(office: Row, scope: PerformanceScope, stints: Stint[], start: number, loaded: Awaited<ReturnType<typeof loadScope>>) {
  const id = office.id as string
  const { activeIds: _a, ...m } = metricsOf(stints, start)
  const here = loaded.atOffice.find((r) => r.current_office_id === id)
  const people = loaded.personnel.filter((p) => p.office_id === id)
  const count = (type: string) => Number(people.find((p) => p.account_type === type)?.count ?? 0)
  return {
    office: {
      id,
      name: office.name as string,
      code: office.code as string,
      kind: office.parent_office_id ? ('UMBRELLA' as const) : ('MAIN' as const),
      status: office.status as string,
      parent_office_id: (office.parent_office_id as string | null) ?? null,
    },
    ...m,
    // Decides at the final checkpoint (or did in the period): only then does a completion rate mean something.
    decides: Boolean(office.is_final_checkpoint) || m.completed + m.returned > 0,
    pending: Number(here?.pending ?? 0),
    overdue: Number(here?.overdue ?? 0),
    awaiting_dispatch: Number(here?.awaiting_dispatch ?? 0),
    personnel: { heads: count('DEPARTMENT_HEAD'), staff: count('STAFF'), messengers: count('LIAISON') },
    is_own: Boolean(scope.office) && id === (scope.office!.id as string),
  }
}

// ── The department view ──────────────────────────────────────────────────────────────────────────────

const rangeOf = (period: ReturnType<typeof periodOf>) => ({ from: new Date(period.from).toISOString().slice(0, 10), to: new Date(period.today).toISOString().slice(0, 10), days: period.days })

export async function umbrellaPerformance(actor: Actor, query: Record<string, unknown>) {
  const scope = await performanceScope(actor)
  const period = periodOf(query)
  if (!scope) return { range: rangeOf(period), main_office: null, office: null, offices: [], department: null, trend: [] }
  const { offices, totals, trend } = await performanceOf(actor, scope, period)
  return {
    range: rangeOf(period),
    main_office: scope.main ? officeDto(scope.main) : null,
    office: scope.office ? officeDto(scope.office) : null,
    offices,
    department: totals,
    trend,
  }
}

/**
 * The ADMIN's organization-wide view (organizationScope): every office's own work, side by side with its main
 * office, and organization totals that count each document once. Same definitions as the department view.
 */
export async function organizationPerformance(actor: Actor, query: Record<string, unknown>) {
  const filters = readOrganizationFilters(query)
  const { scope, all } = await organizationScope(actor, filters)
  const period = periodOf(query)
  const { offices, totals, trend, cohort } = await performanceOf(actor, scope, period)
  const active = (pred: (o: Row) => boolean) => all.filter((o) => o.status !== 'inactive' && pred(o)).length
  return {
    range: rangeOf(period),
    filters: { kind: filters.kind, main_office_id: filters.mainOfficeId, office_id: filters.officeId },
    offices,
    organization: {
      ...totals,
      // Of the distinct documents the selected offices received in the period, the share approved at one of them.
      completion_rate: cohort.received ? round(cohort.completed / cohort.received, 3) : null,
      active_main_offices: active((o) => !o.parent_office_id),
      active_umbrella_offices: active((o) => Boolean(o.parent_office_id)),
    },
    trend,
    // The choices for the filters: every office of the organization.
    choices: all.map((o) => ({ id: o.id as string, name: o.name as string, code: o.code as string, parent_office_id: (o.parent_office_id as string | null) ?? null, status: o.status as string })),
  }
}

/** Per-office summaries, the scope's distinct-document totals and the daily trend (shared by both views). */
async function performanceOf(actor: Actor, scope: PerformanceScope, period: ReturnType<typeof periodOf>) {
  const loaded = await loadScope(actor, scope, period.start)
  const byOffice = (id: string) => loaded.stints.filter((s) => s.officeId === id)
  const offices = scope.offices.map((o) => officeSummary(o, scope, byOffice(o.id as string), period.start, loaded))

  // Department totals count each document once, whichever offices of the department handled it.
  const all = loaded.stints
  const distinct = (pred: (s: Stint) => boolean) => new Set(all.filter(pred).map((s) => s.docId)).size
  const leftDept = (s: Stint) => s.outcome === 'FORWARDED' && !(s.nextOfficeId && loaded.ids.includes(s.nextOfficeId))
  // Time per route step in scope (receipt → cleared), one sample each, unit time included: a unit's own time is
  // added only when the office whose step it is isn't in scope (an umbrella office's head, "umbrella offices only").
  const visitOffice = new Map(loaded.visits.map((v) => [v.id as string, v.office_id as string]))
  const topLevel = (s: Stint) => s.kind === 'STEP' || !loaded.ids.includes(visitOffice.get(s.visitId)!)
  const stepTimes = all.filter((s) => topLevel(s) && s.receivedAt && s.clearedAt && inRange(s.clearedAt, period.start) && s.clearedAt >= s.receivedAt)
  const stepAvg = avg(stepTimes.map((s) => minutesBetween(s.receivedAt!, s.clearedAt!)))
  const department = {
    received: distinct((s) => inRange(s.receivedAt, period.start)),
    completed: distinct((s) => s.outcome === 'COMPLETED' && inRange(s.endedAt, period.start)),
    returned: distinct((s) => s.outcome === 'RETURNED' && inRange(s.endedAt, period.start)),
    forwarded_out: distinct((s) => leftDept(s) && inRange(s.endedAt, period.start)),
    sent_back: distinct((s) => s.outcome === 'SENT_BACK' && inRange(s.endedAt, period.start)),
    pending: offices.reduce((n, o) => n + o.pending, 0),
    overdue: offices.reduce((n, o) => n + o.overdue, 0),
    awaiting_dispatch: offices.reduce((n, o) => n + o.awaiting_dispatch, 0),
    avg_processing_minutes: stepAvg == null ? null : round(stepAvg),
    processing_measured: stepTimes.length,
    offices: offices.length,
  }

  // Per Philippine day: distinct documents received by the department, and distinct documents completed here
  // or passed on out of the department.
  const days = daysBetween(period.from, period.today)
  const dayOf = (at: string | null) => (at ? phDay(at) : null)
  const trend = days.map((d) => ({
    date: new Date(d).toISOString().slice(0, 10),
    received: new Set(all.filter((s) => s.receivedAt && dayOf(s.receivedAt) === d).map((s) => s.docId)).size,
    completed: new Set(all.filter((s) => s.outcome === 'COMPLETED' && dayOf(s.endedAt) === d).map((s) => s.docId)).size,
    forwarded_out: new Set(all.filter((s) => leftDept(s) && dayOf(s.endedAt) === d).map((s) => s.docId)).size,
  }))

  // The cohort received in the period, and how many of those documents were approved in scope.
  const receivedDocs = new Set(all.filter((s) => inRange(s.receivedAt, period.start)).map((s) => s.docId))
  const approved = new Set(all.filter((s) => s.outcome === 'COMPLETED').map((s) => s.docId))
  const cohort = { received: receivedDocs.size, completed: [...receivedDocs].filter((d) => approved.has(d)).length }

  return { offices, totals: department, trend, cohort }
}

// ── One office in detail ─────────────────────────────────────────────────────────────────────────────

export async function officePerformanceDetail(actor: Actor, officeId: string, query: Record<string, unknown>) {
  const scope = await performanceScope(actor)
  // Only an office in the account's own scope; anything else looks like an office that doesn't exist.
  const office = scope?.offices.find((o) => o.id === officeId)
  if (!scope || !office) throw notFound('Office')
  return detailOf(actor, scope, office, query)
}

/** The ADMIN: any office of the ADMIN's own organization; another organization's office is a 404. */
export async function organizationOfficeDetail(actor: Actor, officeId: string, query: Record<string, unknown>) {
  const { scope } = await organizationScope(actor, { kind: 'all', mainOfficeId: null, officeId })
  return detailOf(actor, scope, scope.offices[0]!, query)
}

async function detailOf(actor: Actor, scope: PerformanceScope, office: Row, query: Record<string, unknown>) {
  const officeId = office.id as string
  const period = periodOf(query)
  const loaded = await loadScope(actor, scope, period.start)
  const stints = loaded.stints.filter((s) => s.officeId === officeId)
  const summary = officeSummary(office, scope, stints, period.start, loaded)

  // Who works here, and what each did in the period. Holding = received by them and still on their desk.
  const members = await User.findAll({
    where: { org_id: actor.org_id, office_id: officeId, account_type: { [Op.in]: ['DEPARTMENT_HEAD', 'STAFF'] }, status: { [Op.ne]: 'inactive' } },
    attributes: ['id', 'first_name', 'last_name', 'full_name', 'email', 'account_type', 'position', 'assigned_by'],
    order: [['first_name', 'ASC']],
  })
  const visitById = new Map(loaded.visits.map((v) => [v.id as string, v]))
  const heldBy = (s: Stint) => {
    const v = visitById.get(s.visitId)
    return !s.outcome && v?.document?.current_office_id === officeId && AT_OFFICE.includes(v.document.status) ? ((v.handler_id as string | null) ?? null) : null
  }
  const staff = members.map((m) => {
    const id = m.id as string
    const mine = stints.filter((s) => s.receivedBy === id)
    const timed = mine.filter((s) => s.clearedAt && inRange(s.clearedAt, period.start) && s.clearedAt >= s.receivedAt!)
    const proc = avg(timed.map((s) => minutesBetween(s.receivedAt!, s.clearedAt!)))
    return {
      id,
      name: ((m.full_name as string) || `${m.first_name ?? ''} ${m.last_name ?? ''}`.trim() || (m.email as string)) as string,
      account_type: m.account_type as string,
      position: (m.position as string | null) ?? null,
      received: new Set(mine.filter((s) => inRange(s.receivedAt, period.start)).map((s) => s.docId)).size,
      cleared: new Set(stints.filter((s) => s.clearedBy === id && inRange(s.clearedAt, period.start)).map((s) => s.docId)).size,
      holding: new Set(stints.filter((s) => heldBy(s) === id).map((s) => s.docId)).size,
      avg_processing_minutes: proc == null ? null : round(proc),
    }
  })

  // Documents: only ones this account may see anyway (document-queries.ts visibleWhere), with no QR code.
  const docIds = [...new Set(stints.map((s) => s.docId))]
  const [pendingDocs, visibleRows] = await Promise.all([
    Document.findAll({
      where: { org_id: actor.org_id, current_office_id: officeId, status: { [Op.in]: AT_OFFICE }, current_step_number: { [Op.gt]: 0 }, [Op.and]: [visibleWhere(actor)] },
      attributes: ['id', 'title', 'priority', 'status', 'target_completion_date', 'updated_at'],
      order: [['target_completion_date', 'ASC'], ['updated_at', 'ASC']],
      limit: 25,
    }),
    docIds.length
      ? Document.findAll({ where: { id: { [Op.in]: docIds }, org_id: actor.org_id, [Op.and]: [visibleWhere(actor)] }, attributes: ['id', 'title'] })
      : Promise.resolve([] as Row[]),
  ])
  const titleOf = new Map(visibleRows.map((d) => [d.id as string, d.title as string]))
  const docRef = (id: string) => (titleOf.has(id) ? { id, tracking_number: trackingNumber(id), title: titleOf.get(id)! } : null)
  const now = Date.now()

  const people = new Map(members.map((m) => [m.id as string, m]))
  const extraIds = [...new Set(stints.flatMap((s) => [s.receivedBy, s.clearedBy]).filter((x): x is string => Boolean(x) && !people.has(x!)))]
  if (extraIds.length) {
    for (const u of await User.findAll({ where: { id: { [Op.in]: extraIds }, org_id: actor.org_id }, attributes: ['id', 'first_name', 'last_name', 'full_name', 'email'] })) people.set(u.id as string, u)
  }
  const nameOf = (id: string | null) => {
    const u = id ? people.get(id) : null
    return u ? ((u.full_name as string) || `${u.first_name ?? ''} ${u.last_name ?? ''}`.trim() || (u.email as string)) : null
  }
  const OUTCOME_LABEL: Record<Outcome, string> = {
    COMPLETED: 'Approved here',
    RETURNED: 'Returned to the uploader',
    FORWARDED: 'Sent on to the next office',
    SENT_BACK: 'Sent back to the previous office',
    MOVED: 'Passed to the next umbrella office',
    RETURNED_TO_OFFICE: 'Returned to its office',
  }
  const activity = stints
    .flatMap((s) => {
      const out: Array<{ at: string; kind: string; label: string; by: string | null; docId: string }> = []
      if (s.arrivedAt) out.push({ at: s.arrivedAt, kind: 'ARRIVED', label: s.kind === 'UNIT' ? 'Handed to this office' : 'Arrived', by: null, docId: s.docId })
      if (s.receivedAt) out.push({ at: s.receivedAt, kind: 'RECEIVED', label: 'Received', by: s.receivedBy, docId: s.docId })
      // By: who released, sent back, decided or passed it on (not the messenger who carried it).
      if (s.outcome && s.endedAt) out.push({ at: s.endedAt, kind: s.outcome, label: OUTCOME_LABEL[s.outcome], by: s.clearedBy, docId: s.docId })
      return out
    })
    .filter((a) => inRange(a.at, period.start))
    .sort((a, b) => b.at.localeCompare(a.at))
    .slice(0, 20)
    .map((a) => ({ at: a.at, kind: a.kind, label: a.label, by: nameOf(a.by), document: docRef(a.docId) }))

  const completedHere = stints
    .filter((s) => s.outcome === 'COMPLETED' && inRange(s.endedAt, period.start))
    .sort((a, b) => b.endedAt!.localeCompare(a.endedAt!))
    .map((s) => ({ completed_at: s.endedAt, document: docRef(s.docId) }))
    .slice(0, 10)

  return {
    range: { from: new Date(period.from).toISOString().slice(0, 10), to: new Date(period.today).toISOString().slice(0, 10), days: period.days },
    summary,
    staff: staff.sort((a, b) => b.holding - a.holding || b.received - a.received || a.name.localeCompare(b.name)),
    pending_documents: pendingDocs.map((d) => {
      const target = d.target_completion_date ? new Date(d.target_completion_date as Date) : null
      return {
        id: d.id as string,
        tracking_number: trackingNumber(d.id as string),
        title: d.title as string,
        priority: d.priority as string,
        target_at: target ? target.toISOString() : null,
        overdue: Boolean(target && target.getTime() < now),
      }
    }),
    completed_documents: completedHere,
    recent_activity: activity,
  }
}
