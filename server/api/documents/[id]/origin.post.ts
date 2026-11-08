import { recordOrigin } from '~~/server/lib/documents.ts'
import * as v from '~~/server/lib/validate.ts'
import { loadDocumentFor } from '~~/server/lib/qr-access.ts'

/** Record the origin of an older document whose origin wasn't recorded (ADMIN, once): { office_id, reason }. */
export default defineApiHandler(async (event) => {
  const user = await requireUser(event, 'ADMIN')
  const body = await readJson(event)
  const officeId = v.reqStr(body, 'office_id', { max: 36, label: 'Office' })
  const reason = v.reqStr(body, 'reason', { max: 500, label: 'Reason' })
  const doc = await recordOrigin(routeParam(event, 'id'), user, { officeId, reason }, requestMeta(event))
  return { document: await loadDocumentFor(doc.id, user) }
})
