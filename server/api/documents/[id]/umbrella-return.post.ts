import { OFFICE_STAFF_TYPES, returnFromUmbrella } from '~~/server/lib/documents.ts'
import * as v from '~~/server/lib/validate.ts'
import { loadDocumentFor } from '~~/server/lib/qr-access.ts'

/** Return a document from an umbrella office to its office, which scans it in again: { remarks }. */
export default defineApiHandler(async (event) => {
  const user = await requireOfficeUser(event, ...OFFICE_STAFF_TYPES)
  const body = await readJson(event)
  const doc = await returnFromUmbrella(routeParam(event, 'id'), user, { remarks: v.str(body, 'remarks', { max: 2000 }) }, requestMeta(event))
  return { document: await loadDocumentFor(doc.id, user) }
})
