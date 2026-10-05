import { Op, type WhereOptions } from 'sequelize'
import { sequelize, AuditLog, Document, DocumentTracking, Office, QrCode, User, type Row } from './models.ts'
import { badRequest } from './errors.ts'
import { readLog } from './tracking-log.ts'
import { trackingNumber, userSummary } from './serializers.ts'
import type { Actor } from './auth.ts'

/**
 * The activity log: who did what, when — for accountability. It merges three sources:
 *   document_tracking.notes   every step of every document (received, released, picked up, …)
 *   documents                 when each document was created
 *   audit_logs                administration (accounts, offices, routes, issues)
 *
 * What an account sees:
 *   everyone   `mine`          their own actions
 *   CLIENT     `organization`  everything in the organization
 *   EMPLOYEE   `office`        everything that happened at their office, everything done by the
 *                              people of their office (its staff and messengers), and by the
 *                              messengers they created
 */
export const ACTIVITY_SCOPES = ['mine', 'office', 'organization'] as const
export type ActivityScope = (typeof ACTIVITY_SCOPES)[number]
export const ACTIVITY_CATEGORIES = ['all', 'documents', 'messengers', 'approvals', 'admin'] as const
export type ActivityCategory = (typeof ACTIVITY_CATEGORIES)[number]

const MESSENGER_EVENTS = new Set(['PICKUP_REQUESTED', 'MESSENGER_REASSIGNED', 'PICKED_UP', 'IN_TRANSIT', 'ARRIVED', 'DELIVERY_FAILED'])
const APPROVAL_EVENTS = new Set(['APPROVAL_REQUESTED', 'APPROVED', 'RETURNED', 'COMPLETED'])
// Covered by document events already, or too noisy to be useful here.
const SKIPPED_AUDIT = new Set(['LOGIN', 'DOCUMENT_CREATE', 'DOCUMENT_SUBMIT', 'APPROVAL_APPROVED', 'APPROVAL_RETURNED'])
// Visits are loaded newest first; enough for a long page of results without scanning everything.
const MAX_VISITS = 3000

export function scopesFor(actor: Actor): ActivityScope[] {
  if (actor.account_type === 'CLIENT') return ['organization', 'mine']
  if (actor.account_type === 'EMPLOYEE' && actor.office_id) return ['office', 'mine']
  return ['mine']
}

export interface ActivityQuery {
  scope: ActivityScope
  category: ActivityCategory
  since: Date
  /** Cursor: only events strictly older than this (ISO). */
  before: string | null
  q: string
  limit: number
}

interface RawEvent {
  id: string
  type: string
  at: string
  by: string | null
  remarks: string | null
  meta: Record<string, unknown> | null
  step_number: number | null
  office_id: string | null
  document_id: string | null
  /** Admin actions: a short description of what was changed. */
  summary: string | null
  category: Exclude<ActivityCategory, 'all'>
}

const categoryOf = (type: string): RawEvent['category'] => (MESSENGER_EVENTS.has(type) ? 'messengers' : APPROVAL_EVENTS.has(type) ? 'approvals' : 'documents')

/** The people whose actions an EMPLOYEE follows: their office's members, and the messengers they created. */
async function officePeople(actor: Actor) {
  const [members, invited] = await Promise.all([
    User.findAll({ where: { org_id: actor.org_id, office_id: actor.office_id }, attributes: ['id'] }),
    AuditLog.findAll({ where: { user_id: actor.id, action: 'USER_INVITE', entity_type: 'user' }, attributes: ['entity_id', 'new_values'] }),
  ])
  const createdMessengers = invited.filter((a) => (a.new_values as { account_type?: string } | null)?.account_type === 'LIAISON').map((a) => a.entity_id as string)
  return new Set<string>([...members.map((u) => u.id as string), ...createdMessengers, actor.id])
}

const likeBy = (id: string) => ({ notes: { [Op.like]: `%"by":"${id}"%` } })

function auditSummary(a: Row) {
  const after = (a.new_values ?? {}) as Record<string, any>
  const before = (a.old_values ?? {}) as Record<string, any>
  const name = after.name ?? after.title ?? after.email ?? before.name ?? before.title ?? before.email ?? null
  const extra = after.account_type ? ` (${String(after.account_type).toLowerCase()})` : ''
  return name ? `${name}${extra}` : null
}

export async function activityLog(actor: Actor, query: ActivityQuery) {
  if (!scopesFor(actor).includes(query.scope)) throw badRequest('You can’t view that activity log')
  const { scope, since } = query
  const people = scope === 'office' ? await officePeople(actor) : null
  const peopleIds = people ? [...people] : []
  const wantDocs = query.category !== 'admin'
  const wantAdmin = query.category === 'all' || query.category === 'admin'

  // 1. Document steps, from each visit's event log.
  const visitWhere: WhereOptions[] = [{ updated_at: { [Op.gte]: since } }]
  if (scope === 'mine') visitWhere.push(likeBy(actor.id))
  if (scope === 'office') visitWhere.push({ [Op.or]: [{ office_id: actor.office_id }, ...peopleIds.map(likeBy)] })
  const visits = wantDocs
    ? await DocumentTracking.findAll({
        where: { [Op.and]: visitWhere },
        include: [{ model: Document, as: 'document', where: { org_id: actor.org_id }, attributes: ['id'], required: true }],
        order: [['updated_at', 'DESC']],
        limit: MAX_VISITS,
      })
    : []

  const events: RawEvent[] = []
  const sinceIso = since.toISOString()
  for (const visit of visits) {
    for (const e of readLog(visit)) {
      if (e.at < sinceIso) continue
      const mine = e.by === actor.id
      if (scope === 'mine' && !mine) continue
      if (scope === 'office' && visit.office_id !== actor.office_id && !(e.by && people!.has(e.by))) continue
      events.push({
        id: e.id,
        type: e.type,
        at: e.at,
        by: e.by,
        remarks: e.remarks ?? null,
        meta: e.meta ?? null,
        step_number: visit.step_number,
        office_id: visit.office_id ?? null,
        document_id: visit.document_id,
        summary: null,
        category: categoryOf(e.type),
      })
    }
  }

  // 2. Document creation (uploads).
  if (wantDocs && (query.category === 'all' || query.category === 'documents')) {
    const docWhere: WhereOptions = { org_id: actor.org_id, created_at: { [Op.gte]: since } }
    if (scope === 'mine') Object.assign(docWhere, { submitted_by: actor.id })
    if (scope === 'office') Object.assign(docWhere, { submitted_by: { [Op.in]: peopleIds } })
    const created = await Document.findAll({ where: docWhere, attributes: ['id', 'submitted_by', 'created_at'], order: [['created_at', 'DESC']], limit: MAX_VISITS })
    for (const d of created) {
      events.push({
        id: `created-${d.id}`,
        type: 'CREATED',
        at: new Date(d.created_at).toISOString(),
        by: d.submitted_by,
        remarks: null,
        meta: null,
        step_number: null,
        office_id: null,
        document_id: d.id,
        summary: null,
        category: 'documents',
      })
    }
  }

  // 3. Administration.
  if (wantAdmin) {
    const auditWhere: WhereOptions = { created_at: { [Op.gte]: since }, action: { [Op.notIn]: [...SKIPPED_AUDIT] } }
    if (scope === 'mine') Object.assign(auditWhere, { user_id: actor.id })
    else if (scope === 'office') Object.assign(auditWhere, { user_id: { [Op.in]: peopleIds } })
    else Object.assign(auditWhere, { user_id: { [Op.in]: sequelize.literal(`(SELECT u.id FROM users u WHERE u.org_id = ${sequelize.escape(actor.org_id)})`) } })
    const audits = await AuditLog.findAll({ where: auditWhere, order: [['created_at', 'DESC']], limit: 1000 })
    for (const a of audits) {
      events.push({
        id: `audit-${a.id}`,
        type: a.action,
        at: new Date(a.created_at).toISOString(),
        by: a.user_id ?? null,
        remarks: null,
        meta: { entity_type: a.entity_type },
        step_number: null,
        office_id: null,
        document_id: a.entity_type === 'document' ? a.entity_id : null,
        summary: auditSummary(a),
        category: 'admin',
      })
    }
  }

  // Filter, sort newest first, page with a cursor.
  const filtered = events.filter((e) => (query.category === 'all' || e.category === query.category) && (!query.before || e.at < query.before))
  filtered.sort((a, b) => b.at.localeCompare(a.at))

  // Resolve people, offices and documents in bulk.
  const userIds = new Set<string>()
  for (const e of filtered) {
    if (e.by) userIds.add(e.by)
    for (const k of ['liaison_id', 'previous_liaison_id', 'received_by']) {
      const v = e.meta?.[k]
      if (typeof v === 'string') userIds.add(v)
    }
  }
  const docIds = [...new Set(filtered.map((e) => e.document_id).filter(Boolean))] as string[]
  const officeIds = [...new Set(filtered.flatMap((e) => [e.office_id, e.meta?.next_office_id as string | undefined]).filter(Boolean))] as string[]
  const [users, docs, qrs, offices] = await Promise.all([
    userIds.size ? User.findAll({ where: { id: { [Op.in]: [...userIds] } }, attributes: ['id', 'first_name', 'last_name', 'full_name', 'email', 'account_type', 'office_id'], include: [{ model: Office, as: 'office', attributes: ['id', 'name'] }] }) : [],
    docIds.length ? Document.findAll({ where: { id: { [Op.in]: docIds } }, attributes: ['id', 'title', 'status', 'submitted_by'] }) : [],
    docIds.length ? QrCode.findAll({ where: { document_id: { [Op.in]: docIds } }, attributes: ['document_id', 'qr_code_data'] }) : [],
    officeIds.length ? Office.findAll({ where: { id: { [Op.in]: officeIds } }, attributes: ['id', 'name', 'code'] }) : [],
  ])
  const userById = new Map(users.map((u) => [u.id as string, u]))
  const docById = new Map(docs.map((d) => [d.id as string, d]))
  const qrByDoc = new Map(qrs.map((q) => [q.document_id as string, q.qr_code_data as string]))
  const officeById = new Map(offices.map((o) => [o.id as string, o]))
  const personName = (id: unknown) => {
    const u = typeof id === 'string' ? userById.get(id) : null
    return u ? (u.full_name as string) || [u.first_name, u.last_name].filter(Boolean).join(' ') || (u.email as string) : null
  }

  const rows = filtered.map((e) => {
    const doc = e.document_id ? docById.get(e.document_id) : null
    const office = e.office_id ? officeById.get(e.office_id) : null
    const nextOffice = typeof e.meta?.next_office_id === 'string' ? officeById.get(e.meta.next_office_id) : null
    return {
      id: e.id,
      event_type: e.type,
      category: e.category,
      created_at: e.at,
      step_number: e.step_number,
      remarks: e.remarks,
      summary: e.summary,
      actor: e.by ? userSummary(userById.get(e.by)) : null,
      office: office ? { id: office.id, name: office.name, code: office.code } : e.step_number === 0 ? { id: null, name: 'Origin', code: '' } : null,
      // Who else was involved: the messenger, the one replaced, the person who received it, where it was going.
      messenger: personName(e.meta?.liaison_id),
      previous_messenger: personName(e.meta?.previous_liaison_id),
      received_by: personName(e.meta?.received_by),
      next_office: nextOffice ? (nextOffice.name as string) : null,
      document: doc ? { id: doc.id, title: doc.title, status: doc.status, tracking_number: trackingNumber(doc.id), qr_code: qrByDoc.get(doc.id) ?? null } : null,
    }
  })

  // Free-text search over the readable parts.
  const q = query.q.trim().toLowerCase()
  const searched = q
    ? rows.filter((r) =>
        [r.document?.title, r.document?.qr_code, r.document?.tracking_number, r.summary, r.remarks, r.office?.name, r.messenger, r.received_by, r.actor ? `${r.actor.first_name} ${r.actor.last_name}` : null]
          .filter(Boolean)
          .some((s) => String(s).toLowerCase().includes(q)),
      )
    : rows

  const page = searched.slice(0, query.limit)
  return {
    data: page,
    next_before: searched.length > query.limit ? page[page.length - 1]!.created_at : null,
    scope,
    scopes: scopesFor(actor),
  }
}
