import { activeDocumentTypes, documentTypeDto, typeOfficeIds } from '~~/server/lib/knowledge.ts'

/**
 * The active document types an account may upload with: Global types plus its own office's (and,
 * for an umbrella office, the office above it). The ADMIN, who has no office, gets all of them.
 */
export default defineApiHandler(async (event) => {
  const user = await requireUser(event)
  const offices = user.account_type === 'ADMIN' ? null : ((await typeOfficeIds(user.office_id)) ?? [])
  return { data: (await activeDocumentTypes(user.org_id, offices)).map((t) => documentTypeDto(t)) }
})
