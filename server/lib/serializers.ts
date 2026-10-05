import { Op } from 'sequelize'
import { User, type Row } from './models.ts'
import { readLog } from './tracking-log.ts'

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
  const slaHours = val(d, 'step_sla_hours')
  const fileName = d.file_url ? String(d.file_url).split('/').pop() : null
  return {
    id: d.id,
    organization_id: d.org_id,
    route_id: d.route_id,
    route_name: val(d, 'route_name') ?? null,
    tracking_number: trackingNumber(d.id),
    // The routing code printed on the document's QR label (OFFICE-CODE-12345678).
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
    target_date: d.target_completion_date ? iso(d.target_completion_date)!.slice(0, 10) : null,
    // Set from the route's total processing time when the document enters it.
    target_at: iso(d.target_completion_date),
    submitted_at: d.status === 'CREATED' ? null : iso(d.submitted_at),
    completed_at: iso(d.completed_at),
    created_at: iso(d.created_at),
    updated_at: iso(d.updated_at),
    total_steps: Number(val(d, 'total_steps') ?? 0),
    next_office_name: val(d, 'next_office_name') ?? null,
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

/** All user ids referenced by a set of visits (handlers, liaisons, event authors). */
export function referencedUserIds(doc: Row, visits: Row[]) {
  const ids = new Set<string>([doc.submitted_by])
  for (const v of visits) {
    if (v.handler_id) ids.add(v.handler_id)
    if (v.liaison_id) ids.add(v.liaison_id)
    for (const e of readLog(v)) if (e.by) ids.add(e.by)
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
  }
}
