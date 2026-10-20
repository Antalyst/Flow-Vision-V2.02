import { decideApproval, OFFICE_STAFF_TYPES } from '~~/server/lib/documents.ts'
import { approvalDto } from '~~/server/lib/serializers.ts'
import * as v from '~~/server/lib/validate.ts'
import { loadDocumentFor } from '~~/server/lib/qr-access.ts'

/**
 * decision: APPROVED (→ COMPLETED) or RETURNED (→ RETURNED, remarks required).
 * Department heads and staff may call it; decideApproval only lets the last office on the document's route decide.
 */
export default defineApiHandler(async (event) => {
  const user = await requireOfficeUser(event, ...OFFICE_STAFF_TYPES)
  const body = await readJson(event)
  const decision = v.oneOf(body, 'decision', ['APPROVED', 'RETURNED'] as const, { required: true })!
  const { approval, doc } = await decideApproval(routeParam(event, 'id'), user, { decision, remarks: v.str(body, 'remarks', { max: 2000 }) }, requestMeta(event))
  return { approval: approvalDto(approval), document: await loadDocumentFor(doc.id, user) }
})
