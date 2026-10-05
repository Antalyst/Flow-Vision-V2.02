import { failDelivery } from '~~/server/lib/documents.ts'
import { loadDocumentDto } from '~~/server/lib/document-queries.ts'
import * as v from '~~/server/lib/validate.ts'

export default defineApiHandler(async (event) => {
  const user = await requireUser(event, 'LIAISON')
  const body = await readJson(event)
  const doc = await failDelivery(routeParam(event, 'id'), user, { remarks: v.str(body, 'remarks', { max: 2000 }) })
  return { document: await loadDocumentDto(doc.id) }
})
