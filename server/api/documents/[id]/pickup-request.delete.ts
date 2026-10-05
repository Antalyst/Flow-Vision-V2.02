import { cancelPickup, SUBMITTER_TYPES } from '~~/server/lib/documents.ts'
import { loadDocumentDto } from '~~/server/lib/document-queries.ts'

export default defineApiHandler(async (event) => {
  const user = await requireUser(event, ...SUBMITTER_TYPES)
  const doc = await cancelPickup(routeParam(event, 'id'), user)
  return { document: await loadDocumentDto(doc.id) }
})
