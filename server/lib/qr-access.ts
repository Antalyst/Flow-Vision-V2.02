import { Op } from 'sequelize'
import { Document, DocumentTracking, QrCode, sequelize, type Row } from './models.ts'
import { forbidden, notFound } from './errors.ts'
import type { Actor } from './auth.ts'
import { AT_OFFICE, CARRYING } from './serializers.ts'
import { readLog, sortVisits } from './tracking-log.ts'
import { incomingHereIds, loadDocumentDto } from './document-queries.ts'

const isOfficeStaff = (actor: Actor) => actor.account_type === 'DEPARTMENT_HEAD' || actor.account_type === 'STAFF'

/**
 * Who may see a document's QR code (the routing code, its image, the printed label). One policy for every
 * place it can appear: the document page, lists, the dashboard, searches, the activity log, the AI
 * assistant, the QR endpoint, label printing and "Replace label". Whoever holds the code can scan it, and a
 * scan is how FlowVision records receipt — so the code goes only to whoever physically has the document.
 *
 * Authoritative data: documents.submitted_by (creator), documents.current_office_id (the office or umbrella
 * office holding it — while an internal route or hand-off runs, the unit; while carried, still the sending
 * office), documents.status, the current visit (its messenger and its event log: who received it, and when
 * it last changed hands), and the route (where a carried document is heading).
 *
 *   ADMIN                    yes (administers the organization)
 *   messenger                only the messenger assigned to it now (released to them, or carrying it)
 *   draft                    its uploader (and the ADMIN)
 *   on its way to your office  no — whatever your role, even its uploader: the label comes with the paper
 *   its creator (uploader)   yes, otherwise
 *   office staff / heads     the office (or umbrella office) holding it, once it has been received there:
 *                              · at the origin (before the first office): the origin office
 *                              · at an office: after that office scanned it in, since it last changed hands
 *                                (a desk-to-desk pass inside the office keeps it received)
 *                              · being carried: the sending office
 *                              · completed: the last office (the label is retired)
 *   anyone else              no — in particular the parent office or a sibling umbrella office while one
 *                              unit holds it, the next office before it arrives, and any other office
 */

/** Events after which the document is with a new holder that has not scanned it in yet. */
const CHANGED_HANDS = new Set([
  'ARRIVED',
  'HANDED_TO_UMBRELLA',
  'RETURNED_FROM_UMBRELLA',
  'INTERNAL_ROUTE_STARTED',
  'INTERNAL_ROUTE_MOVED',
  'INTERNAL_ROUTE_COMPLETED',
  'INTERNAL_ROUTE_ENDED',
  'DELIVERY_FAILED',
])

/** Has the current holder (office or unit) scanned the document in since it last changed hands? */
export function receivedAtHolder(visit: Row | null | undefined) {
  if (!visit) return false
  const log = readLog(visit)
  let lastChange = -1
  log.forEach((e, i) => {
    if (CHANGED_HANDS.has(e.type)) lastChange = i
  })
  // An arrival is logged with its receipt (ARRIVED then RECEIVED): look after the change.
  if (log.slice(lastChange + 1).some((e) => e.type === 'RECEIVED')) return true
  // A visit with no change of hands at all (e.g. started before the event log existed): its receiver decides.
  return lastChange === -1 && Boolean(visit.handler_id)
}

export interface QrFacts {
  doc: Row
  visit: Row | null
  /** On its way to the actor's office right now (see document-queries.ts incomingHereIds). */
  incomingHere: boolean
}

/** The policy above, for one document. Pure: the caller loads the facts (qrAccessibleIds does it in bulk). */
export function canAccessQr(actor: Actor, { doc, visit, incomingHere }: QrFacts): boolean {
  if (!actor || doc.org_id !== actor.org_id) return false
  if (actor.account_type === 'ADMIN') return true
  if (actor.account_type === 'LIAISON') {
    return Boolean(visit) && visit!.liaison_id === actor.id && (AT_OFFICE.includes(doc.status) || CARRYING.includes(doc.status))
  }
  if (doc.status === 'CREATED') return doc.submitted_by === actor.id
  if (incomingHere) return false
  if (doc.submitted_by === actor.id) return true
  if (!isOfficeStaff(actor) || !actor.office_id || actor.office_id !== doc.current_office_id) return false
  if (doc.status === 'COMPLETED') return true
  if (doc.status === 'RETURNED') return false
  if (CARRYING.includes(doc.status)) return true
  if (!AT_OFFICE.includes(doc.status)) return false
  if (doc.current_step_number === 0) return true
  return receivedAtHolder(visit)
}

/** Which of these documents' QR codes the actor may see. Four queries, whatever the number of documents. */
export async function qrAccessibleIds(actor: Actor, ids: string[]) {
  const unique = [...new Set(ids.filter(Boolean))]
  if (!unique.length) return new Set<string>()
  if (actor.account_type === 'ADMIN') {
    const docs = await Document.findAll({ where: { id: { [Op.in]: unique }, org_id: actor.org_id }, attributes: ['id'], raw: true })
    return new Set((docs as unknown as Array<{ id: string }>).map((d) => d.id))
  }
  const [docs, incoming] = await Promise.all([
    Document.findAll({ where: { id: { [Op.in]: unique }, org_id: actor.org_id }, attributes: ['id', 'org_id', 'status', 'submitted_by', 'current_office_id', 'current_step_number'] }),
    incomingHereIds(actor, unique),
  ])
  const visits = docs.length
    ? await DocumentTracking.findAll({
        where: { [Op.or]: docs.map((d) => ({ document_id: d.id, step_number: d.current_step_number })) },
        attributes: ['id', 'document_id', 'step_number', 'handler_id', 'liaison_id', 'notes', 'created_at'],
      })
    : []
  const byDoc = new Map<string, Row[]>()
  for (const v of visits) byDoc.set(v.document_id as string, [...(byDoc.get(v.document_id as string) ?? []), v])
  const allowed = new Set<string>()
  for (const doc of docs) {
    const visit = sortVisits(byDoc.get(doc.id as string) ?? []).at(-1) ?? null
    if (canAccessQr(actor, { doc, visit, incomingHere: incoming.has(doc.id as string) })) allowed.add(doc.id as string)
  }
  return allowed
}

export async function hasQrAccess(actor: Actor, documentId: string) {
  return (await qrAccessibleIds(actor, [documentId])).has(documentId)
}

/** For endpoints that hand out the QR code itself: not found, or 403 when the document is visible but its QR is not. */
export async function assertQrAccess(actor: Actor, documentId: string) {
  if (await hasQrAccess(actor, documentId)) return
  const exists = await Document.count({ where: { id: documentId, org_id: actor.org_id } })
  if (!exists) throw notFound('Document')
  throw forbidden('You can’t see this document’s QR code: it goes to whoever has the document, once they have scanned it in')
}

/** Remove the QR code from documents (DTOs) whose QR the actor may not see; `qr_hidden` tells the page why. */
export async function applyQrPolicy<T extends { id: string; qr_code?: string | null }>(docs: T[], actor: Actor): Promise<T[]> {
  const withCode = docs.filter((d) => d.qr_code)
  if (!withCode.length) return docs
  const allowed = await qrAccessibleIds(actor, withCode.map((d) => d.id))
  return docs.map((d) => (d.qr_code && !allowed.has(d.id) ? { ...d, qr_code: null, qr_hidden: true } : d))
}

/** A document in its API shape, with its QR code only if the actor may see it. */
export async function loadDocumentFor(id: string, actor: Actor) {
  const dto = await loadDocumentDto(id)
  return dto ? (await applyQrPolicy([dto], actor))[0]! : null
}

/**
 * Searching by QR code (or part of it): only documents whose QR the actor may see can match, or a search
 * would reveal a hidden code one character at a time. Returns the matching ids (at most `limit`), for an
 * `id IN (…)` condition next to the other search terms.
 */
export async function qrSearchIds(actor: Actor, likePattern: string, limit = 200) {
  const rows = (await QrCode.findAll({
    where: { qr_code_data: { [Op.like]: likePattern } },
    attributes: ['document_id'],
    include: [{ model: Document, as: 'document', attributes: [], where: { org_id: actor.org_id }, required: true }],
    limit,
    raw: true,
  })) as unknown as Array<{ document_id: string }>
  const allowed = await qrAccessibleIds(actor, rows.map((r) => r.document_id))
  return [...allowed]
}

/** SQL-safe "id IN (…)" for those ids (a never-true condition when there are none). */
export const idsCondition = (ids: string[]) => (ids.length ? { id: { [Op.in]: ids } } : sequelize.literal('1 = 0'))

export interface RoutingSlip {
  subject: string
  document_type: string | null
  origin_office: string | null
  first_destination: string | null
  final_destination: string | null
  priority: string
  registered_by: string | null
  /** When the document was registered (uploaded), ISO; shown as date and time in Philippine time. */
  registered_at: string | null
}

type SlipDoc = {
  title: string
  document_type?: string | null
  priority: string
  created_at?: string | null
  origin?: { name: string | null } | null
  submitter?: { first_name?: string | null; last_name?: string | null } | null
}
type SlipRoute = { steps?: Array<{ step_number: number; office?: { name?: string | null } | null }> } | null

/**
 * The document-information table of the routing slip (printed under the QR). From what was registered,
 * never from where the document is now: the uploader's office, the organization route's first and last
 * office (an internal route or umbrella hand-off never changes these), and the time it was registered.
 * Only sent together with the QR itself (callers check qr access first).
 */
export function routingSlipOf(doc: SlipDoc, route: SlipRoute): RoutingSlip {
  const steps = [...(route?.steps ?? [])].sort((a, b) => a.step_number - b.step_number)
  const name = [doc.submitter?.first_name, doc.submitter?.last_name].filter(Boolean).join(' ').trim()
  return {
    subject: doc.title,
    document_type: doc.document_type ?? null,
    origin_office: doc.origin?.name ?? null,
    first_destination: steps[0]?.office?.name ?? null,
    final_destination: steps.at(-1)?.office?.name ?? null,
    priority: doc.priority,
    registered_by: name || null,
    registered_at: doc.created_at ?? null,
  }
}
