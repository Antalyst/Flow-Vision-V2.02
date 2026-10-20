import { OFFICE_STAFF_TYPES, advanceInternalRoute } from '~~/server/lib/documents.ts'
import * as v from '~~/server/lib/validate.ts'
import { loadDocumentFor } from '~~/server/lib/qr-access.ts'

/** The unit is done: pass the document to the next unit of its internal route, or back to the office after the last: { remarks }. */
export default defineApiHandler(async (event) => {
  const user = await requireOfficeUser(event, ...OFFICE_STAFF_TYPES)
  const body = await readJson(event)
  const { doc, completed } = await advanceInternalRoute(routeParam(event, 'id'), user, { remarks: v.str(body, 'remarks', { max: 2000 }) }, requestMeta(event))
  return { document: await loadDocumentFor(doc.id, user), completed }
})
