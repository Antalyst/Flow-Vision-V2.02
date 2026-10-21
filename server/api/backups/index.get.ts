import { requirePage } from '~~/server/lib/team.ts'
import { overview } from '~~/server/lib/backup/service.ts'

/** Backups page (ADMIN): whether backups are available here, the destinations, the running job and the backups made. */
export default defineApiHandler(async (event) => {
  const user = await requireUser(event, 'ADMIN')
  requirePage(user, '/client/backups')
  return overview()
})
