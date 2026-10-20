import { Op } from 'sequelize'
import { documentAttributes, documentIncludes, openableWhere } from '~~/server/lib/document-queries.ts'
import { Document } from '~~/server/lib/models.ts'
import { renderDocumentQr } from '~~/server/lib/documents.ts'
import { getRouteWithSteps } from '~~/server/lib/routes.ts'
import { documentDtoOne, routeDto } from '~~/server/lib/serializers.ts'
import { assertQrAccess, routingSlipOf } from '~~/server/lib/qr-access.ts'
import { notFound } from '~~/server/lib/errors.ts'

/**
 * The document’s QR label and routing-slip table (for printing it again). Only for whoever may see its QR
 * now (qr-access.ts): opening the document is not enough — e.g. not while it is on its way to your office,
 * nor for a sibling umbrella office while another unit has it.
 */
export default defineApiHandler(async (event) => {
  const user = await requireUser(event)
  const documentId = routeParam(event, 'documentId')
  const doc = await Document.findOne({ where: { id: documentId, org_id: user.org_id, [Op.and]: [openableWhere(user)] }, attributes: documentAttributes, include: documentIncludes })
  if (!doc) throw notFound('Document')
  await assertQrAccess(user, documentId)
  const qr = await renderDocumentQr(documentId)
  if (!qr) throw notFound('QR code')
  const [dto, route] = await Promise.all([documentDtoOne(doc), getRouteWithSteps(doc.route_id)])
  return { qr, routing_slip: routingSlipOf(dto, routeDto(route)) }
})
