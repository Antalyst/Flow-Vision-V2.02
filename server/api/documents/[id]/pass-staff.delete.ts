import { OFFICE_STAFF_TYPES, takeBackPass } from '~~/server/lib/documents.ts'
import { loadDocumentDto } from '~~/server/lib/document-queries.ts'

/** Take back a document passed to the next staff, before anyone there scans it in. */
export default defineApiHandler(async (event) => {
  const user = await requireUser(event, ...OFFICE_STAFF_TYPES)
  const doc = await takeBackPass(routeParam(event, 'id'), user)
  return { document: await loadDocumentDto(doc.id) }
})
