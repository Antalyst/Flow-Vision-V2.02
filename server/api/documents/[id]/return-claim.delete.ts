import { releaseReturnClaim } from '~~/server/lib/documents.ts'
import { loadDocumentFor } from '~~/server/lib/qr-access.ts'

/** The liaison who claimed a return pickup gives it up before picking it up: it is open again. */
export default defineApiHandler(async (event) => {
  const user = await requireUser(event, 'LIAISON')
  const doc = await releaseReturnClaim(routeParam(event, 'id'), user)
  return { document: await loadDocumentFor(doc.id, user) }
})
