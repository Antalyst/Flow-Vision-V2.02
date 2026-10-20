import { DocumentType } from '~~/server/lib/models.ts'
import { suggestProcessingTime } from '~~/server/lib/charter-types.ts'
import { notFound } from '~~/server/lib/errors.ts'
import { requirePage } from '~~/server/lib/team.ts'

/** A processing time for this document type, read from the Citizen's Charter (ADMIN only). Nothing is saved: the ADMIN accepts or edits it. */
export default defineApiHandler(async (event) => {
  const user = await requireUser(event, 'ADMIN')
  requirePage(user, '/client/settings')
  const type = await DocumentType.findOne({ where: { id: routeParam(event, 'id'), org_id: user.org_id } })
  if (!type) throw notFound('Document type')
  return { suggestion: await suggestProcessingTime(user.org_id, type) }
})
