import { OFFICE_STAFF_TYPES, performScan } from '~~/server/lib/documents.ts'
import { loadDocumentDto } from '~~/server/lib/document-queries.ts'
import * as v from '~~/server/lib/validate.ts'

/** A messenger scans to pick up; staff of the office the document reached scan to receive it. */
export default defineApiHandler(async (event) => {
  const user = await requireOfficeUser(event, 'LIAISON', ...OFFICE_STAFF_TYPES)
  const body = await readJson(event)
  const payload = v.reqStr(body, 'payload', { max: 100, label: 'QR code' })
  const action = v.oneOf(body, 'action', ['PICKUP', 'RECEIVE'] as const)
  const result = await performScan(payload, action, user)
  return { action: result.action, document: await loadDocumentDto(result.doc.id) }
})
