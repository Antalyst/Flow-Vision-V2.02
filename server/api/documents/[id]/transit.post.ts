import { startTransit } from '~~/server/lib/documents.ts'
import { loadDocumentDto } from '~~/server/lib/document-queries.ts'

export default defineApiHandler(async (event) => {
  const user = await requireUser(event, 'LIAISON')
  const doc = await startTransit(routeParam(event, 'id'), user)
  return { document: await loadDocumentDto(doc.id) }
})
