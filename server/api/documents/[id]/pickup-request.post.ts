import { requestPickup, SUBMITTER_TYPES } from '~~/server/lib/documents.ts'
import { loadDocumentDto } from '~~/server/lib/document-queries.ts'
import * as v from '~~/server/lib/validate.ts'

/**
 * Assign the free messenger who carries the document to the next office: from its origin (the
 * uploader or CLIENT administrator assigns), or from an office once received there (its staff
 * assign). Calling it again before pickup reassigns. The messenger and the next office are notified.
 */
export default defineApiHandler(async (event) => {
  const user = await requireUser(event, ...SUBMITTER_TYPES)
  const body = await readJson(event)
  const { doc, reassigned } = await requestPickup(routeParam(event, 'id'), user, {
    liaisonUserId: v.reqStr(body, 'liaison_user_id', { max: 36, label: 'Messenger' }),
    remarks: v.str(body, 'remarks', { max: 2000 }),
  })
  setResponseStatus(event, reassigned ? 200 : 201)
  return { document: await loadDocumentDto(doc.id), reassigned }
})
