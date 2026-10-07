import { Op } from 'sequelize'
import { User, type Row } from './models.ts'
import { pendingPass, readLog } from './tracking-log.ts'
import { parsePageAccess } from '../../shared/page-access.ts'

/**
 * The database follows the project schema (org_id, sla_days, content, …); the API
 * keeps one stable JSON shape for the pages. All mapping lives here.
 */

export const AT_OFFICE = ['START', 'ARRIVED_AT_OFFICE']
export const CARRYING = ['PICKED_UP', 'IN_TRANSIT']

const iso = (v: unknown) => (v ? new Date(v as string).toISOString() : null)
const val = (row: Row, key: string) => (typeof row.get === 'function' ? row.get(key) : (row as Record<string, unknown>)[key]) as any

/** Short, stable reference shown to people, derived from the document UUID. */
export const trackingNumber = (id: string) => `FV-${id.slice(0, 8).toUpperCase()}`

function splitName(u: Row) {
  if (u.first_name || u.last_name) return { first: u.first_name ?? '', last: u.last_name ?? '' }
  const [first = u.email ?? 'User', ...rest] = String(u.full_name ?? '').trim().split(/\s+/)
  return { first, last: rest.join(' ') }
}

export function officeDto(o: Row | null | undefined) {
  if (!o) return null
  const memberCount = val(o, 'member_count')
  return {
    id: o.id,
    code: o.code,
    name: o.name,
    // The schema has one free-text department per office; it doubles as code and name.
    department_code: o.department ?? '',
    department_name: o.department ?? '',
    location: o.address ?? null,
    is_final_checkpoint: Boolean(o.is_final_checkpoint),
    is_active: o.status !== 'inactive',
    ...(memberCount != null && { member_count: Number(memberCount) }),
  }
}

export function userSummary(u: Row | null | undefined) {
  if (!u) return null
  const { first, last } = splitName(u)
  return {
    id: u.id,
    first_name: first,
    last_name: last,
    account_type: u.account_type,
    ...(u.office !== undefined && { office: officeDto(u.office) }),
  }
}

export function liaisonDto(l: Row | null | undefined, workload = 0) {
  if (!l) return null
  const total = Number(l.total_deliveries ?? 0)
  const rate = l.success_rate == null ? 100 : Number(l.success_rate)
  const successful = Math.round((total * rate) / 100)
  return {
    id: l.id,
    user_id: l.user_id,
    department_code: l.department ?? '',
    // `available` is the messenger's own on/off switch; BUSY = a document released to them or in their hands.
    availability: !l.available ? 'OFF_DUTY' : workload > 0 ? 'BUSY' : 'AVAILABLE',
    active_jobs: workload,
    total_deliveries: total,
    successful_deliveries: successful,
    failed_deliveries: total - successful,
    success_rate: Math.round(rate * 100) / 100,
    avg_delivery_minutes: l.average_delivery_time ?? null,
    deliveries_today: l.deliveries_today ?? 0,
    last_active_at: iso(l.last_delivery),
    ...(l.user !== undefined && { user: { ...userSummary(l.user), phone: l.user?.phone ?? null, office: officeDto(l.user?.office) } }),
  }
}

export function stepDto(s: Row) {
  return {
    id: s.id,
    step_number: s.step_number,
    office_id: s.office_id,
    action_label: s.action_description || 'Review',
    sla_days: Number(s.sla_days ?? 0),
    sla_hours: Number(s.sla_hours ?? 0),
    // The step's whole processing time, in hours.
    total_hours: Number(s.sla_days ?? 0) * 24 + Number(s.sla_hours ?? 0),
    is_final_checkpoint: Boolean(s.is_final_checkpoint),
    office: officeDto(s.office),
  }
}

export function routeDto(r: Row | null | undefined) {
  if (!r) return null
  return {
    id: r.id,
    name: r.name,
    description: r.description ?? null,
    is_active: Boolean(r.is_active),
    created_at: iso(r.created_at),
    updated_at: iso(r.updated_at),
    steps: (r.steps ?? []).map(stepDto),
  }
}

/**
 * Documents must be loaded with `documentAttributes` (document-queries.ts) so the
 * current-visit columns are present. Batch-loads the liaison users in one query.
 */
export async function documentDtos(rows: Row[]) {
  // The messenger and the person who received it at the current office.
  const userIds = [...new Set(rows.flatMap((r) => [val(r, 'visit_liaison_id'), val(r, 'visit_handler_id')]).filter(Boolean))] as string[]
  const users = userIds.length ? await User.findAll({ where: { id: { [Op.in]: userIds } }, attributes: ['id', 'first_name', 'last_name', 'full_name', 'email', 'account_type'] }) : []
  const byId = new Map(users.map((u) => [u.id, u]))
  return rows.map((r) => documentDto(r, byId))
}

export async function documentDtoOne(row: Row) {
  return (await documentDtos([row]))[0]!
}

function documentDto(d: Row, usersById: Map<string, Row>) {
  const atOffice = AT_OFFICE.includes(d.status)
  const moving = CARRYING.includes(d.status)
  const handler = atOffice ? (val(d, 'visit_handler_id') as string | null) : null
  const liaisonId = atOffice || moving ? (val(d, 'visit_liaison_id') as string | null) : null
  // Flagged and on its way back to the previous office (released for it, or being carried there).
  const sendBack = String(val(d, 'send_back_raw') ?? '')
  const sentBack = liaisonId && sendBack.startsWith('"') ? { office_id: sendBack.slice(1, 37), office_name: (val(d, 'send_back_office_name') as string | null) ?? null } : null
  const slaHours = val(d, 'step_sla_hours')
  const fileName = d.file_url ? String(d.file_url).split('/').pop() : null
  return {
    id: d.id,
    organization_id: d.org_id,
    route_id: d.route_id,
    route_name: val(d, 'route_name') ?? null,
    tracking_number: trackingNumber(d.id),
    // The routing code printed on the document's QR label ({OFFICE}{MMDDYY}{6 digits}, e.g. BCC100726123456).
    qr_code: val(d, 'qr_code') ?? null,
    title: d.title,
    description: d.description ?? null,
    document_type: d.category ?? null,
    priority: d.priority,
    status: d.status,
    current_step_number: d.status === 'CREATED' ? null : d.current_step_number,
    current_office_id: d.current_office_id ?? null,
    received_at: handler ? iso(val(d, 'visit_updated_at')) : null,
    // Released to a messenger who hasn't picked it up yet (the visit's last change is the release).
    pickup_requested_at: atOffice && liaisonId ? iso(val(d, 'visit_updated_at')) : null,
    assigned_liaison_id: liaisonId,
    submitted_by: d.submitted_by,
    file_name: fileName,
    file_mime: d.file_type ?? null,
    file_size: d.file_size ?? null,
    // A bulk upload has several files under one QR; older documents have just file_url.
    file_count: Number(val(d, 'file_count') ?? 0) || (d.file_url ? 1 : 0),
    // Pages/sheets of the paper document (entered for photos; otherwise the number of files).
    pages: d.pages ?? null,
    target_date: d.target_completion_date ? iso(d.target_completion_date)!.slice(0, 10) : null,
    // Set from the route's total processing time when the document enters it.
    target_at: iso(d.target_completion_date),
    submitted_at: d.status === 'CREATED' ? null : iso(d.submitted_at),
    completed_at: iso(d.completed_at),
    created_at: iso(d.created_at),
    updated_at: iso(d.updated_at),
    total_steps: Number(val(d, 'total_steps') ?? 0),
    next_office_name: sentBack ? sentBack.office_name : (val(d, 'next_office_name') ?? null),
    sent_back: sentBack,
    open_issues: Number(val(d, 'open_issues') ?? 0),
    step_sla_hours: slaHours == null ? null : Number(slaHours),
    step_entered_at: iso(val(d, 'visit_arrived_at')),
    currentOffice: officeDto(d.currentOffice),
    submitter: userSummary(d.submitter),
    liaison: liaisonId ? userSummary(usersById.get(liaisonId)) : null,
    received_by: handler ? userSummary(usersById.get(handler)) : null,
    // Where the document comes from: the uploader's office, or their organization (CLIENT accounts).
    origin: val(d, 'origin_office_id')
      ? { kind: 'OFFICE' as const, office_id: val(d, 'origin_office_id') as string, name: val(d, 'origin_office_name') as string }
      : { kind: 'ORGANIZATION' as const, office_id: null, name: (val(d, 'org_name') as string | null) ?? 'Organization' },
  }
}

/**
 * Flatten a document's visits (each with its JSON event log) into the timeline the
 * UI renders. `users` must contain every user referenced by the events.
 */
export function timelineEvents(doc: Row, visits: Row[], users: Map<string, Row>) {
  const events = [
    {
      id: `created-${doc.id}`,
      event_type: 'CREATED',
      status_after: 'CREATED',
      step_number: null as number | null,
      remarks: null as string | null,
      metadata: null as Record<string, unknown> | null,
      created_at: iso(doc.created_at)!,
      actor: userSummary(users.get(doc.submitted_by)),
      office: null as ReturnType<typeof officeLite>,
    },
  ]
  for (const visit of visits) {
    for (const e of readLog(visit)) {
      events.push({
        id: e.id,
        event_type: e.type,
        status_after: e.status,
        step_number: visit.step_number,
        remarks: e.remarks ?? null,
        metadata: e.meta ?? null,
        created_at: e.at,
        actor: e.by ? userSummary(users.get(e.by)) : null,
        office: officeLite(visit.office),
      })
    }
  }
  return events.sort((a, b) => a.created_at.localeCompare(b.created_at))
}

const officeLite = (o: Row | null | undefined) => (o ? { id: o.id, code: o.code, name: o.name } : null)

const minutesBetween = (from: string | null | undefined, to: string | null | undefined) =>
  from && to ? Math.max(0, Math.round(((new Date(to).getTime() - new Date(from).getTime()) / 60_000) * 10) / 10) : null

/**
 * The document's path office by office: for every visit, what happened inside the office
 * (arrival, receipt, notes, release to a messenger, pickup) up to the hand-over to the next
 * office, with how long each stage took. `offices` must contain every office referenced by
 * the visits' events (from/next office ids).
 */
export function routingVisits(visits: Row[], users: Map<string, Row>, offices: Map<string, Row>) {
  const now = new Date().toISOString()
  const person = (id: unknown) => (typeof id === 'string' ? userSummary(users.get(id)) : null)
  const office = (id: unknown) => (typeof id === 'string' ? officeLite(offices.get(id)) : null)

  return visits.map((visit, index) => {
    const log = readLog(visit)
    const first = (...types: string[]) => log.find((e) => types.includes(e.type))
    const last = (...types: string[]) => log.filter((e) => types.includes(e.type)).at(-1)

    const entry = first('ARRIVED', 'SUBMITTED', 'RESUBMITTED')
    const arrivedAt = entry?.at ?? iso(visit.arrived_at) ?? iso(visit.created_at)!
    const received = first('RECEIVED')
    const release = last('PICKUP_REQUESTED', 'MESSENGER_REASSIGNED', 'SENT_BACK')
    const pickedUp = last('PICKED_UP')
    const decision = last('APPROVED', 'RETURNED')
    const failed = last('DELIVERY_FAILED')
    // Still here (or still being carried away) when nothing closed the visit.
    const open = !visit.completed_at || ['START', 'ARRIVED_AT_OFFICE', 'PICKED_UP', 'IN_TRANSIT'].includes(visit.status)
    const nextVisit = visits[index + 1]

    let state: 'AT_OFFICE' | 'IN_TRANSIT' | 'TRANSFERRED' | 'APPROVED' | 'RETURNED' | 'CLOSED'
    if (decision) state = decision.type === 'APPROVED' ? 'APPROVED' : 'RETURNED'
    else if (pickedUp && (!failed || failed.at < pickedUp.at)) state = nextVisit && visit.status === 'COMPLETED' ? 'TRANSFERRED' : 'IN_TRANSIT'
    else if (open) state = 'AT_OFFICE'
    // Carried over by hand (no messenger): the next office scanned it in straight from here.
    else state = nextVisit && readLog(nextVisit).some((e) => e.type === 'ARRIVED') ? 'TRANSFERRED' : 'CLOSED'

    // When the paper left the office: picked up by the messenger, or decided here.
    const leftAt = pickedUp?.at ?? decision?.at ?? (open ? null : iso(visit.completed_at))
    const processedUntil = release?.at ?? decision?.at ?? leftAt ?? (state === 'AT_OFFICE' ? now : null)
    const toOfficeId = (pickedUp?.meta?.next_office_id ?? release?.meta?.next_office_id ?? null) as string | null
    const pass = state === 'AT_OFFICE' ? pendingPass(visit) : null

    // Desk by desk inside the office: each staff member who received it, until they passed it on.
    const desks: Array<{ staff: ReturnType<typeof person>; received_at: string; passed_at: string | null; remarks: string | null; minutes: number | null; current: boolean }> = []
    for (const e of log) {
      const desk = desks.at(-1)
      if (e.type === 'RECEIVED') desks.push({ staff: person(e.by), received_at: e.at, passed_at: null, remarks: null, minutes: null, current: false })
      else if (e.type === 'PASSED_TO_STAFF' && desk) Object.assign(desk, { passed_at: e.at, remarks: e.remarks ?? null })
      else if (e.type === 'PASS_CANCELLED' && desk) Object.assign(desk, { passed_at: null, remarks: null })
    }
    desks.forEach((d, i) => {
      const holding = i === desks.length - 1 && !d.passed_at
      d.current = holding && state === 'AT_OFFICE'
      const until = d.passed_at ?? (holding ? (release && release.at >= d.received_at ? release.at : (decision?.at ?? leftAt ?? (d.current ? now : null))) : null)
      d.minutes = minutesBetween(d.received_at, until)
    })

    return {
      id: visit.id as string,
      step_number: visit.step_number as number,
      office: officeLite(visit.office),
      state,
      arrived_at: arrivedAt,
      arrival: entry
        ? {
            kind: entry.type as 'ARRIVED' | 'SUBMITTED' | 'RESUBMITTED',
            from_office: office(entry.meta?.from_office_id),
            messenger: entry.type === 'ARRIVED' ? person(entry.by) : null,
            by_hand: Boolean(entry.meta?.by_hand),
            delivery_minutes: typeof entry.meta?.delivery_minutes === 'number' ? (entry.meta.delivery_minutes as number) : null,
          }
        : null,
      received_at: received?.at ?? null,
      received_by: person(received?.by ?? visit.handler_id),
      released_at: release?.at ?? null,
      released_by: person(release?.by),
      messenger: person(release?.meta?.liaison_id ?? visit.liaison_id),
      picked_up_at: pickedUp?.at ?? null,
      decided_at: decision?.at ?? null,
      decided_by: person(decision?.by),
      left_at: leftAt,
      to_office: office(toOfficeId) ?? (state === 'TRANSFERRED' ? officeLite(nextVisit?.office) : null),
      // Flagged with an issue and sent back to the previous office (instead of forward).
      sent_back: release ? Boolean(release.type === 'SENT_BACK' || release.meta?.send_back_to) : false,
      desks,
      // Passed to the next staff and not received at the next desk yet: no messenger until it is.
      pending_pass: pass ? { by: person(pass.by), at: pass.at, remarks: pass.remarks ?? null } : null,
      durations: {
        // Arrival → scanned in by the office.
        waiting_receipt: received ? minutesBetween(arrivedAt, received.at) : state === 'AT_OFFICE' ? minutesBetween(arrivedAt, now) : null,
        // Received → released to a messenger (or decided).
        processing: received ? minutesBetween(received.at, processedUntil) : null,
        // Released → messenger picked it up.
        waiting_pickup: release ? minutesBetween(release.at, pickedUp && pickedUp.at >= release.at ? pickedUp.at : state === 'AT_OFFICE' ? now : null) : null,
        total: minutesBetween(arrivedAt, leftAt ?? (open ? now : null)),
      },
      events: log.map((e) => ({
        id: e.id,
        type: e.type,
        at: e.at,
        actor: person(e.by),
        remarks: e.remarks ?? null,
        messenger: ['PICKUP_REQUESTED', 'MESSENGER_REASSIGNED', 'SENT_BACK'].includes(e.type) ? person(e.meta?.liaison_id) : null,
        // A receipt from the previous desk of the same office.
        from_staff: person(e.meta?.from_staff_id),
      })),
    }
  })
}

/** Office ids referenced by visit events (where a delivery came from / was heading). */
export function referencedOfficeIds(visits: Row[]) {
  const ids = new Set<string>()
  for (const v of visits) {
    if (v.office_id) ids.add(v.office_id)
    for (const e of readLog(v)) {
      for (const key of ['from_office_id', 'next_office_id']) if (typeof e.meta?.[key] === 'string') ids.add(e.meta[key] as string)
    }
  }
  return [...ids]
}

/** All user ids referenced by a set of visits (handlers, liaisons, event authors). */
export function referencedUserIds(doc: Row, visits: Row[]) {
  const ids = new Set<string>([doc.submitted_by])
  for (const v of visits) {
    if (v.handler_id) ids.add(v.handler_id)
    if (v.liaison_id) ids.add(v.liaison_id)
    for (const e of readLog(v)) {
      if (e.by) ids.add(e.by)
      if (typeof e.meta?.liaison_id === 'string') ids.add(e.meta.liaison_id)
      if (typeof e.meta?.from_staff_id === 'string') ids.add(e.meta.from_staff_id)
    }
  }
  return [...ids]
}

export function approvalDto(a: Row, document?: unknown) {
  return {
    id: a.id,
    document_id: a.document_id,
    office_id: a.office_id,
    status: a.status,
    requested_at: iso(a.created_at),
    decided_at: a.status === 'PENDING' ? null : iso(a.approved_at),
    remarks: a.remarks ?? null,
    decider: a.status === 'PENDING' ? null : userSummary(a.staff),
    office: officeLite(a.office),
    ...(document !== undefined && { document }),
  }
}

export function messageDto(m: Row) {
  const threadType = m.conversation_type === 'GROUP' ? 'DOCUMENT' : m.conversation_type
  return {
    id: m.id,
    thread_type: threadType,
    sender_id: m.sender_id,
    recipient_id: m.recipient_id ?? null,
    document_id: m.document_id ?? null,
    office_id: threadType === 'OFFICE' ? (m.sender?.office_id ?? null) : null,
    body: m.content,
    is_read: Boolean(m.is_read),
    created_at: iso(m.created_at),
    ...(m.sender !== undefined && { sender: userSummary(m.sender) }),
  }
}

export function notificationDto(n: Row) {
  return {
    id: n.id,
    type: n.type,
    title: n.title ?? n.message,
    body: n.title ? n.message : null,
    document_id: n.document_id ?? null,
    link: n.action_url ?? null,
    is_read: Boolean(n.is_read),
    created_at: iso(n.created_at),
  }
}

export function issueDto(i: Row) {
  return {
    id: i.id,
    title: i.title,
    description: i.description ?? null,
    category: i.issue_type ?? 'OTHER',
    severity: i.priority,
    status: i.status,
    resolution: i.resolution_notes ?? null,
    created_at: iso(i.reported_at ?? i.created_at),
    resolved_at: iso(i.resolved_at),
    reported_by: i.reported_by,
    assigned_to: i.assigned_to ?? null,
    document: i.document ? { id: i.document.id, tracking_number: trackingNumber(i.document.id), title: i.document.title, status: i.document.status } : null,
    reporter: userSummary(i.reporter),
    assignee: userSummary(i.assignee),
  }
}

/** Full roster entry (CLIENT only). */
export function memberDto(u: Row) {
  const { first, last } = splitName(u)
  return {
    id: u.id,
    email: u.email,
    first_name: first,
    last_name: last,
    phone: u.phone ?? null,
    account_type: u.account_type,
    status: u.status === 'inactive' ? 'SUSPENDED' : 'ACTIVE',
    must_change_password: u.status === 'pending',
    office_id: u.office_id ?? null,
    office: officeDto(u.office),
    last_login_at: iso(u.last_login),
    liaisonProfile: liaisonDto(u.liaisonProfile),
    page_access: parsePageAccess(u.page_access),
  }
}
