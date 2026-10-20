import { regenerateQr, renderDocumentQr, SUBMITTER_TYPES } from '~~/server/lib/documents.ts'
import { assertQrAccess } from '~~/server/lib/qr-access.ts'

/**
 * Replace a lost or damaged QR label with a new code; the previous label stops working. Only for whoever
 * may see the QR now (qr-access.ts) — the new code is shown to them — and holds the document (documents.ts).
 */
export default defineApiHandler(async (event) => {
  const user = await requireUser(event, ...SUBMITTER_TYPES)
  const documentId = routeParam(event, 'documentId')
  await assertQrAccess(user, documentId)
  const { doc } = await regenerateQr(documentId, user)
  setResponseStatus(event, 201)
  return { qr: await renderDocumentQr(doc.id) }
})
