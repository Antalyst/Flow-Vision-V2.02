import { Op } from 'sequelize'
import { Approval, Document, DocumentInternalTransaction, InternalRoute, Office, User } from '~~/server/lib/models.ts'
import { availableActions, documentHistory, getCurrentVisit, internalSteps, myPendingApproval, renderDocumentQr, atUnit } from '~~/server/lib/documents.ts'
import { documentAttributes, documentIncludes, openableWhere, userAttrs } from '~~/server/lib/document-queries.ts'
import { hasQrAccess, routingSlipOf } from '~~/server/lib/qr-access.ts'
import { getRouteWithSteps } from '~~/server/lib/routes.ts'
import { AT_OFFICE, approvalDto, documentDtoOne, routeDto } from '~~/server/lib/serializers.ts'
import { notFound } from '~~/server/lib/errors.ts'
import { documentFileList } from '~~/server/lib/document-files.ts'
import { pendingPass, sendBackTarget } from '~~/server/lib/tracking-log.ts'

export default defineApiHandler(async (event) => {
  const user = await requireUser(event)
  const doc = await Document.findOne({
    where: { id: routeParam(event, 'id'), org_id: user.org_id, [Op.and]: [openableWhere(user)] },
    attributes: documentAttributes,
    include: documentIncludes,
  })
  if (!doc) throw notFound('Document')

  const [route, history, approvals, qr, visit, files] = await Promise.all([
    getRouteWithSteps(doc.route_id),
    documentHistory(doc),
    Approval.findAll({
      where: { document_id: doc.id },
      include: [
        { model: User, as: 'staff', attributes: userAttrs },
        { model: Office, as: 'office', attributes: ['id', 'code', 'name'] },
      ],
      order: [['updated_at', 'DESC']],
    }),
    renderDocumentQr(doc.id),
    doc.status === 'CREATED' ? null : getCurrentVisit(doc),
    documentFileList(doc),
  ])

  const steps: any[] = route?.steps ?? []
  const currentStep = steps.find((s) => s.step_number === doc.current_step_number)
  const nextStep = steps.find((s) => s.step_number === doc.current_step_number + 1)
  // The last office on the route: marked final checkpoint, or simply nothing after it.
  const isFinalStep = Boolean(currentStep) && (Boolean(currentStep.is_final_checkpoint) || !nextStep)
  const pending = await myPendingApproval(doc, user, visit)
  // Umbrella offices: where it can be handed off (units of the office it is at), and whether a unit has it.
  const withUnit = atUnit(doc, visit)
  const umbrellaOptions =
    !withUnit && doc.current_office_id && user.office_id === doc.current_office_id
      ? await Office.findAll({ where: { org_id: user.org_id, parent_office_id: doc.current_office_id, status: 'active' }, attributes: ['id', 'name', 'code'], order: [['name', 'ASC']] })
      : []
  // Internal routes: every one this document followed (newest first), and the office's routes it could start.
  const internalRuns = await DocumentInternalTransaction.findAll({ where: { document_id: doc.id }, order: [['started_at', 'DESC']] })
  const internalActive = internalRuns.find((t) => t.status === 'ACTIVE') ?? null
  const internalOptions =
    !withUnit && !internalActive && doc.current_office_id && user.office_id === doc.current_office_id
      ? await InternalRoute.findAll({ where: { org_id: user.org_id, office_id: doc.current_office_id, is_active: true }, attributes: ['id', 'name', 'description'], order: [['name', 'ASC']] })
      : []
  // Flagged and going back one office: its liaisons (that office and its umbrella offices) claim the pickup.
  const back = AT_OFFICE.includes(doc.status) ? sendBackTarget(visit) : null
  const returnOpen = Boolean(back && !visit?.liaison_id)
  const returnEligible = Boolean(back) && user.account_type === 'LIAISON' && Boolean(user.office_id) && (user.office_id === back!.officeId || user.office?.parent_office_id === back!.officeId)
  const permissions = availableActions(doc, user, {
    sendingBack: Boolean(back),
    returnOpen,
    returnEligible,
    atUnit: withUnit,
    umbrellaCount: umbrellaOptions.length,
    internalActive: Boolean(internalActive),
    internalRouteCount: internalOptions.length,
    received: Boolean(visit?.handler_id),
    handlerId: visit?.handler_id ?? null,
    visitLiaisonId: visit?.liaison_id ?? null,
    isFinalStep,
    // A send-back is carried to the previous office instead of the next one.
    nextOfficeId: sendBackTarget(visit)?.officeId ?? nextStep?.office_id ?? null,
    passedBy: (pendingPass(visit)?.by as string | null | undefined) ?? null,
    pendingApproval: pending,
  })

  // Decided rows, plus one "pending" entry (each staff member has their own PENDING row).
  const decided = approvals.filter((a) => a.status !== 'PENDING')
  const anyPending = approvals.find((a) => a.status === 'PENDING')

  // The QR code (and so its image, printing and the routing slip) only for whoever has the document now,
  // once it has been received there (qr-access.ts). Nothing of it is sent otherwise.
  const seesQr = await hasQrAccess(user, doc.id as string)
  const document = await documentDtoOne(doc)
  if (!seesQr && document.qr_code) Object.assign(document, { qr_code: null, qr_hidden: true })

  return {
    document,
    route: route ? routeDto(route) : null,
    tracking: history.tracking,
    // Office by office: what happened inside each office up to the hand-over to the next.
    routing: history.routing,
    approvals: [...(anyPending ? [approvalDto(anyPending)] : []), ...decided.map((a) => approvalDto(a))],
    pending_approval: pending ? approvalDto(pending) : null,
    active_qr: seesQr ? qr : null,
    // The table printed under the QR on the routing slip (only with the QR itself).
    routing_slip: seesQr && qr ? routingSlipOf(document, routeDto(route)) : null,
    // Every file of the document (several for a bulk upload, all under the one QR).
    files,
    permissions,
    umbrella_options: permissions.canHandToUmbrella ? umbrellaOptions.map((o) => ({ id: o.id as string, name: o.name as string, code: o.code as string })) : [],
    // Set while one of the office's umbrella units has it: the office of the route step.
    unit_parent: withUnit && visit ? { id: visit.office_id as string } : null,
    internal_route_options: permissions.canStartInternalRoute ? internalOptions.map((r) => ({ id: r.id as string, name: r.name as string, description: (r.description as string | null) ?? null })) : [],
    // Internal routes this document followed. Their moves are inside the office's route step: they are not
    // route checkpoints (route progress never changes because of them).
    internal_routes: internalRuns.map((t) => {
      const steps = internalSteps(t)
      return {
        id: t.id as string,
        route_id: (t.internal_route_id as string | null) ?? null,
        route_name: t.route_name as string,
        status: t.status as 'ACTIVE' | 'COMPLETED' | 'CANCELLED',
        parent_office_id: t.parent_office_id as string,
        route_step_number: t.route_step_number as number,
        current_index: t.current_index as number,
        steps: steps.map((st, i) => ({
          ...st,
          state: t.status === 'ACTIVE' ? (i < t.current_index ? 'DONE' : i === t.current_index ? 'CURRENT' : 'PENDING') : t.status === 'COMPLETED' || i < t.current_index ? 'DONE' : i === t.current_index ? 'ENDED' : 'SKIPPED',
        })),
        started_by: (t.started_by as string | null) ?? null,
        started_at: new Date(t.started_at).toISOString(),
        ended_at: t.ended_at ? new Date(t.ended_at).toISOString() : null,
      }
    }),
  }
})
