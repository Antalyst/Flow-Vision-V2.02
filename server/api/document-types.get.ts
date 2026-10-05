import { activeDocumentTypes, documentTypeDto } from '~~/server/lib/knowledge.ts'

/** The organization's active document types, for the upload form (any signed-in account). */
export default defineApiHandler(async (event) => {
  const user = await requireUser(event)
  return { data: (await activeDocumentTypes(user.org_id)).map((t) => documentTypeDto(t)) }
})
