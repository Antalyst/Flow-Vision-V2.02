import { OFFICE_STAFF_TYPES, passToNextStaff } from '~~/server/lib/documents.ts'
import { loadDocumentDto } from '~~/server/lib/document-queries.ts'
import * as v from '~~/server/lib/validate.ts'

/**
 * Pass the document desk to desk inside the office: the staff member who received it hands it to
 * the next staff. Until another staff member of the office scans it in, nobody can release it to a
 * messenger. The office is notified.
 */
export default defineApiHandler(async (event) => {
  const user = await requireUser(event, ...OFFICE_STAFF_TYPES)
  const body = await readJson(event)
  const doc = await passToNextStaff(routeParam(event, 'id'), user, { remarks: v.str(body, 'remarks', { max: 2000 }) })
  return { document: await loadDocumentDto(doc.id) }
})
