import { cancelPickup, SUBMITTER_TYPES } from '~~/server/lib/documents.ts'
import { loadDocumentFor } from '~~/server/lib/qr-access.ts'

export default defineApiHandler(async (event) => {
  const user = await requireUser(event, ...SUBMITTER_TYPES)
  const doc = await cancelPickup(routeParam(event, 'id'), user)
  return { document: await loadDocumentFor(doc.id, user) }
})
