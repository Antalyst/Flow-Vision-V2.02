import { Op } from 'sequelize'
import { openableWhere } from '~~/server/lib/document-queries.ts'
import { Document } from '~~/server/lib/models.ts'
import { renderDocumentQr } from '~~/server/lib/documents.ts'
import { notFound } from '~~/server/lib/errors.ts'

/** The document’s QR label (for re-printing it). */
export default defineApiHandler(async (event) => {
  const user = await requireUser(event)
  const documentId = routeParam(event, 'documentId')
  if (!(await Document.count({ where: { id: documentId, org_id: user.org_id, [Op.and]: [openableWhere(user)] } }))) throw notFound('Document')
  const qr = await renderDocumentQr(documentId)
  if (!qr) throw notFound('QR code')
  return { qr }
})
  