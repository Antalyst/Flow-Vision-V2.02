import { regenerateQr, renderDocumentQr, SUBMITTER_TYPES } from '~~/server/lib/documents.ts'

/** Replace a lost or damaged QR label with a new code; the previous label stops working. */
export default defineApiHandler(async (event) => {
  const user = await requireUser(event, ...SUBMITTER_TYPES)
  const { doc } = await regenerateQr(routeParam(event, 'documentId'), user)
  setResponseStatus(event, 201)
  return { qr: await renderDocumentQr(doc.id) }
})
