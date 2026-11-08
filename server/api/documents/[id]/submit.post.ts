import { routingFrom, submitDocument, SUBMITTER_TYPES } from '~~/server/lib/documents.ts'
import { loadDocumentFor } from '~~/server/lib/qr-access.ts'

/**
 * Draft → START, or RETURNED → START (resubmit). Optional: routing_mode (GLOBAL | INTERNAL) with route_id (another
 * Document Route) or internal_route_id (an internal process of the uploader's own office); omitted = its current route.
 */
export default defineApiHandler(async (event) => {
  const user = await requireUser(event, ...SUBMITTER_TYPES)
  const body = await readJson(event)
  const doc = await submitDocument(routeParam(event, 'id'), user, requestMeta(event), routingFrom(body))
  return { document: await loadDocumentFor(doc.id, user) }
})
