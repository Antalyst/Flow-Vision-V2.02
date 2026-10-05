import { submitDocument, SUBMITTER_TYPES } from '~~/server/lib/documents.ts'
import { loadDocumentDto } from '~~/server/lib/document-queries.ts'
import * as v from '~~/server/lib/validate.ts'

/** Draft → START, or RETURNED → START (resubmit). `route_id` (optional) switches the document to another Document Route. */
export default defineApiHandler(async (event) => {
  const user = await requireUser(event, ...SUBMITTER_TYPES)
  const body = await readJson(event)
  const doc = await submitDocument(routeParam(event, 'id'), user, requestMeta(event), v.str(body, 'route_id', { max: 36 }))
  return { document: await loadDocumentDto(doc.id) }
})
