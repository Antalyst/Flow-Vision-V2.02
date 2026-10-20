import { Op, QueryTypes, Transaction } from 'sequelize'
import { sequelize, Approval, Document, DocumentFile, DocumentInternalTransaction, DocumentTracking, InternalRoute, InternalRouteStep, Issue, Liaison, Notification, Office, Organization, QrCode, User, type Row } from './models.ts'
import { badRequest, conflict, forbidden, notFound } from './errors.ts'
import type { Actor, RequestMeta } from './auth.ts'
import { getLiveRoute, getStep, routeForNewDocument, routeTimeOf } from './routes.ts'
import { processingTimeFor } from './knowledge.ts'
import { deadlineFrom, loadWorkCalendar } from './work-calendar.ts'
import { autoPriority } from './priority.ts'
import { alternateRoutingCode, buildRoutingCode, organizationCode, parseRoutingCode, renderQr } from './qr.ts'
import { notify, officeMemberIds } from './notifications.ts'
import { emitAfterCommit } from './realtime.ts'
import { recordOutcome } from './liaisons.ts'
import { audit } from './audit.ts'
import { hasPermission, requirePermission } from './dh-access.ts'
import { appendLog, pendingPass, readLog, sendBackTarget, sortVisits } from './tracking-log.ts'
import { currentVisit, liaisonWorkloadSql } from './document-queries.ts'
import { AT_OFFICE, CARRYING, referencedOfficeIds, referencedUserIds, routingVisits, timelineEvents, trackingNumber, userSummary } from './serializers.ts'
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
 *
 * Inside an office the document may go desk to desk first: the receiver passes it to the next
 * staff (PASSED_TO_STAFF, handler_id cleared), and another staff member of the office scans it in
 * (RECEIVED) — only then can it be passed again or released to a messenger.
 */

const docLink = (id: string) => `/documents/${id}`
const nameOf = (u?: Row | null) => (u ? u.full_name || [u.first_name, u.last_name].filter(Boolean).join(' ') || u.email : 'Someone')

/** Account types that upload documents. */
export const SUBMITTER_TYPES = ['ADMIN', 'DEPARTMENT_HEAD', 'STAFF'] as const
/** Account types that work at an office: they receive documents there and release them onward. */
export const OFFICE_STAFF_TYPES: AccountType[] = ['DEPARTMENT_HEAD', 'STAFF']
const isOfficeStaff = (actor: Actor) => OFFICE_STAFF_TYPES.includes(actor.account_type)

/** Drafts and returned documents are managed by whoever uploaded them, and by the admin. */
export const canManageDocument = (doc: Row, actor: Actor) => actor.account_type === 'ADMIN' || doc.submitted_by === actor.id

// ---------------------------------------------------------------------------
// Internals
// ---------------------------------------------------------------------------

async function lockDocument(documentId: string, actor: Actor, transaction: Transaction) {
  const doc = await Document.findOne({ where: { id: documentId, org_id: actor.org_id }, transaction, lock: transaction.LOCK.UPDATE })
  if (!doc) throw notFound('Document')
  return doc
}

/** The visit row for the document's current step (latest one, in case of a resubmission). */
export async function getCurrentVisit(doc: Row, transaction?: Transaction) {
  // The latest visit of this step. Ties on created_at (whole seconds before the 2026-10-22 migration)
  // are settled by the visits' own event times.
  const visits = await DocumentTracking.findAll({
    where: { document_id: doc.id, step_number: doc.current_step_number },
    order: [['created_at', 'DESC']],
    limit: 5,
    transaction,
    ...(transaction && { lock: transaction.LOCK.UPDATE }),
  })
  return sortVisits(visits).at(-1) ?? null
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
 * At step 0 (the origin, before the first office): the uploader, the admin, or
 * staff of the uploader's office.
 */
export function holdsDocument(doc: Row, actor: Actor) {
  const officeStaffHere = isOfficeStaff(actor) && Boolean(actor.office_id) && actor.office_id === doc.current_office_id
  if (doc.current_step_number === 0) return officeStaffHere || canManageDocument(doc, actor)
  return officeStaffHere
}

/**
 * The document is with one of its office's umbrella units: handed off inside its route step, so it is
 * at the unit (documents.current_office_id) while the step belongs to the office (visit.office_id).
 * A route step that is itself an umbrella office (routes built before umbrellas became units) is not this.
 */
export const atUnit = (doc: Row, visit: Row | null | undefined) =>
  Boolean(visit) && doc.current_step_number > 0 && Boolean(doc.current_office_id) && Boolean(visit!.office_id) && doc.current_office_id !== visit!.office_id

/** Release, send-back and the final decision belong to the office of the route step, never to its unit. */
function assertNotAtUnit(doc: Row, visit: Row, what: string) {
  if (atUnit(doc, visit)) throw conflict(`This document is with an umbrella office. Return it to its office before you ${what}.`, 'AT_UMBRELLA_UNIT')
}

function assertHoldsDocument(doc: Row, actor: Actor) {
  if (holdsDocument(doc, actor)) return
  throw forbidden(doc.current_step_number === 0 ? 'Only the uploader or the origin office can do this' : 'This document is not currently at your office')
}

/**
 * At an office, the person who scanned the document in is the one who releases it: assigns,
 * reassigns or unassigns its messenger. That keeps one accountable person per office visit.
 * (At the origin — step 0 — the uploader, the admin or the origin office do it.)
 */
async function assertReceiver(doc: Row, visit: Row, actor: Actor, transaction?: Transaction, what = 'release it and assign its messenger') {
  if (doc.current_step_number === 0 || visit.handler_id === actor.id) return
  const receiver = visit.handler_id ? await User.findByPk(visit.handler_id, { attributes: ['first_name', 'last_name', 'full_name', 'email'], transaction }) : null
  throw forbidden(`Only ${receiver ? nameOf(receiver) : 'the person who received it'}, who received this document, can ${what}`)
}

/** Name of where the document is now: its office, or the organization (origin of an admin upload). */
async function locationName(doc: Row, transaction?: Transaction) {
  if (doc.current_office_id) return ((await Office.findByPk(doc.current_office_id, { transaction }))?.name as string) ?? 'the office'
  return ((await Organization.findByPk(doc.org_id, { transaction }))?.name as string) ?? 'the organization'
}

/**
 * The place at `stepNumber` on the document's route, shaped like a route step: the step itself, or
 * — step 0 — the origin office (a document sent back from the first office returns to its origin).
 */
async function stepAt(doc: Row, stepNumber: number, officeId: string | null, transaction?: Transaction): Promise<Row | null> {
  if (stepNumber >= 1) return getStep(doc.route_id, stepNumber, transaction)
  const office = officeId ? await Office.findByPk(officeId, { transaction }) : null
  return office ? ({ step_number: 0, office_id: office.id, office, is_final_checkpoint: false } as unknown as Row) : null
}

/** Where a messenger takes the document from here: back to the previous office for a send-back, else the next step. */
async function destinationOf(doc: Row, visit: Row | null, transaction?: Transaction) {
  const back = sendBackTarget(visit)
  if (back) return stepAt(doc, back.step, back.officeId, transaction)
  return getStep(doc.route_id, doc.current_step_number + 1, transaction)
}

async function openVisit(doc: Row, step: Row, status: string, transaction: Transaction) {
  return DocumentTracking.create(
    { document_id: doc.id, step_number: step.step_number, office_id: step.office_id, status, arrived_at: new Date() },
    { transaction },
  )
}

/**
 * Who decides at an office's final checkpoint: its STAFF and Department Heads, except delegated
 * Department Heads without "Approve or return". Only they get a PENDING approval row and the
 * "approval needed" notification.
 */
export async function approverIds(officeId: string | null | undefined, transaction?: Transaction) {
  if (!officeId) return []
  const people = await User.findAll({
    where: { office_id: officeId, status: { [Op.ne]: 'inactive' }, account_type: { [Op.in]: OFFICE_STAFF_TYPES } },
    attributes: ['id', 'account_type', 'assigned_by', 'permissions'],
    transaction,
  })
  return people.filter((u) => hasPermission(u, 'DECIDE_APPROVALS')).map((u) => u.id as string)
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

/** A routing code no other document uses. 10^6 codes per office prefix per day, so a retry is rare. */
async function uniqueRoutingCode(officeCode: string, uploadedAt: Date, transaction: Transaction) {
  for (let attempt = 0; attempt < 8; attempt++) {
    const code = buildRoutingCode(officeCode, uploadedAt)
    if (!(await QrCode.count({ where: { qr_code_data: code }, transaction }))) return code
  }
  throw conflict('Could not generate a unique QR code. Try again.')
}

/**
 * Where a new document originates, as a QR prefix: the uploader's assigned office, or for
 * accounts without one (the admin), their organization.
 */
async function originCode(actor: Actor, transaction: Transaction) {
  if (actor.office_id && actor.office?.code) return actor.office.code as string
  const offices = await Office.findAll({ where: { org_id: actor.org_id }, attributes: ['code'], transaction })
  return organizationCode(actor.organization?.name ?? '', offices.map((o) => o.code as string))
}

/**
 * Record who took the physical document in at its current office — on arrival, or from the
 * previous desk of the same office. At the last office on its route the first receipt also asks
 * that office (its employees and staff) for the final decision. Saves the visit.
 */
async function markReceived(doc: Row, visit: Row, actor: Actor, transaction: Transaction, { remarks = null as string | null } = {}) {
  const pass = pendingPass(visit)
  const approvalAsked = readLog(visit).some((e) => e.type === 'APPROVAL_REQUESTED')
  visit.handler_id = actor.id
  appendLog(visit, { type: 'RECEIVED', by: actor.id, status: doc.status, remarks, ...(pass && { meta: { from_staff_id: pass.by } }) })

  const step = await getStep(doc.route_id, doc.current_step_number, transaction)
  if (step && !approvalAsked && (await atLastStep(doc, transaction))) {
    appendLog(visit, { type: 'APPROVAL_REQUESTED', by: null, status: doc.status })
    const deciders = await approverIds(step.office_id, transaction)
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
      body: pass
        ? `${trackingNumber(doc.id)} moved to the next staff at ${step?.office?.name ?? 'the office'}: ${nameOf(actor)} received it (step ${doc.current_step_number}).`
        : `${trackingNumber(doc.id)} was received by ${nameOf(actor)} (step ${doc.current_step_number}).`,
      documentId: doc.id,
      link: docLink(doc.id),
    },
    { transaction, excludeUserId: actor.id },
  )
  if (pass?.by) {
    await notify(
      [pass.by],
      { type: 'DOCUMENT_RECEIVED', title: `Received from you: ${doc.title}`, body: `${nameOf(actor)} received ${trackingNumber(doc.id)} at the next desk.`, documentId: doc.id, link: docLink(doc.id) },
      { transaction, excludeUserId: actor.id },
    )
  }
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
  // The deadline is the document type's processing time from now, counted in the organization's
  // working hours (paused at night, on days off and on holidays); priority follows the document and that time.
  // The origin is where the uploader belongs: their office, or (no office) the organization itself.
  const submitter = doc.submitted_by === actor.id ? actor : await User.findByPk(doc.submitted_by, { transaction })
  const originOfficeId = (submitter?.office_id as string | null) ?? null
  const time = await allowedTimeFor(doc.org_id, doc.category, route.id, transaction, originOfficeId)
  const hours = time.days * 24 + time.hours + time.minutes / 60
  const now = new Date()
  const { calendar } = await loadWorkCalendar(doc.org_id)
  const startsAtFirst = Boolean(originOfficeId) && originOfficeId === first.office_id && isOfficeStaff(submitter!)

  await doc.update(
    {
      route_id: route.id,
      status: 'START',
      current_step_number: startsAtFirst ? 1 : 0,
      current_office_id: startsAtFirst ? first.office_id : originOfficeId,
      submitted_at: now,
      completed_at: null,
      target_completion_date: hours > 0 ? deadlineFrom(now, time, calendar) : null,
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
export async function allowedHoursFor(orgId: string, typeName: string | null | undefined, routeId: string, transaction?: Transaction, officeId?: string | null) {
  const { days, hours, minutes } = await allowedTimeFor(orgId, typeName, routeId, transaction, officeId)
  return days * 24 + hours + minutes / 60
}

/**
 * The same as days + hours + minutes (working time once the organization sets its working hours).
 * `officeId` = the uploader's office: a type of that name for their office wins over a Global one.
 */
export async function allowedTimeFor(orgId: string, typeName: string | null | undefined, routeId: string, transaction?: Transaction, officeId?: string | null) {
  const byType = await processingTimeFor(orgId, typeName, transaction, officeId)
  if (byType.days || byType.hours || byType.minutes) return byType
  return { ...(await routeTimeOf(routeId, transaction)), minutes: 0 }
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
  /** Pages/sheets of the paper document: entered for photos; otherwise the number of files. */
  pages?: number | null
}

/**
 * Create a document with its files — one, or many (a bulk upload) under the same QR code. The
 * first file is also documents.file_url; every file is listed in document_files, in order.
 */
export async function createDocument(actor: Actor, input: DocumentInput, files: StoredFile[], meta: RequestMeta) {
  requirePermission(actor, 'UPLOAD_DOCUMENTS')
  const file = files[0] ?? null
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
        priority: autoPriority({ ...input, routeHours: (await allowedHoursFor(actor.org_id, input.document_type, route.id, transaction, actor.office_id)) || null }),
        // Set when the document enters its route (see enterRoute).
        target_completion_date: null,
        status: 'CREATED',
        current_step_number: 1,
        submitted_by: actor.id,
        ...(file && { file_url: file.fileUrl, file_type: file.fileType, file_size: file.size }),
        pages: input.pages ?? (files.length || null),
      },
      { transaction },
    )
    if (files.length) {
      await DocumentFile.bulkCreate(
        files.map((f, i) => ({ document_id: doc.id, file_url: f.fileUrl, file_name: f.name, file_type: f.fileType, file_size: f.size, sort_order: i })),
        { transaction },
      )
    }
    // The QR label is printed right after upload and stays with the paper until it is done.
    const origin = await originCode(actor, transaction)
    await QrCode.create({ document_id: doc.id, qr_code_data: await uniqueRoutingCode(origin, new Date(doc.created_at), transaction), office_code: origin }, { transaction })

    if (input.submit) await enterRoute(doc, actor, 'SUBMITTED', transaction)
    await audit(meta, { action: 'DOCUMENT_CREATE', entityType: 'document', entityId: doc.id, after: doc.toJSON() }, transaction)
    return doc
  })
}

/** Draft → START, or RETURNED → START. `routeId` switches the document to another Document Route first. */
export async function submitDocument(documentId: string, actor: Actor, meta: RequestMeta, routeId?: string | null) {
  requirePermission(actor, 'UPLOAD_DOCUMENTS')
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
 * to pick up and nothing in hand. Each office has its own messengers: a document released from an
 * office goes with one of that office's messengers (`officeId`; null = the organization itself, the
 * origin of an admin upload, where any messenger can be used). Locks the messenger's profile so two
 * offices can't assign the same messenger at once (the caller's transaction must be READ COMMITTED
 * to see the other's commit).
 */
async function claimFreeMessenger(userId: string, orgId: string, officeId: string | null, transaction: Transaction) {
  const user = await User.findOne({ where: { id: userId, org_id: orgId, account_type: 'LIAISON', status: { [Op.ne]: 'inactive' } }, transaction })
  if (!user) throw badRequest('Selected messenger was not found')
  if (officeId && user.office_id !== officeId) {
    // An umbrella office may also use its parent office's messengers.
    const office = await Office.findByPk(officeId, { attributes: ['name', 'parent_office_id'], transaction })
    if (!office?.parent_office_id || user.office_id !== office.parent_office_id) {
      throw conflict(`${nameOf(user)} is not a messenger of ${office?.name ?? 'this office'}. Pick one of its own messengers.`, 'MESSENGER_OTHER_OFFICE')
    }
  }
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
  requirePermission(actor, 'RELEASE_DOCUMENTS')
  if (!liaisonUserId) throw badRequest('Choose the messenger who will carry the document', { field: 'liaison_user_id' })
  return sequelize.transaction({ isolationLevel: Transaction.ISOLATION_LEVELS.READ_COMMITTED }, async (transaction) => {
    const doc = await lockDocument(documentId, actor, transaction)
    if (!AT_OFFICE.includes(doc.status)) throw conflict('The messenger can only be changed before the document is picked up')
    assertHoldsDocument(doc, actor)
    const visit = await requireVisit(doc, transaction)
    assertNotAtUnit(doc, visit, 'release it to a messenger')
    if (pendingPass(visit)) throw conflict('This document was passed to the next staff. A messenger can be assigned once another staff member of the office scans it in.')
    if (!visit.handler_id) throw conflict('Scan the document’s QR code to receive it before releasing it')
    await assertReceiver(doc, visit, actor, transaction)
    // A send-back is fetched by the liaisons of the office it goes back to (claimReturnPickup), not released here.
    if (sendBackTarget(visit)) throw conflict('This document is being sent back: the liaisons of the office it goes back to pick it up. Cancel the send-back to release it another way.', 'SENDING_BACK')
    const previousId = visit.liaison_id as string | null
    if (previousId === liaisonUserId) throw conflict('That messenger is already assigned to this document')

    const atOrigin = doc.current_step_number === 0
    const step = atOrigin ? null : await getStep(doc.route_id, doc.current_step_number, transaction)
    if (!atOrigin && !step) throw conflict('Document route is missing this step')
    // Reassigning the messenger of a send-back keeps it going back to the previous office.
    const back = previousId ? sendBackTarget(visit) : null
    if (!back && step?.is_final_checkpoint) throw conflict('This is the final checkpoint — it is completed by approval, not released')
    const nextStep = back ? await stepAt(doc, back.step, back.officeId, transaction) : await getStep(doc.route_id, doc.current_step_number + 1, transaction)
    if (!nextStep) throw conflict('This is the last office on the route')

    const liaison = await claimFreeMessenger(liaisonUserId, actor.org_id, doc.current_office_id ?? null, transaction)
    const previous = previousId ? await User.findByPk(previousId, { transaction }) : null

    visit.liaison_id = liaison.id
    appendLog(visit, {
      type: previous ? 'MESSENGER_REASSIGNED' : 'PICKUP_REQUESTED',
      by: actor.id,
      status: doc.status,
      remarks: previous ? `${nameOf(previous)} → ${nameOf(liaison)}${remarks ? ` · ${remarks}` : ''}` : remarks,
      meta: {
        liaison_id: liaison.id,
        previous_liaison_id: previousId,
        next_office_id: nextStep.office_id,
        send_back_to: back?.officeId ?? null,
        ...(back && { target_step: back.step, issue_id: back.issueId }),
      },
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

// ---------------------------------------------------------------------------
// Return pickups: a flagged document goes back one office, and that office's liaisons fetch it.
// ---------------------------------------------------------------------------

/** Where a send-back goes: the previous step's office, or from the first office its origin (the uploader's office). */
async function returnTargetOf(doc: Row, transaction?: Transaction) {
  const targetStep = doc.current_step_number - 1
  let originOfficeId: string | null = null
  if (targetStep === 0) {
    originOfficeId = ((await User.findByPk(doc.submitted_by, { attributes: ['office_id'], transaction }))?.office_id as string | null) ?? null
    if (!originOfficeId) {
      throw conflict('This document came from the organization itself (an admin upload), so there is no office before this one to send it back to.', 'NO_PREVIOUS_OFFICE')
    }
  }
  const target = await stepAt(doc, targetStep, originOfficeId, transaction)
  if (!target) throw conflict('Document route is missing the previous step')
  return { target, targetStep }
}

/** The office a send-back of this document goes (or would go) to; null when it can't be sent back from here. */
export async function returnTargetPreview(doc: Row, visit: Row | null) {
  const back = sendBackTarget(visit)
  if (back) {
    const office = await Office.findByPk(back.officeId, { attributes: ['id', 'name'] })
    return office ? { id: office.id as string, name: office.name as string } : null
  }
  if (!AT_OFFICE.includes(doc.status) || doc.current_step_number === 0) return null
  try {
    const { target } = await returnTargetOf(doc)
    return target.office ? { id: target.office_id as string, name: target.office.name as string } : null
  } catch {
    return null
  }
}

/** A send-back waiting for one of the receiving office's liaisons to claim it (nobody has yet). */
export function openReturn(visit: Row | null | undefined) {
  const back = sendBackTarget(visit)
  return back && !visit!.liaison_id ? back : null
}

/** The offices whose liaisons may fetch a return to `officeId`: that office and its active umbrella offices. */
async function returnOfficeIds(orgId: string, officeId: string, transaction?: Transaction) {
  const units = await Office.findAll({ where: { org_id: orgId, parent_office_id: officeId, status: 'active' }, attributes: ['id'], transaction })
  return [officeId, ...units.map((u) => u.id as string)]
}

export interface ReturnLiaison {
  id: string
  first_name: string
  last_name: string
  office: { id: string; name: string } | null
  available: boolean
  busy: boolean
  /** In the umbrella office (or office) of the document's uploader. */
  uploader_unit: boolean
  recommended: boolean
}

/**
 * The liaisons who may fetch a return to `officeId` (that office and its umbrella offices): active
 * messenger accounts. Ordered for the recommendation — the uploader's own unit first, then free ones
 * (on duty, nothing to carry), then fewest deliveries today, longest since the last one, by name — and the
 * first free one is recommended. A preference only: any free one of them may claim it.
 */
export async function returnLiaisons(orgId: string, officeId: string, uploaderOfficeId: string | null, transaction?: Transaction): Promise<ReturnLiaison[]> {
  const officeIds = await returnOfficeIds(orgId, officeId, transaction)
  const users = await User.findAll({
    where: { org_id: orgId, account_type: 'LIAISON', status: { [Op.ne]: 'inactive' }, office_id: { [Op.in]: officeIds } },
    attributes: ['id', 'first_name', 'last_name', 'full_name', 'office_id'],
    include: [{ model: Office, as: 'office', attributes: ['id', 'name'] }],
    transaction,
  })
  if (!users.length) return []
  const profiles = await Liaison.findAll({ where: { user_id: { [Op.in]: users.map((u) => u.id) } }, transaction })
  const loads = await sequelize.query<{ id: string; n: number }>(
    `SELECT u.id, ${liaisonWorkloadSql('u.id')} AS n FROM users u WHERE u.id IN (:ids)`,
    { replacements: { ids: users.map((u) => u.id) }, type: QueryTypes.SELECT, transaction },
  )
  const rows = users
    .map((u) => {
      const profile = profiles.find((p) => p.user_id === u.id)
      const name = userSummary(u)!
      return {
        id: u.id as string,
        first_name: name.first_name as string,
        last_name: name.last_name as string,
        office: u.office ? { id: u.office.id as string, name: u.office.name as string } : null,
        available: Boolean(profile?.available),
        busy: Number(loads.find((l) => l.id === u.id)?.n ?? 0) > 0,
        uploader_unit: Boolean(uploaderOfficeId) && u.office_id === uploaderOfficeId,
        hasProfile: Boolean(profile),
        deliveries: Number(profile?.deliveries_today ?? 0),
        last: profile?.last_delivery ? new Date(profile.last_delivery).getTime() : 0,
      }
    })
    .filter((r) => r.hasProfile)
  const free = (r: (typeof rows)[number]) => r.available && !r.busy
  rows.sort(
    (a, b) =>
      Number(b.uploader_unit) - Number(a.uploader_unit) ||
      Number(free(b)) - Number(free(a)) ||
      a.deliveries - b.deliveries ||
      a.last - b.last ||
      `${a.first_name} ${a.last_name}`.localeCompare(`${b.first_name} ${b.last_name}`),
  )
  const pick = rows.find(free)?.id
  return rows.map(({ hasProfile: _h, deliveries: _d, last: _l, ...r }) => ({ ...r, recommended: r.id === pick }))
}

/**
 * Tell the eligible liaisons (on duty) of the office a return goes to that it can be claimed. Once per
 * return event: the event id is in the notification's link, and anyone already told about it is skipped,
 * so a retry never repeats it. Never includes the QR code.
 */
async function announceReturnPickup(doc: Row, officeId: string, eventId: string, body: string, actor: Actor, transaction: Transaction, except: string[] = []) {
  const uploaderOfficeId = ((await User.findByPk(doc.submitted_by, { attributes: ['office_id'], transaction }))?.office_id as string | null) ?? null
  const eligible = (await returnLiaisons(doc.org_id, officeId, uploaderOfficeId, transaction)).filter((l) => l.available && !except.includes(l.id))
  const link = `/liaison/dashboard?return=${eventId}`
  const already = await Notification.findAll({ where: { document_id: doc.id, action_url: link, user_id: { [Op.in]: eligible.map((l) => l.id) } }, attributes: ['user_id'], transaction })
  const told = new Set(already.map((n) => n.user_id as string))
  await notify(
    eligible.filter((l) => !told.has(l.id)).map((l) => l.id),
    { type: 'RETURN_PICKUP_AVAILABLE', title: `Return pickup available: ${doc.title}`, body, documentId: doc.id, link },
    { transaction, excludeUserId: actor.id },
  )
}

/**
 * A liaison of the office a flagged document goes back to claims its return pickup. Exactly one claim wins
 * (the document row is locked): the others get a conflict. The liaison must be on duty with nothing else to
 * carry, and belong to that office or one of its umbrella offices — knowing the document's id is not enough.
 */
export async function claimReturnPickup(documentId: string, actor: Actor) {
  if (actor.account_type !== 'LIAISON') throw forbidden('Only a liaison can claim a return pickup')
  return sequelize.transaction({ isolationLevel: Transaction.ISOLATION_LEVELS.READ_COMMITTED }, async (transaction) => {
    const doc = await lockDocument(documentId, actor, transaction)
    if (!AT_OFFICE.includes(doc.status)) throw conflict('This document is no longer waiting for a pickup', 'RETURN_NOT_OPEN')
    const visit = await requireVisit(doc, transaction)
    const back = sendBackTarget(visit)
    if (!back) throw conflict('This document is not being sent back', 'RETURN_NOT_OPEN')
    if (visit.liaison_id) throw conflict(visit.liaison_id === actor.id ? 'You already claimed this pickup' : 'Another liaison already claimed this pickup', 'RETURN_ALREADY_CLAIMED')
    const officeIds = await returnOfficeIds(actor.org_id, back.officeId, transaction)
    if (!actor.office_id || !officeIds.includes(actor.office_id)) throw forbidden('Only the liaisons of the office it goes back to can claim this pickup')
    const liaison = await claimFreeMessenger(actor.id, actor.org_id, null, transaction)

    visit.liaison_id = liaison.id
    const here = await locationName(doc, transaction)
    const target = await Office.findByPk(back.officeId, { attributes: ['id', 'name'], transaction })
    appendLog(visit, {
      type: 'RETURN_CLAIMED',
      by: actor.id,
      status: doc.status,
      meta: { liaison_id: liaison.id, next_office_id: back.officeId, send_back_to: back.officeId, target_step: back.step, issue_id: back.issueId },
    })
    await visit.save({ transaction })
    await touch(doc, transaction)
    // The other liaisons' "available" notices about this return are done with.
    await Notification.update({ is_read: true, read_at: new Date() }, { where: { document_id: doc.id, type: 'RETURN_PICKUP_AVAILABLE', is_read: false, user_id: { [Op.ne]: actor.id } }, transaction })
    await audit({ user: actor }, { action: 'DOCUMENT_RETURN_CLAIM', entityType: 'document', entityId: doc.id, after: { liaison_id: liaison.id, from: doc.current_office_id, to: back.officeId, issue_id: back.issueId } }, transaction)
    await notify(
      [...(await officeMemberIds(doc.current_office_id, OFFICE_STAFF_TYPES, transaction)), ...(await officeMemberIds(back.officeId, OFFICE_STAFF_TYPES, transaction))],
      {
        type: 'RETURN_PICKUP_CLAIMED',
        title: `Return pickup claimed: ${doc.title}`,
        body: `${nameOf(actor)} will take ${trackingNumber(doc.id)} from ${here} back to ${target?.name ?? 'the previous office'}.`,
        documentId: doc.id,
        link: docLink(doc.id),
      },
      { transaction, excludeUserId: actor.id },
    )
    broadcast(doc, transaction)
    return doc
  })
}

/** The liaison who claimed a return can't go after all (before picking it up): it is open again, and the others are told. */
export async function releaseReturnClaim(documentId: string, actor: Actor) {
  if (actor.account_type !== 'LIAISON') throw forbidden('Only the liaison who claimed it can give it up')
  return sequelize.transaction(async (transaction) => {
    const doc = await lockDocument(documentId, actor, transaction)
    if (!AT_OFFICE.includes(doc.status)) throw conflict('It was already picked up — report a failed delivery instead if you can’t deliver it')
    const visit = await requireVisit(doc, transaction)
    const back = sendBackTarget(visit)
    if (!back || visit.liaison_id !== actor.id) throw conflict('You haven’t claimed this return pickup', 'RETURN_NOT_CLAIMED')
    visit.liaison_id = null
    const event = appendLog(visit, {
      type: 'RETURN_UNCLAIMED',
      by: actor.id,
      status: doc.status,
      meta: { liaison_id: null, next_office_id: back.officeId, send_back_to: back.officeId, target_step: back.step, issue_id: back.issueId, return_pickup: true },
    })
    await visit.save({ transaction })
    await touch(doc, transaction)
    await audit({ user: actor }, { action: 'DOCUMENT_RETURN_UNCLAIM', entityType: 'document', entityId: doc.id, after: { liaison_id: actor.id, to: back.officeId } }, transaction)
    const here = await locationName(doc, transaction)
    await announceReturnPickup(doc, back.officeId, event.id, `${trackingNumber(doc.id)} · ${doc.title}: ${nameOf(actor)} can’t fetch it after all. It is waiting at ${here} to be taken back — claim the pickup.`, actor, transaction, [actor.id])
    broadcast(doc, transaction)
    return doc
  })
}

/** Take the document back from the messenger before they pick it up. */
export async function cancelPickup(documentId: string, actor: Actor) {
  requirePermission(actor, 'RELEASE_DOCUMENTS')
  return sequelize.transaction(async (transaction) => {
    const doc = await lockDocument(documentId, actor, transaction)
    assertHoldsDocument(doc, actor)
    const visit = AT_OFFICE.includes(doc.status) ? await requireVisit(doc, transaction) : null
    // Released to a messenger, or sent back and waiting for a liaison to claim it: cancelling ends either.
    const returning = openReturn(visit)
    if (!visit?.liaison_id && !returning) throw conflict('This document has not been released to a messenger')
    await assertReceiver(doc, visit!, actor, transaction)
    const liaisonId = visit!.liaison_id as string | null
    visit!.liaison_id = null
    appendLog(visit!, { type: 'NOTE', by: actor.id, status: doc.status, remarks: returning ? 'Send-back cancelled — the return pickup is withdrawn' : 'Release cancelled — messenger unassigned', meta: { send_back_to: null } })
    if (returning) await Notification.update({ is_read: true, read_at: new Date() }, { where: { document_id: doc.id, type: 'RETURN_PICKUP_AVAILABLE', is_read: false }, transaction })
    await visit!.save({ transaction })
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

/**
 * Flag and send back: the person who received the document at this office found a problem (an issue is
 * flagged with it) and sends it back to the previous office on its route — or, from the first office, back
 * to its origin office. It doesn't pick a messenger: every eligible liaison of the office it goes back to is
 * notified, and any one of them claims the pickup (claimReturnPickup), comes for it and carries it back. The
 * issue moves to IN_PROGRESS. That office scans it in as usual; from there it is routed forward again.
 */
export async function sendBack(documentId: string, actor: Actor, { issueId, remarks = null }: { issueId: string; remarks?: string | null }) {
  requirePermission(actor, 'SEND_BACK_DOCUMENTS')
  if (!issueId) throw badRequest('Flag the issue first, then send the document back', { field: 'issue_id' })
  return sequelize.transaction({ isolationLevel: Transaction.ISOLATION_LEVELS.READ_COMMITTED }, async (transaction) => {
    const doc = await lockDocument(documentId, actor, transaction)
    if (!AT_OFFICE.includes(doc.status) || doc.current_step_number === 0) throw conflict('Only a document received at your office can be sent back')
    assertHoldsDocument(doc, actor)
    const visit = await requireVisit(doc, transaction)
    assertNotAtUnit(doc, visit, 'send it back')
    if (pendingPass(visit)) throw conflict('This document was passed to the next staff. It can be sent back once another staff member of the office scans it in.')
    if (!visit.handler_id) throw conflict('Scan the document’s QR code to receive it before sending it back')
    await assertReceiver(doc, visit, actor, transaction, 'send it back')
    if (visit.liaison_id) throw conflict('A messenger is already assigned to this document. Unassign them before sending it back.')
    if (sendBackTarget(visit)) throw conflict('This document is already being sent back', 'ALREADY_SENT_BACK')

    const issue = await Issue.findOne({ where: { id: issueId, document_id: doc.id }, transaction, lock: transaction.LOCK.UPDATE })
    if (!issue) throw badRequest('That issue was not flagged on this document', { field: 'issue_id' })
    if (['RESOLVED', 'CLOSED'].includes(issue.status)) throw conflict('That issue is already resolved. Flag a new one to send the document back.')

    const { target, targetStep } = await returnTargetOf(doc, transaction)
    const event = appendLog(visit, {
      type: 'SENT_BACK',
      by: actor.id,
      status: doc.status,
      remarks: remarks || issue.title,
      meta: { liaison_id: null, next_office_id: target.office_id, send_back_to: target.office_id, target_step: targetStep, issue_id: issue.id, return_pickup: true },
    })
    await visit.save({ transaction })
    await touch(doc, transaction)
    if (issue.status === 'OPEN') await issue.update({ status: 'IN_PROGRESS' }, { transaction })

    const here = await locationName(doc, transaction)
    const to = target.office?.name ?? 'the previous office'
    await announceReturnPickup(doc, target.office_id, event.id, `${trackingNumber(doc.id)} · ${doc.title}: ${here} flagged an issue (${issue.title}) and is sending it back to ${to}. Claim the pickup to bring it back.`, actor, transaction)
    await notify(
      await officeMemberIds(target.office_id, OFFICE_STAFF_TYPES, transaction),
      {
        type: 'DOCUMENT_SENT_BACK',
        title: `Sent back to your office: ${doc.title}`,
        body: `${here} flagged an issue and is sending ${trackingNumber(doc.id)} back: ${issue.title}. Your office’s liaisons were told to pick it up; scan its QR code when it arrives.`,
        documentId: doc.id,
        link: docLink(doc.id),
      },
      { transaction, excludeUserId: actor.id },
    )
    await notify(
      [doc.submitted_by],
      {
        type: 'DOCUMENT_SENT_BACK',
        title: `Flagged and sent back: ${doc.title}`,
        body: `${here} sent ${trackingNumber(doc.id)} back to ${to}: ${issue.title}`,
        documentId: doc.id,
        link: docLink(doc.id),
      },
      { transaction, excludeUserId: actor.id },
    )
    broadcast(doc, transaction)
    return { doc, issue }
  })
}

/**
 * Desk to desk inside an office: the staff member who received the document passes it on to the
 * next staff of the same office. It is no longer received (handler_id cleared), so nobody can
 * release it to a messenger — or pass it again — until another staff member scans it in.
 */
export async function passToNextStaff(documentId: string, actor: Actor, { remarks = null }: { remarks?: string | null } = {}) {
  requirePermission(actor, 'PASS_DOCUMENTS')
  return sequelize.transaction(async (transaction) => {
    const doc = await lockDocument(documentId, actor, transaction)
    if (!AT_OFFICE.includes(doc.status) || doc.current_step_number === 0) throw conflict('Only a document received at your office can be passed to the next staff')
    assertHoldsDocument(doc, actor)
    const visit = await requireVisit(doc, transaction)
    if (!visit.handler_id) throw conflict('Scan the document’s QR code to receive it before passing it on')
    await assertReceiver(doc, visit, actor, transaction, 'pass it to the next staff')
    if (visit.liaison_id) throw conflict('A messenger is assigned to this document. Unassign them before passing it to the next staff.')
    if (openReturn(visit)) throw conflict('This document is being sent back. Cancel the send-back before passing it to the next staff.', 'SENDING_BACK')
    const colleagues = (await officeMemberIds(doc.current_office_id, OFFICE_STAFF_TYPES, transaction)).filter((id) => id !== actor.id)
    if (!colleagues.length) throw conflict('Nobody else at your office can receive it')

    visit.handler_id = null
    appendLog(visit, { type: 'PASSED_TO_STAFF', by: actor.id, status: doc.status, remarks })
    await visit.save({ transaction })
    await touch(doc, transaction)

    const here = await locationName(doc, transaction)
    await notify(
      colleagues,
      {
        type: 'DOCUMENT_PASSED',
        title: `Passed to the next staff: ${doc.title}`,
        body: `${nameOf(actor)} passed ${trackingNumber(doc.id)} on at ${here}. Scan its QR code to receive it at your desk.${remarks ? ` Note: ${remarks}` : ''}`,
        documentId: doc.id,
        link: docLink(doc.id),
      },
      { transaction, excludeUserId: actor.id },
    )
    broadcast(doc, transaction)
    return doc
  })
}

/** Undo a pass before anyone at the next desk scans the document in: it is received by the passer again. */
export async function takeBackPass(documentId: string, actor: Actor) {
  requirePermission(actor, 'PASS_DOCUMENTS')
  return sequelize.transaction(async (transaction) => {
    const doc = await lockDocument(documentId, actor, transaction)
    assertHoldsDocument(doc, actor)
    const visit = AT_OFFICE.includes(doc.status) ? await requireVisit(doc, transaction) : null
    const pass = pendingPass(visit)
    if (!visit || !pass) throw conflict('This document is not waiting to be received by the next staff')
    if (pass.by !== actor.id) throw forbidden('Only the person who passed it on can take it back')

    visit.handler_id = actor.id
    appendLog(visit, { type: 'PASS_CANCELLED', by: actor.id, status: doc.status, remarks: 'Taken back before the next staff received it' })
    await visit.save({ transaction })
    await touch(doc, transaction)
    await notify(
      (await officeMemberIds(doc.current_office_id, OFFICE_STAFF_TYPES, transaction)).filter((id) => id !== actor.id),
      { type: 'DOCUMENT_PASSED', title: `Taken back: ${doc.title}`, body: `${nameOf(actor)} took ${trackingNumber(doc.id)} back. You don't need to receive it.`, documentId: doc.id, link: docLink(doc.id) },
      { transaction, excludeUserId: actor.id },
    )
    broadcast(doc, transaction)
    return doc
  })
}

// ---------------------------------------------------------------------------
// Umbrella offices: units of an office, reached by a hand-off inside the route step
// ---------------------------------------------------------------------------

/**
 * Hand a received document to one of the office's umbrella offices (units). It stays on the same route
 * step: the unit scans it in, works on it, and returns it to the office, which then releases it onward
 * (or decides, at the final checkpoint). Only the person who received it at the office may hand it off.
 */
export async function handToUmbrella(documentId: string, actor: Actor, { umbrellaId, remarks = null }: { umbrellaId: string; remarks?: string | null }, meta: RequestMeta = { user: actor }) {
  requirePermission(actor, 'UMBRELLA_HANDOFF')
  if (!umbrellaId) throw badRequest('Choose the umbrella office', { field: 'umbrella_id' })
  return sequelize.transaction(async (transaction) => {
    const doc = await lockDocument(documentId, actor, transaction)
    if (!AT_OFFICE.includes(doc.status) || doc.current_step_number === 0) throw conflict('Only a document received at your office can be handed to an umbrella office')
    assertHoldsDocument(doc, actor)
    const visit = await requireVisit(doc, transaction)
    if (atUnit(doc, visit)) throw conflict('This document is already with an umbrella office')
    if (await activeInternalTransaction(doc.id, transaction)) throw conflict('This document is following an internal route', 'INTERNAL_ACTIVE')
    if (pendingPass(visit)) throw conflict('This document was passed to the next staff. It can be handed off once another staff member of the office scans it in.')
    if (!visit.handler_id) throw conflict('Scan the document’s QR code to receive it before handing it to an umbrella office')
    await assertReceiver(doc, visit, actor, transaction, 'hand it to an umbrella office')
    if (visit.liaison_id) throw conflict('A messenger is assigned to this document. Unassign them before handing it to an umbrella office.')
    if (openReturn(visit)) throw conflict('This document is being sent back. Cancel the send-back before handing it to an umbrella office.', 'SENDING_BACK')
    const umbrella = await Office.findOne({ where: { id: umbrellaId, org_id: actor.org_id, parent_office_id: doc.current_office_id, status: 'active' }, transaction })
    if (!umbrella) throw badRequest('That is not an active umbrella office of this office', { field: 'umbrella_id' })

    const from = doc.current_office_id as string
    visit.handler_id = null
    appendLog(visit, { type: 'HANDED_TO_UMBRELLA', by: actor.id, status: doc.status, remarks, meta: { umbrella_id: umbrella.id, from_office_id: from } })
    await visit.save({ transaction })
    await doc.update({ current_office_id: umbrella.id }, { transaction })
    await audit(meta, { action: 'DOCUMENT_UMBRELLA_HANDOFF', entityType: 'document', entityId: doc.id, after: { from_office_id: from, umbrella_id: umbrella.id, step: doc.current_step_number } }, transaction)
    await notify(
      await officeMemberIds(umbrella.id, OFFICE_STAFF_TYPES, transaction),
      {
        type: 'DOCUMENT_INCOMING',
        title: `Handed to ${umbrella.name}: ${doc.title}`,
        body: `${nameOf(actor)} handed ${trackingNumber(doc.id)} to your unit. Scan its QR code to receive it.${remarks ? ` Note: ${remarks}` : ''}`,
        documentId: doc.id,
        link: docLink(doc.id),
      },
      { transaction, excludeUserId: actor.id },
    )
    broadcast(doc, transaction)
    return doc
  })
}

/** The umbrella office is done: the person who received it there returns it to its office, which scans it in again. */
export async function returnFromUmbrella(documentId: string, actor: Actor, { remarks = null }: { remarks?: string | null } = {}, meta: RequestMeta = { user: actor }) {
  requirePermission(actor, 'UMBRELLA_HANDOFF')
  return sequelize.transaction(async (transaction) => {
    const doc = await lockDocument(documentId, actor, transaction)
    if (!AT_OFFICE.includes(doc.status)) throw conflict('This document is not at an office')
    const visit = await requireVisit(doc, transaction)
    if (!atUnit(doc, visit)) throw conflict('This document is not with an umbrella office')
    assertHoldsDocument(doc, actor)
    if (pendingPass(visit)) throw conflict('This document was passed to the next staff of the unit. Return it once they have scanned it in.')
    if (!visit.handler_id) throw conflict('Scan the document’s QR code to receive it before returning it')
    await assertReceiver(doc, visit, actor, transaction, 'return it to its office')

    const unit = doc.current_office_id as string
    const office = await Office.findByPk(visit.office_id, { attributes: ['id', 'name'], transaction })
    // Following an internal route: returning it now ends the route early (the remaining units are skipped).
    const internal = await activeInternalTransaction(doc.id, transaction)
    visit.handler_id = null
    if (internal) {
      appendLog(visit, {
        type: 'INTERNAL_ROUTE_ENDED',
        by: actor.id,
        status: doc.status,
        remarks,
        meta: { transaction_id: internal.id, route_name: internal.route_name, from_office_id: unit, to_office_id: visit.office_id, internal_step: internal.current_index + 1, internal_steps: internalSteps(internal).length },
      })
      await internal.update({ status: 'CANCELLED', ended_by: actor.id, ended_at: new Date(), updated_at: new Date() }, { transaction })
    } else {
      appendLog(visit, { type: 'RETURNED_FROM_UMBRELLA', by: actor.id, status: doc.status, remarks, meta: { umbrella_id: unit, to_office_id: visit.office_id } })
    }
    await visit.save({ transaction })
    await doc.update({ current_office_id: visit.office_id }, { transaction })
    await audit(
      meta,
      internal
        ? { action: 'DOCUMENT_INTERNAL_END', entityType: 'document', entityId: doc.id, after: { transaction_id: internal.id, route_name: internal.route_name, from_office_id: unit, to_office_id: visit.office_id, step: doc.current_step_number } }
        : { action: 'DOCUMENT_UMBRELLA_RETURN', entityType: 'document', entityId: doc.id, after: { umbrella_id: unit, to_office_id: visit.office_id, step: doc.current_step_number } },
      transaction,
    )
    await notify(
      await officeMemberIds(visit.office_id, OFFICE_STAFF_TYPES, transaction),
      {
        type: 'DOCUMENT_INCOMING',
        title: `Back from the umbrella office: ${doc.title}`,
        body: `${nameOf(actor)} returned ${trackingNumber(doc.id)} to ${office?.name ?? 'your office'}. Scan its QR code to receive it.${remarks ? ` Note: ${remarks}` : ''}`,
        documentId: doc.id,
        link: docLink(doc.id),
      },
      { transaction, excludeUserId: actor.id },
    )
    broadcast(doc, transaction)
    return doc
  })
}

// ---------------------------------------------------------------------------
// Internal routes: an office sends a received document through several of its units, in order
// (internal-routes.ts). The document stays on the office's route step the whole time — current_step_number
// is never touched here — and comes back to the office, which scans it in again and releases it onward.
// While a unit has it, the same rules as an umbrella hand-off apply (see atUnit): no release, send-back or
// decision; only the unit's receiver moves it on. Each move is a visit event, an audit entry and a
// notification to the unit (or office) that receives it next.
// ---------------------------------------------------------------------------

export interface InternalStep {
  office_id: string
  name: string
  code: string
  action_label: string | null
}

export const internalSteps = (t: Row): InternalStep[] => {
  try {
    const list = JSON.parse(String(t.steps ?? '[]'))
    return Array.isArray(list) ? list : []
  } catch {
    return []
  }
}

/** The internal route the document is following right now, if any (locked when inside a transaction). */
export function activeInternalTransaction(documentId: string, transaction?: Transaction) {
  return DocumentInternalTransaction.findOne({ where: { document_id: documentId, status: 'ACTIVE' }, transaction, ...(transaction && { lock: transaction.LOCK.UPDATE }) })
}

/**
 * Start an internal route: only the person who received the document at the office, with "Hand to umbrella
 * offices", while it is at the office (not at a unit, not passed on, no messenger) and not on another
 * internal route. The route must be an active internal route *of this office*, and every unit on it must
 * still be an active umbrella office of this office. The steps are copied onto the transaction, so later
 * edits to the route don't move a document already on it.
 */
export async function startInternalRoute(documentId: string, actor: Actor, { routeId, remarks = null }: { routeId: string; remarks?: string | null }, meta: RequestMeta = { user: actor }) {
  requirePermission(actor, 'UMBRELLA_HANDOFF')
  if (!routeId) throw badRequest('Choose the internal route', { field: 'route_id' })
  return sequelize.transaction(async (transaction) => {
    const doc = await lockDocument(documentId, actor, transaction)
    if (!AT_OFFICE.includes(doc.status) || doc.current_step_number === 0) throw conflict('Only a document received at your office can follow an internal route')
    assertHoldsDocument(doc, actor)
    const visit = await requireVisit(doc, transaction)
    if (atUnit(doc, visit)) throw conflict('This document is with an umbrella office. It can start an internal route once it is back at its office.')
    if (await activeInternalTransaction(doc.id, transaction)) throw conflict('This document is already following an internal route', 'INTERNAL_ACTIVE')
    if (pendingPass(visit)) throw conflict('This document was passed to the next staff. It can start an internal route once another staff member of the office scans it in.')
    if (!visit.handler_id) throw conflict('Scan the document’s QR code to receive it before starting an internal route')
    await assertReceiver(doc, visit, actor, transaction, 'start an internal route')
    if (visit.liaison_id) throw conflict('A messenger is assigned to this document. Unassign them before starting an internal route.')
    if (openReturn(visit)) throw conflict('This document is being sent back. Cancel the send-back before starting an internal route.', 'SENDING_BACK')

    const route = await InternalRoute.findOne({
      where: { id: routeId, org_id: actor.org_id, office_id: doc.current_office_id, is_active: true },
      include: [{ model: InternalRouteStep, as: 'steps', include: [{ model: Office, as: 'office', attributes: ['id', 'name', 'code', 'status', 'parent_office_id'] }] }],
      transaction,
    })
    if (!route) throw badRequest('That is not an active internal route of this office', { field: 'route_id' })
    const steps = [...((route.steps as Row[]) ?? [])].sort((a, b) => a.step_number - b.step_number)
    if (steps.length < 2) throw conflict('This internal route has no steps. Edit it first.')
    for (const s of steps) {
      if (!s.office || s.office.status === 'inactive' || s.office.parent_office_id !== doc.current_office_id) {
        throw conflict(`${s.office?.name ?? 'A unit on this route'} is no longer an active umbrella office of this office. Edit the route first.`)
      }
    }
    const snapshot: InternalStep[] = steps.map((s) => ({ office_id: s.office_id, name: s.office.name, code: s.office.code, action_label: s.action_label ?? null }))
    const now = new Date()
    const parent = doc.current_office_id as string
    const internal = await DocumentInternalTransaction.create(
      {
        org_id: doc.org_id,
        document_id: doc.id,
        internal_route_id: route.id,
        route_name: route.name,
        parent_office_id: parent,
        route_step_number: doc.current_step_number,
        steps: JSON.stringify(snapshot),
        current_index: 0,
        status: 'ACTIVE',
        started_by: actor.id,
        started_at: now,
        created_at: now,
        updated_at: now,
      },
      { transaction },
    )
    const first = snapshot[0]!
    visit.handler_id = null
    appendLog(visit, {
      type: 'INTERNAL_ROUTE_STARTED',
      by: actor.id,
      status: doc.status,
      remarks,
      meta: { transaction_id: internal.id, route_id: route.id, route_name: route.name, from_office_id: parent, to_office_id: first.office_id, internal_step: 1, internal_steps: snapshot.length },
    })
    await visit.save({ transaction })
    await doc.update({ current_office_id: first.office_id }, { transaction })
    await audit(meta, { action: 'DOCUMENT_INTERNAL_START', entityType: 'document', entityId: doc.id, after: { transaction_id: internal.id, route_id: route.id, route_name: route.name, to_office_id: first.office_id, step: doc.current_step_number } }, transaction)
    await notifyInternalArrival(doc, actor, first.office_id, `${route.name}, step 1 of ${snapshot.length}${first.action_label ? `: ${first.action_label}` : ''}`, remarks, transaction)
    broadcast(doc, transaction)
    return doc
  })
}

/**
 * The unit is done: its receiver passes the document to the next unit on the internal route, or — at the
 * last unit — back to the office (the route is then complete). Each receiving unit scans it in.
 */
export async function advanceInternalRoute(documentId: string, actor: Actor, { remarks = null }: { remarks?: string | null } = {}, meta: RequestMeta = { user: actor }) {
  requirePermission(actor, 'UMBRELLA_HANDOFF')
  return sequelize.transaction(async (transaction) => {
    const doc = await lockDocument(documentId, actor, transaction)
    if (!AT_OFFICE.includes(doc.status)) throw conflict('This document is not at an office')
    const visit = await requireVisit(doc, transaction)
    const internal = await activeInternalTransaction(doc.id, transaction)
    if (!internal || !atUnit(doc, visit)) throw conflict('This document is not following an internal route', 'NO_INTERNAL_ROUTE')
    const steps = internalSteps(internal)
    const here = steps[internal.current_index]
    if (!here || here.office_id !== doc.current_office_id || internal.parent_office_id !== visit.office_id || internal.route_step_number !== doc.current_step_number) {
      throw conflict('This document’s internal route doesn’t match where it is. Return it to its office.')
    }
    assertHoldsDocument(doc, actor)
    if (pendingPass(visit)) throw conflict('This document was passed to the next staff of the unit. Pass it on once they have scanned it in.')
    if (!visit.handler_id) throw conflict('Scan the document’s QR code to receive it before passing it on')
    await assertReceiver(doc, visit, actor, transaction, 'pass it on')

    const next = steps[internal.current_index + 1] ?? null
    const now = new Date()
    visit.handler_id = null
    if (next) {
      const unit = await Office.findOne({ where: { id: next.office_id, org_id: actor.org_id, parent_office_id: internal.parent_office_id, status: 'active' }, transaction })
      if (!unit) throw conflict(`${next.name} is no longer an active umbrella office. Return the document to its office.`)
      appendLog(visit, {
        type: 'INTERNAL_ROUTE_MOVED',
        by: actor.id,
        status: doc.status,
        remarks,
        meta: { transaction_id: internal.id, route_name: internal.route_name, from_office_id: here.office_id, to_office_id: next.office_id, internal_step: internal.current_index + 2, internal_steps: steps.length },
      })
      await visit.save({ transaction })
      await internal.update({ current_index: internal.current_index + 1, updated_at: now }, { transaction })
      await doc.update({ current_office_id: next.office_id }, { transaction })
      await audit(meta, { action: 'DOCUMENT_INTERNAL_MOVE', entityType: 'document', entityId: doc.id, after: { transaction_id: internal.id, from_office_id: here.office_id, to_office_id: next.office_id, internal_step: internal.current_index + 1, step: doc.current_step_number } }, transaction)
      await notifyInternalArrival(doc, actor, next.office_id, `${internal.route_name}, step ${internal.current_index + 1} of ${steps.length}${next.action_label ? `: ${next.action_label}` : ''}`, remarks, transaction)
    } else {
      appendLog(visit, {
        type: 'INTERNAL_ROUTE_COMPLETED',
        by: actor.id,
        status: doc.status,
        remarks,
        meta: { transaction_id: internal.id, route_name: internal.route_name, from_office_id: here.office_id, to_office_id: visit.office_id, internal_steps: steps.length },
      })
      await visit.save({ transaction })
      await internal.update({ status: 'COMPLETED', ended_by: actor.id, ended_at: now, updated_at: now }, { transaction })
      await doc.update({ current_office_id: visit.office_id }, { transaction })
      await audit(meta, { action: 'DOCUMENT_INTERNAL_COMPLETE', entityType: 'document', entityId: doc.id, after: { transaction_id: internal.id, from_office_id: here.office_id, to_office_id: visit.office_id, step: doc.current_step_number } }, transaction)
      await notifyInternalArrival(doc, actor, visit.office_id, `back from ${internal.route_name} (all ${steps.length} steps done)`, remarks, transaction)
    }
    broadcast(doc, transaction)
    return { doc, completed: !next }
  })
}

async function notifyInternalArrival(doc: Row, actor: Actor, officeId: string, what: string, remarks: string | null, transaction: Transaction) {
  await notify(
    await officeMemberIds(officeId, OFFICE_STAFF_TYPES, transaction),
    {
      type: 'DOCUMENT_INCOMING',
      title: `Internal route: ${doc.title}`,
      body: `${nameOf(actor)} sent ${trackingNumber(doc.id)} to you (${what}). Scan its QR code to receive it.${remarks ? ` Note: ${remarks}` : ''}`,
      documentId: doc.id,
      link: docLink(doc.id),
    },
    { transaction, excludeUserId: actor.id },
  )
}

/** Replace a lost or damaged QR label: a new code with the same office prefix. The old label stops working. */
export async function regenerateQr(documentId: string, actor: Actor) {
  requirePermission(actor, 'RECEIVE_DOCUMENTS')
  return sequelize.transaction(async (transaction) => {
    const doc = await lockDocument(documentId, actor, transaction)
    assertHoldsDocument(doc, actor)
    if (!AT_OFFICE.includes(doc.status)) throw conflict('The QR label can only be replaced while the document is at your office')
    const visit = await requireVisit(doc, transaction)
    const qr = await QrCode.findOne({ where: { document_id: doc.id }, transaction, lock: transaction.LOCK.UPDATE })
    const officeCode = (qr?.office_code as string | undefined) || (await originCode(actor, transaction))
    // Same office and upload date as before; only the random digits change.
    const code = await uniqueRoutingCode(officeCode, new Date(doc.created_at), transaction)
    if (qr) await qr.update({ qr_code_data: code, office_code: officeCode }, { transaction })
    else await QrCode.create({ document_id: doc.id, qr_code_data: code, office_code: officeCode }, { transaction })
    appendLog(visit, { type: 'NOTE', by: actor.id, status: doc.status, remarks: 'QR label replaced — the previous label no longer works' })
    await visit.save({ transaction })
    return { doc }
  })
}

async function loadQrContext(codeRaw: string, actor: Actor, transaction?: Transaction) {
  const { code } = parseRoutingCode(codeRaw)
  // Typed with or without the dashes around the date: either finds the label.
  const alternate = alternateRoutingCode(code)
  const qr = await QrCode.findOne({ where: { qr_code_data: alternate ? [code, alternate] : code }, transaction })
  if (!qr) throw notFound('Document with this QR code')
  const doc = await Document.findOne({ where: { id: qr.document_id, org_id: actor.org_id }, transaction, ...(transaction && { lock: transaction.LOCK.UPDATE }) })
  if (!doc) throw notFound('Document with this QR code')
  const visit = doc.status === 'CREATED' ? null : await getCurrentVisit(doc, transaction)
  const current = doc.current_office_id ? await Office.findByPk(doc.current_office_id, { transaction }) : null
  const next = await destinationOf(doc, visit, transaction)
  // Where it is now, by name: its office, or the organization at the origin of an admin upload.
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
 *   office staff   RECEIVE — it waits unreceived at their office (also when a co-worker passed it to
 *                            the next staff — anyone there but that co-worker), it is being carried to their
 *                            office (the next one on the route), or — at the origin, with no
 *                            messenger assigned — it was brought to the first office by hand.
 *                            Nobody else can receive it.
 */
function resolveScanAction(doc: Row, visit: Row | null, actor: Actor, at: string, next: Row | null): ScanDecision {
  const to = next?.office?.name ?? 'the next office'
  if (doc.status === 'CREATED') return deny('This document is still a draft. It has to be submitted before it can be routed.')
  // Approved at the last office: its QR label is retired, a scan only says so.
  if (doc.status === 'COMPLETED') return inform('This document is already completed: it was approved at the last office on its route. Its QR label no longer works, so there is nothing to pick up or receive.')
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
  // A delegated Department Head receives only with the "Receive documents" permission.
  if (!hasPermission(actor, 'RECEIVE_DOCUMENTS')) return deny('Your account doesn’t have the “Receive documents” permission. Ask the Department Head who assigned you.')

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
    if (!visit.handler_id) {
      // Passed desk to desk: anyone else at the office takes it in.
      if (pendingPass(visit)?.by === actor.id) return inform(`You passed this document to the next staff. Another staff member of ${at} scans it to receive it — or take it back on the document page.`)
      return { action: 'RECEIVE' }
    }
    if (atUnit(doc, visit)) return inform('Already received at your umbrella office. Return it to its office when you are done.')
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
  const pass = AT_OFFICE.includes(doc.status) ? pendingPass(visit) : null
  const lite = (o: Row | null | undefined) => (o ? { id: o.id, code: o.code, name: o.name, department_name: o.department ?? '' } : null)
  const people = await User.findAll({
    where: { id: { [Op.in]: [visit?.liaison_id, visit?.handler_id, pass?.by].filter(Boolean) as string[] } },
    attributes: ['id', 'first_name', 'last_name', 'full_name', 'email', 'account_type'],
  })
  const person = (id?: string | null) => (id ? userSummary(people.find((u) => u.id === id)) : null)
  const carrying = CARRYING.includes(doc.status)
  // A completed document: who approved it, and where.
  const approval =
    doc.status === 'COMPLETED'
      ? await Approval.findOne({
          where: { document_id: doc.id, status: 'APPROVED' },
          include: [
            { model: User, as: 'staff', attributes: ['id', 'first_name', 'last_name', 'full_name', 'email', 'account_type'] },
            { model: Office, as: 'office', attributes: ['name'] },
          ],
          order: [['approved_at', 'DESC']],
        })
      : null
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
      completed_at: doc.completed_at ? new Date(doc.completed_at).toISOString() : null,
    },
    completed: approval ? { approved_by: userSummary(approval.staff), office_name: (approval.office?.name as string | undefined) ?? null } : doc.status === 'COMPLETED' ? { approved_by: null, office_name: null } : null,
    // Carried documents travel from the current office to the next; otherwise they are at the current one.
    from_office: lite(current) ?? { id: '', code: '', name: here, department_name: '' },
    to_office: lite(next?.office),
    messenger: AT_OFFICE.includes(doc.status) || carrying ? person(visit?.liaison_id) : null,
    received_by: AT_OFFICE.includes(doc.status) ? person(visit?.handler_id) : null,
    // Passed to the next staff of the office, not received at the next desk yet.
    passed_by: person(pass?.by),
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
    const sentBack = sendBackTarget(visit)
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
      meta: {
        from_office_id: visit.office_id,
        received_by: actor.id,
        by_hand: !liaisonId,
        delivery_minutes: minutes == null ? null : Math.round(minutes * 10) / 10,
        ...(sentBack && { sent_back: true, issue_id: sentBack.issueId }),
      },
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
    appendLog(visit, { type: 'DELIVERY_FAILED', by: actor.id, status: back, remarks, meta: { send_back_to: null } })
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
 * admin included, unless they belong to that office.
 */
function canDecideHere(doc: Row, actor: Actor) {
  return isOfficeStaff(actor) && Boolean(actor.office_id) && actor.office_id === doc.current_office_id && AT_OFFICE.includes(doc.status)
}

/** Documents waiting for a decision at this user's office, where it is the last office on their route. */
export async function pendingApprovalsFor(actor: Actor) {
  // A delegated Department Head without "Approve or return" has nothing to decide.
  if (!isOfficeStaff(actor) || !actor.office_id || !hasPermission(actor, 'DECIDE_APPROVALS')) return []
  const docs = await Document.findAll({
    where: {
      org_id: actor.org_id,
      current_office_id: actor.office_id,
      status: { [Op.in]: AT_OFFICE },
      [Op.and]: [
        sequelize.literal(`(${AT_LAST_STEP_SQL})`),
        sequelize.literal(`${currentVisit('handler_id')} IS NOT NULL`),
        // Not while it is with one of the office's umbrella units (see atUnit): the step's office decides.
        sequelize.literal(`${currentVisit('office_id')} = documents.current_office_id`),
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
  if (!hasPermission(actor, 'DECIDE_APPROVALS') || atUnit(doc, visit) || !canDecideHere(doc, actor) || !visit?.handler_id || !(await atLastStep(doc))) return null
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
  requirePermission(actor, 'DECIDE_APPROVALS')
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
    assertNotAtUnit(doc, visit, 'decide on it')

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
  return (await documentHistory(doc)).tracking
}

/** The flat timeline plus the office-by-office routing breakdown, from one read of the visits. */
export async function documentHistory(doc: Row) {
  // Ordered in code: older rows have whole-second created_at, so ties are settled by event times.
  const visits = sortVisits(
    await DocumentTracking.findAll({
      where: { document_id: doc.id },
      include: [{ model: Office, as: 'office', attributes: ['id', 'code', 'name'] }],
      order: [['created_at', 'ASC']],
    }),
  )
  const [users, offices] = await Promise.all([
    User.findAll({
      where: { id: { [Op.in]: referencedUserIds(doc, visits) } },
      attributes: ['id', 'first_name', 'last_name', 'full_name', 'email', 'account_type'],
    }),
    Office.findAll({ where: { id: { [Op.in]: referencedOfficeIds(visits) } }, attributes: ['id', 'code', 'name'] }),
  ])
  const userMap = new Map(users.map((u) => [u.id, u]))
  return {
    tracking: timelineEvents(doc, visits, userMap),
    routing: routingVisits(visits, userMap, new Map(offices.map((o) => [o.id, o]))),
  }
}

export interface ActionContext {
  received: boolean
  /** Who scanned it in at the current visit (at an office, the only one who may release it). */
  handlerId: string | null
  visitLiaisonId: string | null
  isFinalStep: boolean
  /** Office of the step after the current one (where a carried document is heading). */
  nextOfficeId: string | null
  /** Who passed it to the next staff of the office, while nobody has received it at the next desk. */
  passedBy: string | null
  /** With one of its office's umbrella units (see atUnit). */
  atUnit?: boolean
  /** Active umbrella offices of the office it is at (hand-off targets). */
  umbrellaCount?: number
  /** Following one of its office's internal routes right now. */
  internalActive?: boolean
  /** Active internal routes of the office it is at (ones it could start). */
  internalRouteCount?: number
  /** Flagged and being sent back (claimed or not yet). */
  sendingBack?: boolean
  /** Sent back and waiting for a liaison to claim it. */
  returnOpen?: boolean
  /** The viewing liaison belongs to the office it goes back to (or one of its umbrella offices). */
  returnEligible?: boolean
  pendingApproval: Row | null
}

/** Which buttons the current user should see for this document. Mirrors the command checks above. */
export function availableActions(doc: Row, actor: Actor, ctx: ActionContext) {
  const atOffice = AT_OFFICE.includes(doc.status)
  const moving = CARRYING.includes(doc.status)
  const officeStaff = isOfficeStaff(actor) && Boolean(actor.office_id)
  const atOrigin = doc.current_step_number === 0
  // Office staff where it is, or (at the origin) the uploader / admin too.
  const holds = holdsDocument(doc, actor)
  // At an office only the receiver releases; at the origin, whoever holds it there.
  const releases = holds && (atOrigin || ctx.handlerId === actor.id)
  const isLiaison = actor.account_type === 'LIAISON'
  const carrying = moving && ctx.visitLiaisonId === actor.id
  const nextOfficeStaff = officeStaff && actor.office_id === ctx.nextOfficeId

  const may = (p: Parameters<typeof hasPermission>[1]) => hasPermission(actor, p)
  return {
    canEdit: canManageDocument(doc, actor) && doc.status === 'CREATED',
    canSubmit: canManageDocument(doc, actor) && doc.status === 'CREATED' && may('UPLOAD_DOCUMENTS'),
    canResubmit: canManageDocument(doc, actor) && doc.status === 'RETURNED' && may('UPLOAD_DOCUMENTS'),
    // Receiving always takes a scan of the QR label (scanner page). At the origin with no
    // messenger assigned, the first office can also receive it when it is brought by hand.
    canScanReceive:
      may('RECEIVE_DOCUMENTS') &&
      ((holds && !atOrigin && atOffice && !ctx.received && ctx.passedBy !== actor.id) ||
      (nextOfficeStaff && moving) ||
      (nextOfficeStaff && atOrigin && atOffice && !ctx.visitLiaisonId)),
    canRequestPickup: may('RELEASE_DOCUMENTS') && !ctx.atUnit && !ctx.sendingBack && releases && atOffice && ctx.received && !ctx.visitLiaisonId && !ctx.isFinalStep && Boolean(ctx.nextOfficeId),
    // Desk to desk inside the office, before it is released (or decided, at the last office).
    canPassToStaff: may('PASS_DOCUMENTS') && releases && !atOrigin && atOffice && ctx.received && !ctx.visitLiaisonId && !ctx.returnOpen,
    // Flag an issue and send it back to the previous office, with one of this office's messengers.
    canSendBack: may('SEND_BACK_DOCUMENTS') && !ctx.atUnit && !ctx.sendingBack && releases && !atOrigin && atOffice && ctx.received && !ctx.visitLiaisonId,
    canTakeBackPass: may('PASS_DOCUMENTS') && atOffice && Boolean(ctx.passedBy) && ctx.passedBy === actor.id,
    // Until the messenger has picked it up, another one can take over.
    canReassign: may('RELEASE_DOCUMENTS') && releases && atOffice && Boolean(ctx.visitLiaisonId) && !ctx.sendingBack,
    canCancelPickup: may('RELEASE_DOCUMENTS') && releases && atOffice && (Boolean(ctx.visitLiaisonId) || Boolean(ctx.returnOpen)),
    // A flagged document going back: the liaisons of that office claim the pickup (and may give it up before picking it up).
    canClaimReturn: isLiaison && atOffice && Boolean(ctx.returnOpen) && Boolean(ctx.returnEligible),
    canReleaseReturnClaim: isLiaison && atOffice && Boolean(ctx.sendingBack) && ctx.visitLiaisonId === actor.id,
    canPickup: isLiaison && atOffice && ctx.visitLiaisonId === actor.id,
    canStartTransit: isLiaison && carrying && doc.status === 'PICKED_UP',
    canReportFailure: isLiaison && carrying,
    // Only the last office on the route, once received there — see canDecideHere / myPendingApproval.
    canApprove: may('DECIDE_APPROVALS') && !ctx.atUnit && Boolean(ctx.pendingApproval) && canDecideHere(doc, actor),
    // Umbrella offices: the office's receiver hands it to a unit; the unit's receiver returns it.
    canHandToUmbrella: may('UMBRELLA_HANDOFF') && !ctx.atUnit && !ctx.internalActive && !ctx.returnOpen && releases && !atOrigin && atOffice && ctx.received && !ctx.visitLiaisonId && !ctx.passedBy && (ctx.umbrellaCount ?? 0) > 0,
    // Internal routes: the office's receiver starts one; each unit's receiver passes it on (or back, at the end).
    canStartInternalRoute: may('UMBRELLA_HANDOFF') && !ctx.atUnit && !ctx.internalActive && !ctx.returnOpen && releases && !atOrigin && atOffice && ctx.received && !ctx.visitLiaisonId && !ctx.passedBy && (ctx.internalRouteCount ?? 0) > 0,
    canAdvanceInternalRoute: may('UMBRELLA_HANDOFF') && Boolean(ctx.atUnit) && Boolean(ctx.internalActive) && releases && atOffice && ctx.received && !ctx.passedBy,
    canReturnFromUmbrella: may('UMBRELLA_HANDOFF') && Boolean(ctx.atUnit) && releases && atOffice && ctx.received && !ctx.passedBy,
  }
}

/** The document's QR label: its permanent routing code, rendered for screen and print. */
export async function renderDocumentQr(documentId: string) {
  const qr = await QrCode.findOne({ where: { document_id: documentId } })
  if (!qr) return null
  // A completed document's label is retired: scanning it only says the document is complete.
  const doc = await Document.findByPk(documentId, { attributes: ['status'] })
  const status = doc?.status === 'COMPLETED' ? 'COMPLETED' : 'ACTIVE'
  return { id: qr.id, payload: qr.qr_code_data, status, created_at: new Date(qr.created_at).toISOString(), ...(await renderQr(qr.qr_code_data)) }
}

/** The routing code on a document's QR label (for scripts and tests). */
export async function routingCodeOf(documentId: string) {
  const qr = await QrCode.findOne({ where: { document_id: documentId }, attributes: ['qr_code_data'] })
  if (!qr) throw notFound('QR code')
  return qr.qr_code_data as string
}
