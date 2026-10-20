import { previewCharterServices } from '~~/server/lib/charter-types.ts'
import { requirePage } from '~~/server/lib/team.ts'

/** The services listed in a Citizen's Charter file, each with the office it most likely belongs to (ADMIN only). Nothing is saved. */
export default defineApiHandler(async (event) => {
  const user = await requireUser(event, 'ADMIN')
  requirePage(user, '/client/settings')
  return previewCharterServices(user.org_id, (await readJson(event)).file_id)
})
