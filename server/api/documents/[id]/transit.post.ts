import { startTransit } from '~~/server/lib/documents.ts'
import { loadDocumentFor } from '~~/server/lib/qr-access.ts'

export default defineApiHandler(async (event) => {
  const user = await requireUser(event, 'LIAISON')
  const doc = await startTransit(routeParam(event, 'id'), user)
  return { document: await loadDocumentFor(doc.id, user) }
})
