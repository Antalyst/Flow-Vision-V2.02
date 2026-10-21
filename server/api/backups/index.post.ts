import { requirePage } from '~~/server/lib/team.ts'
import { startFullBackup } from '~~/server/lib/backup/service.ts'

/** Start a full backup (ADMIN). It runs in the background; poll GET /api/backups for its progress. Takes no parameters. */
export default defineApiHandler(async (event) => {
  const user = await requireUser(event, 'ADMIN')
  requirePage(user, '/client/backups')
  const job = await startFullBackup(user, requestMeta(event))
  setResponseStatus(event, 202)
  return { job }
})
