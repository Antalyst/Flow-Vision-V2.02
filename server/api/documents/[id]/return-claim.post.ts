import { claimReturnPickup } from '~~/server/lib/documents.ts'
import { loadDocumentFor } from '~~/server/lib/qr-access.ts'

/** A liaison of the office a flagged document goes back to claims its return pickup (one claim wins). */
export default defineApiHandler(async (event) => {
  const user = await requireUser(event, 'LIAISON')
  const doc = await claimReturnPickup(routeParam(event, 'id'), user)
  return { document: await loadDocumentFor(doc.id, user) }
})
