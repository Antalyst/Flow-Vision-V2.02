import { Op } from 'sequelize'
import { Approval, Document, Office, User } from '~~/server/lib/models.ts'
import { availableActions, documentTimeline, getCurrentVisit, myPendingApproval, renderDocumentQr } from '~~/server/lib/documents.ts'
import { documentAttributes, documentIncludes, openableWhere, userAttrs } from '~~/server/lib/document-queries.ts'
import { getRouteWithSteps } from '~~/server/lib/routes.ts'
import { approvalDto, documentDtoOne, routeDto } from '~~/server/lib/serializers.ts'
import { notFound } from '~~/server/lib/errors.ts'

export default defineApiHandler(async (event) => {
  const user = await requireUser(event)
  const doc = await Document.findOne({
    where: { id: routeParam(event, 'id'), org_id: user.org_id, [Op.and]: [openableWhere(user)] },
    attributes: documentAttributes,
    include: documentIncludes,
  })
  if (!doc) throw notFound('Document')

  const [route, tracking, approvals, qr, visit] = await Promise.all([
    getRouteWithSteps(doc.route_id),
    documentTimeline(doc),
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
  ])

  const steps: any[] = route?.steps ?? []
  const currentStep = steps.find((s) => s.step_number === doc.current_step_number)
  const nextStep = steps.find((s) => s.step_number === doc.current_step_number + 1)
  // The last office on the route: marked final checkpoint, or simply nothing after it.
  const isFinalStep = Boolean(currentStep) && (Boolean(currentStep.is_final_checkpoint) || !nextStep)
  const pending = await myPendingApproval(doc, user, visit)
  const permissions = availableActions(doc, user, {
    received: Boolean(visit?.handler_id),
    visitLiaisonId: visit?.liaison_id ?? null,
    isFinalStep,
    nextOfficeId: nextStep?.office_id ?? null,
    pendingApproval: pending,
  })

  // Decided rows, plus one "pending" entry (each staff member has their own PENDING row).
  const decided = approvals.filter((a) => a.status !== 'PENDING')
  const anyPending = approvals.find((a) => a.status === 'PENDING')

  // The QR label matters to whoever holds or moves the paper: the uploader, the office it is at
  // or heading to, messengers, and the CLIENT administrator.
  const canSeeQr =
    doc.submitted_by === user.id ||
    ['LIAISON', 'CLIENT'].includes(user.account_type) ||
    (Boolean(user.office_id) && [doc.current_office_id, nextStep?.office_id].includes(user.office_id))

  return {
    document: await documentDtoOne(doc),
    route: route ? routeDto(route) : null,
    tracking,
    approvals: [...(anyPending ? [approvalDto(anyPending)] : []), ...decided.map((a) => approvalDto(a))],
    pending_approval: pending ? approvalDto(pending) : null,
    active_qr: canSeeQr ? qr : null,
    permissions,
  }
})
