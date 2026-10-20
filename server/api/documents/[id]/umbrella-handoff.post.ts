import { OFFICE_STAFF_TYPES, handToUmbrella } from '~~/server/lib/documents.ts'
import * as v from '~~/server/lib/validate.ts'
import { loadDocumentFor } from '~~/server/lib/qr-access.ts'

/**
 * Hand a received document to one of the office's umbrella offices (units): { umbrella_id, remarks }.
 * It stays on its route step; the unit scans it in and later returns it to the office.
 */
export default defineApiHandler(async (event) => {
  const user = await requireOfficeUser(event, ...OFFICE_STAFF_TYPES)
  const body = await readJson(event)
  const doc = await handToUmbrella(
    routeParam(event, 'id'),
    user,
    { umbrellaId: v.reqStr(body, 'umbrella_id', { max: 36, label: 'Umbrella office' }), remarks: v.str(body, 'remarks', { max: 2000 }) },
    requestMeta(event),
  )
  return { document: await loadDocumentFor(doc.id, user) }
})
