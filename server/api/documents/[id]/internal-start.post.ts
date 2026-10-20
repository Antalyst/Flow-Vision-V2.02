import { OFFICE_STAFF_TYPES, startInternalRoute } from '~~/server/lib/documents.ts'
import * as v from '~~/server/lib/validate.ts'
import { loadDocumentFor } from '~~/server/lib/qr-access.ts'

/**
 * Send a received document along one of the office's internal routes: { route_id, remarks }.
 * It stays on its organization route step; the first unit scans it in.
 */
export default defineApiHandler(async (event) => {
  const user = await requireOfficeUser(event, ...OFFICE_STAFF_TYPES)
  const body = await readJson(event)
  const doc = await startInternalRoute(
    routeParam(event, 'id'),
    user,
    { routeId: v.reqStr(body, 'route_id', { max: 36, label: 'Internal route' }), remarks: v.str(body, 'remarks', { max: 2000 }) },
    requestMeta(event),
  )
  return { document: await loadDocumentFor(doc.id, user) }
})
