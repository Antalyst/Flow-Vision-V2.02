import { Op, QueryTypes, Transaction } from 'sequelize'
import { sequelize, Approval, Document, DocumentTracking, Liaison, Office, Organization, QrCode, User, type Row } from './models.ts'
import { badRequest, conflict, forbidden, notFound } from './errors.ts'
import type { Actor, RequestMeta } from './auth.ts'
import { getLiveRoute, getStep, routeForNewDocument, routeHoursOf } from './routes.ts'
import { processingHoursFor } from './knowledge.ts'
import { autoPriority } from './priority.ts'
import { buildRoutingCode, organizationCode, parseRoutingCode, renderQr } from './qr.ts'
import { notify, officeMemberIds } from './notifications.ts'
import { emitAfterCommit } from './realtime.ts'
import { recordOutcome } from './liaisons.ts'
import { audit } from './audit.ts'
import { appendLog, readLog } from './tracking-log.ts'
import { liaisonWorkloadSql } from './document-queries.ts'
import { AT_OFFICE, CARRYING, referencedUserIds, timelineEvents, trackingNumber, userSummary } from './serializers.ts'
import type { AccountType } from './models.ts'
import type { StoredFile } from './uploads.ts'

/**
 * The document workflow state machine, on the project schema:
 *   documents          status, current_step_number, current_office_id
 *   document_tracking  one row per office visit — arrived_at, handler_id (received by),
 *                      liaison_id (messenger it was released to / carried by), completed_at
 *                      (left the office), notes (the visit's event log, see tracking-log.ts)
 *   qr_codes           one row per document: its permanent routing code, issued on upload
 *   approvals          one row per STAFF at the final checkpoint
 * Every command runs in a transaction with the document row locked and notifies after commit.
 *
 * The relay, per office on the route:
 *   office staff scan the QR → received (handler_id) → released to a free messenger (liaison_id)
 *   → messenger scans the QR → picked up → staff at the next office scan the QR → received there …
 */

const docLink = (id: string) => `/documents/${id}`
const nameOf = (u?: Row | null) => (u ? u.full_name || [u.first_name, u.last_name].filter(Boolean).join(' ') || u.email : 'Someone')

/** Account types that upload documents. */
export const SUBMITTER_TYPES = ['CLIENT', 'EMPLOYEE', 'STAFF'] as const
/** Account types that work at an office: they receive documents there and release them onward. */
export const OFFICE_STAFF_TYPES: AccountType[] = ['EMPLOYEE', 'STAFF']
const isOfficeStaff = (actor: Actor) => OFFICE_STAFF_TYPES.includes(actor.account_type)

/** Drafts and returned documents are managed by whoever uploaded them, and by the CLIENT administrator. */
export const canManageDocument = (doc: Row, actor: Actor) => actor.account_type === 'CLIENT' || doc.submitted_by === actor.id

// ---------------------------------------------------------------------------
// Internals
// ---------------------------------------------------------------------------

async function lockDocument(documentId: string, actor: Actor, transaction: Transaction) {
  const doc = await Document.findOne({ where: { id: documentId, org_id: actor.org_id }, transaction, lock: transaction.LOCK.UPDATE })
  if (!doc) throw notFound('Document')
  return doc
}

/** The visit row for the document's current step (latest one, in case of a resubmission). */
export function getCurrentVisit(doc: Row, transaction?: Transaction) {
  return DocumentTracking.findOne({
    where: { document_id: doc.id, step_number: doc.current_step_number },
    order: [['created_at', 'DESC']],
    transaction,
    ...(transaction && { lock: transaction.LOCK.UPDATE }),
  })
}

async function requireVisit(doc: Row, transaction: Transaction) {
  const visit = await getCurrentVisit(doc, transaction)
  if (!visit) throw conflict('This document has no tracking record for its current step')
  return visit
}

/** Bump documents.updated_at when only related rows changed, so lists stay ordered by activity. */
async function touch(doc: Row, transaction: Transaction) {
  doc.changed('updated_at', true)
  await doc.save({ transaction })
}

function broadcast(doc: Row, transaction: Transaction) {
  emitAfterCommit(transaction, [`org:${doc.org_id}`, `doc:${doc.id}`], 'document:updated', {
    id: doc.id,
    status: doc.status,
    current_step_number: doc.current_step_number,
    current_office_id: doc.current_office_id,
  })
}

/**
 * Who acts on the document where it is now. On the route: staff and employees of that office.
 * At step 0 (the origin, before the first office): the uploader, the CLIENT administrator, or
 * staff of the uploader's office.
 */
export function holdsDocument(doc: Row, actor: Actor) {
  const officeStaffHere = isOfficeStaff(actor) && Boolean(actor.office_id) && actor.office_id === doc.current_office_id
  if (doc.current_step_number === 0) return officeStaffHere || canManageDocument(doc, actor)
  return officeStaffHere
}

function assertHoldsDocument(doc: Row, actor: Actor) {
  if (holdsDocument(doc, actor)) return
  throw forbidden(doc.current_step_number === 0 ? 'Only the uploader or the origin office can do this' : 'This document is not currently at your office')
}

/** Name of where the document is now: its office, or the organization (origin of a CLIENT upload). */
async function locationName(doc: Row, transaction?: Transaction) {
  if (doc.current_office_id) return ((await Office.findByPk(doc.current_office_id, { transaction }))?.name as string) ?? 'the office'
  return ((await Organization.findByPk(doc.org_id, { transaction }))?.name as string) ?? 'the organization'
}

async function openVisit(doc: Row, step: Row, status: string, transaction: Transaction) {
  return DocumentTracking.create(
    { document_id: doc.id, step_number: step.step_number, office_id: step.office_id, status, arrived_at: new Date() },
    { transaction },
  )
}

/** Each STAFF at the final checkpoint gets a PENDING row (feeds the pending_approvals view). */
async function ensurePendingApprovals(doc: Row, officeId: string, stepNumber: number, staffIds: string[], transaction: Transaction) {
  for (const staffId of staffIds) {
    const existing = await Approval.findOne({ where: { document_id: doc.id, staff_id: staffId, office_id: officeId }, transaction })
    if (!existing) {
      await Approval.create({ document_id: doc.id, staff_id: staffId, office_id: officeId, step_number: stepNumber, status: 'PENDING' }, { transaction })
    } else if (existing.status !== 'PENDING') {
      // Decided in an earlier pass (the document was returned and resubmitted).
      await existing.update({ status: 'PENDING', remarks: null, approved_at: null, step_number: stepNumber }, { transaction })
    }
  }
}

/** A routing code no other document uses. 10^8 codes per office prefix, so a retry is rare. */
async function uniqueRoutingCode(officeCode: string, transaction: Transaction) {
  for (let attempt = 0; attempt < 5; attempt++) {
    const code = buildRoutingCode(officeCode)
    if (!(await QrCode.count({ where: { qr_code_data: code }, transaction }))) return code
  }
  throw conflict('Could not generate a unique QR code. Try again.')
}

/**
 * Where a new document originates, as a QR prefix: the uploader's assigned office, or for
 * accounts without one (the CLIENT administrator), their organization.
 */
async function originCode(actor: Actor, transaction: Transaction) {
  if (actor.office_id && actor.office?.code) return actor.office.code as string
  const offices = await Office.findAll({ where: { org_id: actor.org_id }, attributes: ['code'], transaction })
  return organizationCode(actor.organization?.name ?? '', offices.map((o) => o.code as string))
}

/**
 * Record who took the physical document in at its current office. At the last office on its
 * route this also asks that office (its employees and staff) for the final decision. Saves the visit.
 */
async function markReceived(doc: Row, visit: Row, actor: Actor, transaction: Transaction, { remarks = null as string | null } = {}) {
  visit.handler_id = actor.id
  appendLog(visit, { type: 'RECEIVED', by: actor.id, status: doc.status, remarks })

  const step = await getStep(doc.route_id, doc.current_step_number, transaction)
  if (step && (await atLastStep(doc, transaction))) {
    appendLog(visit, { type: 'APPROVAL_REQUESTED', by: null, status: doc.status })
    const deciders = await officeMemberIds(step.office_id, OFFICE_STAFF_TYPES, transaction)
    await ensurePendingApprovals(doc, step.office_id, step.step_number, deciders, transaction)
    await notify(
      deciders,
      {
        type: 'APPROVAL_REQUESTED',
        title: `Approval needed: ${doc.title}`,
        body: `${trackingNumber(doc.id)} reached ${step.office?.name ?? 'your office'}, the last office on its route, and is waiting for your decision.`,
        documentId: doc.id,
        link: docLink(doc.id),
      },
      { transaction, excludeUserId: actor.id },
    )
  }
  await visit.save({ transaction })
  await touch(doc, transaction)

  await notify(
    [doc.submitted_by],
    {
      type: 'DOCUMENT_RECEIVED',
      title: `Received at ${step?.office?.name ?? 'office'}`,
      body: `${trackingNumber(doc.id)} was received by ${nameOf(actor)} (step ${doc.current_step_number}).`,
      documentId: doc.id,
      link: docLink(doc.id),
    },
    { transaction, excludeUserId: actor.id },
  )
  return step
}

/**
 * Put a document on its Document Route (or on `routeId`, when the submitter picks another one).
 * It starts at its origin — step 0, held by the uploader — and a messenger carries it to step 1.
 * When the uploader works at the route's first office, origin and step 1 are the same place, so
 * it starts at step 1, already received.
 */
async function enterRoute(doc: Row, actor: Actor, eventType: 'SUBMITTED' | 'RESUBMITTED', transaction: Transaction, routeId?: string | null) {
  const live = await getLiveRoute(doc.org_id, routeId || doc.route_id, transaction)
  if (!live?.steps.length) {
    throw conflict(
      routeId ? 'That Document Route is not available. Pick another one.' : 'This document’s route is no longer in use. Pick another Document Route to submit it on.',
      'ROUTE_UNAVAILABLE',
    )
  }
  const { route, steps } = live
  const first = steps[0]!
  // The deadline is the document type's processing time from now; priority follows the document and that time.
  const hours = await allowedHoursFor(doc.org_id, doc.category, route.id, transaction)
  const now = new Date()

  // The origin is where the uploader belongs: their office, or (no office) the organization itself.
  const submitter = doc.submitted_by === actor.id ? actor : await User.findByPk(doc.submitted_by, { transaction })
  const originOfficeId = (submitter?.office_id as string | null) ?? null
  const startsAtFirst = Boolean(originOfficeId) && originOfficeId === first.office_id && isOfficeStaff(submitter!)

  await doc.update(
    {
      route_id: route.id,
      status: 'START',
      current_step_number: startsAtFirst ? 1 : 0,
      current_office_id: startsAtFirst ? first.office_id : originOfficeId,
      submitted_at: now,
      completed_at: null,
      target_completion_date: hours > 0 ? new Date(now.getTime() + hours * 3600_000) : null,
      priority: autoPriority({ title: doc.title, description: doc.description, document_type: doc.category, routeHours: hours || null }),
    },
    { transaction },
  )
  const visit = await DocumentTracking.create(
    {
      document_id: doc.id,
      step_number: startsAtFirst ? 1 : 0,
      office_id: startsAtFirst ? first.office_id : originOfficeId,
      status: 'START',
      arrived_at: now,
      // At the origin the uploader holds the paper until a messenger picks it up.
      handler_id: startsAtFirst ? null : doc.submitted_by,
    },
    { transaction },
  )
  appendLog(visit, { type: eventType, by: actor.id, status: 'START', meta: { route_id: route.id } })
  await visit.save({ transaction })
  if (startsAtFirst) await markReceived(doc, visit, submitter!, transaction)

  await notify(
    await officeMemberIds(first.office_id, OFFICE_STAFF_TYPES, transaction),
    {
      type: 'DOCUMENT_INCOMING',
      title: `New document: ${doc.title}`,
      body: startsAtFirst
        ? `${nameOf(submitter)} uploaded ${trackingNumber(doc.id)} at your office (${route.name}, step 1).`
        : `${trackingNumber(doc.id)} is coming from ${await locationName(doc, transaction)} (${route.name}). You'll be told when a messenger picks it up; scan its QR when it arrives to receive it.`,
      documentId: doc.id,
      link: docLink(doc.id),
    },
    { transaction, excludeUserId: actor.id },
  )
  broadcast(doc, transaction)
}

/**
 * How long a document may take, in hours: its document type's processing time (Organization
 * Settings). For a type with no time set, the route's older per-office times, if it has any.
 * 0 = no deadline.
 */
export async function allowedHoursFor(orgId: string, typeName: string | null | undefined, routeId: string, transaction?: Transaction) {
  const byType = await processingHoursFor(orgId, typeName, transaction)
  return byType > 0 ? byType : routeHoursOf(routeId, transaction)
}

// ---------------------------------------------------------------------------
// Commands
// ---------------------------------------------------------------------------

export interface DocumentInput {
  title: string
  description?: string | null
  document_type?: string | null
  /** Which Document Route to follow. Optional only while the organization has a single route. */
  route_id?: string | null
  submit?: boolean
}

export async function createDocument(actor: Actor, input: DocumentInput, file: StoredFile | null, meta: RequestMeta) {
  return sequelize.transaction(async (transaction) => {
    // documents.route_id is required, so even drafts are pinned to a route.
    const route = await routeForNewDocument(actor.org_id, input.route_id ?? null, transaction)

    const doc = await Document.create(
      {
        org_id: actor.org_id,
        route_id: route.id,
        title: input.title,
        description: input.description,
        category: input.document_type,
        priority: autoPriority({ ...input, routeHours: (await allowedHoursFor(actor.org_id, input.document_type, route.id, transaction)) || null }),
        // Set when the document enters its route (see enterRoute).
        target_completion_date: null,
        status: 'CREATED',
        current_step_number: 1,
        submitted_by: actor.id,
        ...(file && { file_url: file.fileUrl, file_type: file.fileType, file_size: file.size }),
      },
      { transaction },
    )
    // The QR label is printed right after upload and stays with the paper until it is done.
    const origin = await originCode(actor, transaction)
    await QrCode.create({ document_id: doc.id, qr_code_data: await uniqueRoutingCode(origin, transaction), office_code: origin }, { transaction })

    if (input.submit) await enterRoute(doc, actor, 'SUBMITTED', transaction)
    await audit(meta, { action: 'DOCUMENT_CREATE', entityType: 'document', entityId: doc.id, after: doc.toJSON() }, transaction)
    return doc
  })
}

/** Draft → START, or RETURNED → START. `routeId` switches the document to another Document Route first. */
export async function submitDocument(documentId: string, actor: Actor, meta: RequestMeta, routeId?: string | null) {
  return sequelize.transaction(async (transaction) => {
    const doc = await lockDocument(documentId, actor, transaction)
    if (!canManageDocument(doc, actor)) throw forbidden('Only the person who uploaded this document can submit it')
    const previousRouteId = doc.route_id
    if (doc.status === 'CREATED') await enterRoute(doc, actor, 'SUBMITTED', transaction, routeId)
    else if (doc.status === 'RETURNED') await enterRoute(doc, actor, 'RESUBMITTED', transaction, routeId)
    else throw conflict('Only drafts or returned documents can be submitted')
    const routeChange = doc.route_id !== previousRouteId ? { before: { route_id: previousRouteId }, after: { route_id: doc.route_id } } : {}
    await audit(meta, { action: 'DOCUMENT_SUBMIT', entityType: 'document', entityId: doc.id, ...routeChange }, transaction)
    return doc
  })
}

/**
 * A messenger can be given a document only while on duty and free: nothing waiting for them
 * to pick up and nothing in hand. Locks the messenger's profile so two offices can't assign the
 * same messenger at once (the caller's transaction must be READ COMMITTED to see the other's commit).
 */
async function claimFreeMessenger(userId: string, orgId: string, transaction: Transaction) {
  const user = await User.findOne({ where: { id: userId, org_id: orgId, account_type: 'LIAISON', status: { [Op.ne]: 'inactive' } }, transaction })
  if (!user) throw badRequest('Selected messenger was not found')
  const profile = await Liaison.findOne({ where: { user_id: user.id }, transaction, lock: transaction.LOCK.UPDATE })
  if (!profile) throw badRequest(`${nameOf(user)} has no messenger profile yet`)
  if (!profile.available) throw conflict(`${nameOf(user)} is off duty. Pick another messenger.`, 'MESSENGER_UNAVAILABLE')

  const [row] = await sequelize.query<{ n: number }>(`SELECT ${liaisonWorkloadSql(sequelize.escape(user.id))} AS n`, { type: QueryTypes.SELECT, transaction })
  if (Number(row?.n ?? 0) > 0) throw conflict(`${nameOf(user)} already has a document to deliver. Pick a free messenger.`, 'MESSENGER_BUSY')
  return user
}

/**
 * Assign the free messenger who carries the document to the next office on the route — from its
 * origin, or from an office once it has been received there. While nobody has picked it up yet,
 * calling this again reassigns it to another messenger (the previous one is told and freed).
 */
export async function requestPickup(documentId: string, actor: Actor, { liaisonUserId, remarks = null }: { liaisonUserId: string; remarks?: string | null }) {
  if (!liaisonUserId) throw badRequest('Choose the messenger who will carry the document', { field: 'liaison_user_id' })
  return sequelize.transaction({ isolationLevel: Transaction.ISOLATION_LEVELS.READ_COMMITTED }, async (transaction) => {
    const doc = await lockDocument(documentId, actor, transaction)
    if (!AT_OFFICE.includes(doc.status)) throw conflict('The messenger can only be changed before the document is picked up')
    assertHoldsDocument(doc, actor)
    const visit = await requireVisit(doc, transaction)
    if (!visit.handler_id) throw conflict('Scan the document’s QR code to receive it before releasing it')
    const previousId = visit.liaison_id as string | null
    if (previousId === liaisonUserId) throw conflict('That messenger is already assigned to this document')

    const atOrigin = doc.current_step_number === 0
    const step = atOrigin ? null : await getStep(doc.route_id, doc.current_step_number, transaction)
    if (!atOrigin && !step) throw conflict('Document route is missing this step')
    if (step?.is_final_checkpoint) throw conflict('This is the final checkpoint — it is completed by approval, not released')
    const nextStep = await getStep(doc.route_id, doc.current_step_number + 1, transaction)
    if (!nextStep) throw conflict('This is the last office on the route')

    const liaison = await claimFreeMessenger(liaisonUserId, actor.org_id, transaction)
    const previous = previousId ? await User.findByPk(previousId, { transaction }) : null

    visit.liaison_id = liaison.id
    appendLog(visit, {
      type: previous ? 'MESSENGER_REASSIGNED' : 'PICKUP_REQUESTED',
      by: actor.id,
      status: doc.status,
      remarks: previous ? `${nameOf(previous)} → ${nameOf(liaison)}${remarks ? ` · ${remarks}` : ''}` : remarks,
      meta: { liaison_id: liaison.id, previous_liaison_id: previousId, next_office_id: nextStep.office_id },
    })
    await visit.save({ transaction })
    await touch(doc, transaction)

    const here = step?.office?.name ?? (await locationName(doc, transaction))
    await notify(
      [liaison.id],
      {
        type: 'PICKUP_REQUESTED',
        title: `Pickup at ${here}`,
        body: `${trackingNumber(doc.id)} · ${doc.title} → deliver to ${nextStep.office.name}.${remarks ? ` Note: ${remarks}` : ''}`,
        documentId: doc.id,
        link: '/liaison/dashboard',
      },
      { transaction, excludeUserId: actor.id },
    )
    if (previousId) {
      await notify(
        [previousId],
        { type: 'PICKUP_CANCELLED', title: `Reassigned: ${doc.title}`, body: `${trackingNumber(doc.id)} was given to another messenger. You don't need to pick it up.`, documentId: doc.id, link: '/liaison/dashboard' },
        { transaction, excludeUserId: actor.id },
      )
    }
    await notify(
      await officeMemberIds(nextStep.office_id, OFFICE_STAFF_TYPES, transaction),
      {
        type: 'DOCUMENT_INCOMING',
        title: `Coming to your office: ${doc.title}`,
        body: `${here} ${previous ? 'reassigned' : 'released'} ${trackingNumber(doc.id)} to ${nameOf(liaison)}. Scan its QR code when it arrives to receive it.`,
        documentId: doc.id,
        link: docLink(doc.id),
      },
      { transaction, excludeUserId: actor.id },
    )
    broadcast(doc, transaction)
    return { doc, reassigned: Boolean(previous) }
  })
}

/** Take the document back from the messenger before they pick it up. */
export async function cancelPickup(documentId: string, actor: Actor) {
  return sequelize.transaction(async (transaction) => {
    const doc = await lockDocument(documentId, actor, transaction)
    assertHoldsDocument(doc, actor)
    const visit = AT_OFFICE.includes(doc.status) ? await requireVisit(doc, transaction) : null
    if (!visit?.liaison_id) throw conflict('This document has not been released to a messenger')
    const liaisonId = visit.liaison_id
    visit.liaison_id = null
    appendLog(visit, { type: 'NOTE', by: actor.id, status: doc.status, remarks: 'Release cancelled — messenger unassigned' })
    await visit.save({ transaction })
    await touch(doc, transaction)
    await notify(
      [liaisonId],
      {
        type: 'PICKUP_CANCELLED',
        title: `Pickup cancelled: ${doc.title}`,
        body: `You no longer need to carry ${trackingNumber(doc.id)}.`,
        documentId: doc.id,
        link: '/liaison/dashboard',
      },
      { transaction, excludeUserId: actor.id },
    )
    broadcast(doc, transaction)
    return doc
  })
}

/** Replace a lost or damaged QR label: a new code with the same office prefix. The old label stops working. */
export async function regenerateQr(documentId: string, actor: Actor) {
  return sequelize.transaction(async (transaction) => {
    const doc = await lockDocument(documentId, actor, transaction)
    assertHoldsDocument(doc, actor)
    if (!AT_OFFICE.includes(doc.status)) throw conflict('The QR label can only be replaced while the document is at your office')
    const visit = await requireVisit(doc, transaction)
    const qr = await QrCode.findOne({ where: { document_id: doc.id }, transaction, lock: transaction.LOCK.UPDATE })
    const officeCode = (qr?.office_code as string | undefined) || (await originCode(actor, transaction))
    const code = await uniqueRoutingCode(officeCode, transaction)
    if (qr) await qr.update({ qr_code_data: code, office_code: officeCode }, { transaction })
    else await QrCode.create({ document_id: doc.id, qr_code_data: code, office_code: officeCode }, { transaction })
    appendLog(visit, { type: 'NOTE', by: actor.id, status: doc.status, remarks: 'QR label replaced — the previous label no longer works' })
    await visit.save({ transaction })
    return { doc }
  })
}

async function loadQrContext(codeRaw: string, actor: Actor, transaction?: Transaction) {
  const { code } = parseRoutingCode(codeRaw)
  const qr = await QrCode.findOne({ where: { qr_code_data: code }, transaction })
  if (!qr) throw notFound('Document with this QR code')
  const doc = await Document.findOne({ where: { id: qr.document_id, org_id: actor.org_id }, transaction, ...(transaction && { lock: transaction.LOCK.UPDATE }) })
  if (!doc) throw notFound('Document with this QR code')
  const visit = doc.status === 'CREATED' ? null : await getCurrentVisit(doc, transaction)
  const current = doc.current_office_id ? await Office.findByPk(doc.current_office_id, { transaction }) : null
  const next = await getStep(doc.route_id, doc.current_step_number + 1, transaction)
  // Where it is now, by name: its office, or the organization at the origin of a CLIENT upload.
  const here = (current?.name as string | undefined) ?? (await locationName(doc, transaction))
  return { qr, doc, visit, current, next, here }
}

type ScanAction = 'PICKUP' | 'RECEIVE'
interface ScanDecision {
  action: ScanAction | null
  reason?: string
  /** `info` = nothing to do, but nothing is wrong either (e.g. a messenger checking where to go). */
  tone?: 'info' | 'error'
}
const deny = (reason: string): ScanDecision => ({ action: null, reason, tone: 'error' })
const inform = (reason: string): ScanDecision => ({ action: null, reason, tone: 'info' })

/**
 * What scanning this document's QR lets the user do right now:
 *   messenger      PICKUP  — the document was released to them and is still where it was
 *   office staff   RECEIVE — it waits unreceived at their office, it is being carried to their
 *                            office (the next one on the route), or — at the origin, with no
 *                            messenger assigned — it was brought to the first office by hand.
 *                            Nobody else can receive it.
 */
function resolveScanAction(doc: Row, visit: Row | null, actor: Actor, at: string, next: Row | null): ScanDecision {
  const to = next?.office?.name ?? 'the next office'
  if (doc.status === 'CREATED') return deny('This document is still a draft. It has to be submitted before it can be routed.')
  if (doc.status === 'COMPLETED') return inform('This document is completed. There is nothing left to scan.')
  if (doc.status === 'RETURNED') return inform('This document was returned to its submitter.')
  if (!visit) return deny('This document has no tracking record for its current step')
  const atOffice = AT_OFFICE.includes(doc.status)

  if (actor.account_type === 'LIAISON') {
    if (atOffice) {
      if (visit.liaison_id === actor.id) return { action: 'PICKUP' }
      if (visit.liaison_id) return deny('This document was released to a different messenger')
      return deny(`${at} hasn’t released this document to a messenger yet`)
    }
    if (visit.liaison_id === actor.id) return inform(`Bring it to ${to}. Any of their staff scans this code to receive it from you.`)
    return deny('Another messenger is carrying this document')
  }

  if (!isOfficeStaff(actor) || !actor.office_id) return deny('Only office staff and messengers can scan document QR codes')

  // Still at its origin, before the first office on the route.
  if (atOffice && doc.current_step_number === 0) {
    if (next?.office_id === actor.office_id) {
      if (visit.liaison_id) return deny(`${at} assigned a messenger to bring this document. Receive it from them when they arrive.`)
      return { action: 'RECEIVE' }
    }
    if (doc.current_office_id === actor.office_id) return inform(`This document is at your office, its origin. Assign a messenger to bring it to ${to}.`)
    return deny(`This document is still at its origin, ${at}. Only ${to} staff can receive it.`)
  }

  if (atOffice) {
    if (doc.current_office_id !== actor.office_id) return deny(`This document is at ${at}. Only ${at} staff can receive it.`)
    if (!visit.handler_id) return { action: 'RECEIVE' }
    if (visit.liaison_id) return inform(`Already received here and released to a messenger for ${to}.`)
    return inform(next ? `Already received at your office. Release it to a messenger for ${to} when your office is done.` : 'Already received at your office.')
  }
  if (next?.office_id === actor.office_id) return { action: 'RECEIVE' }
  return deny(`This document is on its way to ${to}. Only ${to} staff can receive it.`)
}

/** Dry run: what the scan would do, shown to the user before they confirm. */
export async function verifyScan(code: string, actor: Actor) {
  const { qr, doc, visit, current, next, here } = await loadQrContext(code, actor)
  const decision = resolveScanAction(doc, visit, actor, here, next)
  const lite = (o: Row | null | undefined) => (o ? { id: o.id, code: o.code, name: o.name, department_name: o.department ?? '' } : null)
  const people = await User.findAll({
    where: { id: { [Op.in]: [visit?.liaison_id, visit?.handler_id].filter(Boolean) as string[] } },
    attributes: ['id', 'first_name', 'last_name', 'full_name', 'email', 'account_type'],
  })
  const person = (id?: string | null) => (id ? userSummary(people.find((u) => u.id === id)) : null)
  const carrying = CARRYING.includes(doc.status)
  return {
    action: decision.action,
    reason: decision.reason ?? null,
    tone: decision.tone ?? null,
    document: {
      id: doc.id,
      tracking_number: trackingNumber(doc.id),
      qr_code: qr.qr_code_data,
      title: doc.title,
      priority: doc.priority,
      status: doc.status,
      current_step_number: doc.current_step_number,
    },
    // Carried documents travel from the current office to the next; otherwise they are at the current one.
    from_office: lite(current) ?? { id: '', code: '', name: here, department_name: '' },
    to_office: lite(next?.office),
    messenger: AT_OFFICE.includes(doc.status) || carrying ? person(visit?.liaison_id) : null,
    received_by: AT_OFFICE.includes(doc.status) ? person(visit?.handler_id) : null,
  }
}

/** Scan a document's QR: a messenger picks it up, or the staff of the office it reached receive it. */
export async function performScan(code: string, expectedAction: ScanAction | null, actor: Actor) {
  return sequelize.transaction(async (transaction) => {
    const { doc, visit, next, here } = await loadQrContext(code, actor, transaction)
    const { action, reason } = resolveScanAction(doc, visit, actor, here, next)
    if (!action || !visit) throw forbidden(reason)
    if (expectedAction && expectedAction !== action) {
      throw conflict(`This scan would ${action.toLowerCase()} the document, not ${expectedAction.toLowerCase()} it`)
    }

    if (action === 'PICKUP') {
      if (!next) throw conflict('Document has no next office on its route')
      await doc.update({ status: 'PICKED_UP' }, { transaction })
      Object.assign(visit, { status: 'PICKED_UP', completed_at: new Date() })
      appendLog(visit, { type: 'PICKED_UP', by: actor.id, status: 'PICKED_UP', meta: { next_office_id: next.office_id } })
      await visit.save({ transaction })
      await notify(
        [...(await officeMemberIds(doc.current_office_id, OFFICE_STAFF_TYPES, transaction)), doc.submitted_by],
        {
          type: 'DOCUMENT_PICKED_UP',
          title: `Picked up: ${doc.title}`,
          body: `${nameOf(actor)} picked up ${trackingNumber(doc.id)} for ${next.office.name}.`,
          documentId: doc.id,
          link: docLink(doc.id),
        },
        { transaction, excludeUserId: actor.id },
      )
      await notify(
        await officeMemberIds(next.office_id, OFFICE_STAFF_TYPES, transaction),
        {
          type: 'DOCUMENT_INCOMING',
          title: `Incoming: ${doc.title}`,
          body: `${nameOf(actor)} is bringing ${trackingNumber(doc.id)} from ${here}. Scan its QR code when it arrives to receive it.`,
          documentId: doc.id,
          link: docLink(doc.id),
        },
        { transaction, excludeUserId: actor.id },
      )
      broadcast(doc, transaction)
      return { action, doc }
    }

    // RECEIVE, at the office the document is waiting at (back after a failed delivery, or an older document).
    if (AT_OFFICE.includes(doc.status) && doc.current_step_number !== 0) {
      await markReceived(doc, visit, actor, transaction)
      broadcast(doc, transaction)
      return { action, doc }
    }

    // RECEIVE from the messenger — or, at the origin, brought over by hand: close the previous
    // visit and open one here, received by the scanner.
    if (!next) throw conflict('Document has no next office on its route')
    const liaisonId = CARRYING.includes(doc.status) ? (visit.liaison_id as string | null) : null
    const minutes = liaisonId && visit.completed_at ? (Date.now() - new Date(visit.completed_at).getTime()) / 60000 : null
    if (liaisonId) await recordOutcome(liaisonId, { success: true, minutes }, transaction)

    visit.status = 'COMPLETED'
    visit.completed_at ??= new Date()
    await visit.save({ transaction })
    await doc.update({ status: 'ARRIVED_AT_OFFICE', current_step_number: next.step_number, current_office_id: next.office_id }, { transaction })
    const arrival = await openVisit(doc, next, 'ARRIVED_AT_OFFICE', transaction)
    appendLog(arrival, {
      type: 'ARRIVED',
      by: liaisonId,
      status: 'ARRIVED_AT_OFFICE',
      meta: { from_office_id: visit.office_id, received_by: actor.id, by_hand: !liaisonId, delivery_minutes: minutes == null ? null : Math.round(minutes * 10) / 10 },
    })
    await markReceived(doc, arrival, actor, transaction)

    await notify(
      [liaisonId],
      {
        type: 'DELIVERY_CONFIRMED',
        title: `Delivered: ${doc.title}`,
        body: `${nameOf(actor)} received ${trackingNumber(doc.id)} at ${next.office.name}.`,
        documentId: doc.id,
        link: '/liaison/tracking',
      },
      { transaction, excludeUserId: actor.id },
    )
    broadcast(doc, transaction)
    return { action, doc }
  })
}

export async function startTransit(documentId: string, actor: Actor) {
  return sequelize.transaction(async (transaction) => {
    const doc = await lockDocument(documentId, actor, transaction)
    if (doc.status !== 'PICKED_UP') throw conflict('Document must be picked up first')
    const visit = await requireVisit(doc, transaction)
    if (visit.liaison_id !== actor.id) throw forbidden('You are not carrying this document')
    await doc.update({ status: 'IN_TRANSIT' }, { transaction })
    visit.status = 'IN_TRANSIT'
    appendLog(visit, { type: 'IN_TRANSIT', by: actor.id, status: 'IN_TRANSIT' })
    await visit.save({ transaction })
    broadcast(doc, transaction)
    return doc
  })
}

/** LIAISON could not deliver: the document goes back to its origin office to be received and released again. */
export async function failDelivery(documentId: string, actor: Actor, { remarks }: { remarks: string | null }) {
  if (!remarks) throw badRequest('Tell the office why the delivery failed')
  return sequelize.transaction(async (transaction) => {
    const doc = await lockDocument(documentId, actor, transaction)
    if (!CARRYING.includes(doc.status)) throw conflict('Document is not in transit')
    const visit = await requireVisit(doc, transaction)
    if (visit.liaison_id !== actor.id) throw forbidden('You are not carrying this document')

    await recordOutcome(actor.id, { success: false }, transaction)
    const atOrigin = doc.current_step_number === 0
    const startedHere = readLog(visit).some((e) => e.type === 'SUBMITTED' || e.type === 'RESUBMITTED')
    const back = startedHere ? 'START' : 'ARRIVED_AT_OFFICE'
    await doc.update({ status: back }, { transaction })
    // An office must scan it in again before releasing it to another messenger; at the origin it
    // simply goes back to the uploader.
    Object.assign(visit, { status: back, handler_id: atOrigin ? doc.submitted_by : null, liaison_id: null, completed_at: null })
    appendLog(visit, { type: 'DELIVERY_FAILED', by: actor.id, status: back, remarks })
    await visit.save({ transaction })

    await notify(
      [...(await officeMemberIds(doc.current_office_id, OFFICE_STAFF_TYPES, transaction)), ...(atOrigin ? [doc.submitted_by] : [])],
      { type: 'DELIVERY_FAILED', title: `Delivery failed: ${doc.title}`, body: `${nameOf(actor)}: ${remarks}`, documentId: doc.id, link: docLink(doc.id) },
      { transaction },
    )
    broadcast(doc, transaction)
    return doc
  })
}

// ---------------------------------------------------------------------------
// Approval: only the last office on the document's own route decides
// ---------------------------------------------------------------------------

/**
 * Is the document at the last office of its route? That is the step marked final checkpoint,
 * or simply the last step. Step 0 (the origin) never is.
 */
async function atLastStep(doc: Row, transaction?: Transaction) {
  if (!doc.current_step_number) return false
  const step = await getStep(doc.route_id, doc.current_step_number, transaction)
  if (!step) return false
  if (step.is_final_checkpoint) return true
  return !(await getStep(doc.route_id, doc.current_step_number + 1, transaction))
}

/** SQL twin of atLastStep, for lists. */
const AT_LAST_STEP_SQL = `documents.current_step_number > 0 AND (
  (SELECT rs.is_final_checkpoint FROM route_steps rs WHERE rs.route_id = documents.route_id AND rs.step_number = documents.current_step_number) = 1
  OR NOT EXISTS (SELECT 1 FROM route_steps rs WHERE rs.route_id = documents.route_id AND rs.step_number > documents.current_step_number))`

/**
 * Who may approve or return a document: employees and staff of the office it is at — when that
 * is the last office on its route and it has been received there. Nobody else, the owner and the
 * CLIENT administrator included, unless they belong to that office.
 */
function canDecideHere(doc: Row, actor: Actor) {
  return isOfficeStaff(actor) && Boolean(actor.office_id) && actor.office_id === doc.current_office_id && AT_OFFICE.includes(doc.status)
}

/** Documents waiting for a decision at this user's office, where it is the last office on their route. */
export async function pendingApprovalsFor(actor: Actor) {
  if (!isOfficeStaff(actor) || !actor.office_id) return []
  const docs = await Document.findAll({
    where: {
      org_id: actor.org_id,
      current_office_id: actor.office_id,
      status: { [Op.in]: AT_OFFICE },
      [Op.and]: [
        sequelize.literal(`(${AT_LAST_STEP_SQL})`),
        sequelize.literal(
          '(SELECT t.handler_id FROM document_tracking t WHERE t.document_id = documents.id AND t.step_number = documents.current_step_number ORDER BY t.created_at DESC LIMIT 1) IS NOT NULL',
        ),
      ],
    },
    attributes: ['id', 'current_step_number'],
  })
  if (!docs.length) return []
  // Staff who joined the office after the document arrived get their row on first look.
  await sequelize.transaction(async (transaction) => {
    for (const d of docs) await ensurePendingApprovals(d, actor.office_id, d.current_step_number, [actor.id], transaction)
  })
  return Approval.findAll({
    where: { staff_id: actor.id, office_id: actor.office_id, status: 'PENDING', document_id: { [Op.in]: docs.map((d) => d.id) } },
    order: [['created_at', 'ASC']],
  })
}

/** This user's pending approval for one document: only at the last office of its route, once received there. */
export async function myPendingApproval(doc: Row, actor: Actor, visit: Row | null) {
  if (!canDecideHere(doc, actor) || !visit?.handler_id || !(await atLastStep(doc))) return null
  await sequelize.transaction((transaction) => ensurePendingApprovals(doc, actor.office_id, doc.current_step_number, [actor.id], transaction))
  return Approval.findOne({ where: { document_id: doc.id, staff_id: actor.id, office_id: actor.office_id, status: 'PENDING' } })
}

/** The last office on the route approves (→ COMPLETED) or returns (→ RETURNED). */
export async function decideApproval(
  approvalId: string,
  actor: Actor,
  { decision, remarks }: { decision: 'APPROVED' | 'RETURNED'; remarks: string | null },
  meta: RequestMeta,
) {
  if (!isOfficeStaff(actor) || !actor.office_id) throw forbidden('Only the last office on the document’s route can approve it')
  if (decision === 'RETURNED' && !remarks) throw badRequest('Remarks are required when returning a document')

  return sequelize.transaction(async (transaction) => {
    const approval = await Approval.findByPk(approvalId, { transaction, lock: transaction.LOCK.UPDATE })
    if (!approval) throw notFound('Approval')
    if (approval.office_id !== actor.office_id || approval.staff_id !== actor.id) throw forbidden('This approval belongs to someone else')
    if (approval.status !== 'PENDING') throw conflict(`This approval was already ${approval.status.toLowerCase()}`)

    const doc = await lockDocument(approval.document_id, actor, transaction)
    if (!canDecideHere(doc, actor)) throw conflict('This document is no longer waiting for approval at your office')
    if (!(await atLastStep(doc, transaction))) throw forbidden('Only the last office on the document’s route can approve it')
    const visit = await requireVisit(doc, transaction)
    if (!visit.handler_id) throw conflict('Scan the document in before deciding on it')

    const now = new Date()
    await approval.update({ status: decision, remarks, approved_at: now }, { transaction })
    // One decision settles it for the whole office.
    await Approval.destroy({ where: { document_id: doc.id, office_id: actor.office_id, status: 'PENDING', id: { [Op.ne]: approval.id } }, transaction })

    if (decision === 'APPROVED') {
      await doc.update({ status: 'COMPLETED', completed_at: now }, { transaction })
      Object.assign(visit, { status: 'COMPLETED', completed_at: now })
      appendLog(visit, { type: 'APPROVED', by: actor.id, status: 'COMPLETED', remarks })
      appendLog(visit, { type: 'COMPLETED', by: null, status: 'COMPLETED' })
    } else {
      await doc.update({ status: 'RETURNED' }, { transaction })
      Object.assign(visit, { status: 'RETURNED', completed_at: now })
      appendLog(visit, { type: 'RETURNED', by: actor.id, status: 'RETURNED', remarks })
    }
    await visit.save({ transaction })

    await notify(
      [doc.submitted_by],
      {
        type: decision === 'APPROVED' ? 'DOCUMENT_COMPLETED' : 'DOCUMENT_RETURNED',
        title: decision === 'APPROVED' ? `Approved: ${doc.title}` : `Returned: ${doc.title}`,
        body: decision === 'APPROVED' ? `${trackingNumber(doc.id)} is complete.` : `${trackingNumber(doc.id)} was returned: ${remarks}`,
        documentId: doc.id,
        link: docLink(doc.id),
      },
      { transaction, excludeUserId: actor.id },
    )
    await audit(meta, { action: `APPROVAL_${decision}`, entityType: 'approval', entityId: approval.id, after: { document_id: doc.id, remarks } }, transaction)
    broadcast(doc, transaction)
    return { approval, doc }
  })
}

export async function addNote(documentId: string, actor: Actor, remarks: string) {
  return sequelize.transaction(async (transaction) => {
    const doc = await lockDocument(documentId, actor, transaction)
    if (doc.status === 'CREATED') throw conflict('Submit the document before adding notes to its timeline')
    const visit = await requireVisit(doc, transaction)
    const event = appendLog(visit, { type: 'NOTE', by: actor.id, status: doc.status, remarks })
    await visit.save({ transaction })
    return event
  })
}

// ---------------------------------------------------------------------------
// Queries
// ---------------------------------------------------------------------------

/** The full timeline: every visit's event log plus the draft's creation. */
export async function documentTimeline(doc: Row) {
  const visits = await DocumentTracking.findAll({
    where: { document_id: doc.id },
    include: [{ model: Office, as: 'office', attributes: ['id', 'code', 'name'] }],
    order: [['created_at', 'ASC']],
  })
  const users = await User.findAll({
    where: { id: { [Op.in]: referencedUserIds(doc, visits) } },
    attributes: ['id', 'first_name', 'last_name', 'full_name', 'email', 'account_type'],
  })
  return timelineEvents(doc, visits, new Map(users.map((u) => [u.id, u])))
}

export interface ActionContext {
  received: boolean
  visitLiaisonId: string | null
  isFinalStep: boolean
  /** Office of the step after the current one (where a carried document is heading). */
  nextOfficeId: string | null
  pendingApproval: Row | null
}

/** Which buttons the current user should see for this document. Mirrors the command checks above. */
export function availableActions(doc: Row, actor: Actor, ctx: ActionContext) {
  const atOffice = AT_OFFICE.includes(doc.status)
  const moving = CARRYING.includes(doc.status)
  const officeStaff = isOfficeStaff(actor) && Boolean(actor.office_id)
  const atOrigin = doc.current_step_number === 0
  // Office staff where it is, or (at the origin) the uploader / CLIENT administrator too.
  const holds = holdsDocument(doc, actor)
  const isLiaison = actor.account_type === 'LIAISON'
  const carrying = moving && ctx.visitLiaisonId === actor.id
  const nextOfficeStaff = officeStaff && actor.office_id === ctx.nextOfficeId

  return {
    canEdit: canManageDocument(doc, actor) && doc.status === 'CREATED',
    canSubmit: canManageDocument(doc, actor) && doc.status === 'CREATED',
    canResubmit: canManageDocument(doc, actor) && doc.status === 'RETURNED',
    // Receiving always takes a scan of the QR label (scanner page). At the origin with no
    // messenger assigned, the first office can also receive it when it is brought by hand.
    canScanReceive:
      (holds && !atOrigin && atOffice && !ctx.received) ||
      (nextOfficeStaff && moving) ||
      (nextOfficeStaff && atOrigin && atOffice && !ctx.visitLiaisonId),
    canRequestPickup: holds && atOffice && ctx.received && !ctx.visitLiaisonId && !ctx.isFinalStep && Boolean(ctx.nextOfficeId),
    // Until the messenger has picked it up, another one can take over.
    canReassign: holds && atOffice && Boolean(ctx.visitLiaisonId),
    canCancelPickup: holds && atOffice && Boolean(ctx.visitLiaisonId),
    canPickup: isLiaison && atOffice && ctx.visitLiaisonId === actor.id,
    canStartTransit: isLiaison && carrying && doc.status === 'PICKED_UP',
    canReportFailure: isLiaison && carrying,
    // Only the last office on the route, once received there — see canDecideHere / myPendingApproval.
    canApprove: Boolean(ctx.pendingApproval) && canDecideHere(doc, actor),
  }
}

/** The document's QR label: its permanent routing code, rendered for screen and print. */
export async function renderDocumentQr(documentId: string) {
  const qr = await QrCode.findOne({ where: { document_id: documentId } })
  if (!qr) return null
  return { id: qr.id, payload: qr.qr_code_data, status: 'ACTIVE', created_at: new Date(qr.created_at).toISOString(), ...(await renderQr(qr.qr_code_data)) }
}

/** The routing code on a document's QR label (for scripts and tests). */
export async function routingCodeOf(documentId: string) {
  const qr = await QrCode.findOne({ where: { document_id: documentId }, attributes: ['qr_code_data'] })
  if (!qr) throw notFound('QR code')
  return qr.qr_code_data as string
}
