import { requirePage } from '~~/server/lib/team.ts'
import { notFound } from '~~/server/lib/errors.ts'
import { audit } from '~~/server/lib/audit.ts'
import { NAME_RE } from '~~/server/lib/backup/config.ts'
import { packagePath, readSidecar, verifyStored } from '~~/server/lib/backup/full.ts'
import { requireBackups } from '~~/server/lib/backup/service.ts'

/** Re-verify a backup in the backup folder (ADMIN). The name is checked against the naming pattern; no paths. */
export default defineApiHandler(async (event) => {
  const user = await requireUser(event, 'ADMIN')
  requirePage(user, '/client/backups')
  const cfg = await requireBackups()
  const name = routeParam(event, 'name')
  if (!NAME_RE.test(name) || !packagePath(cfg, name)) throw notFound('Backup')
  const result = await verifyStored(cfg, name)
  const sidecar = await readSidecar(cfg, name)
  if (sidecar) await audit(requestMeta(event), { action: 'BACKUP_VERIFY', entityType: 'backup', entityId: sidecar.backup_id, after: { name, ok: result.ok, deep: result.deep } })
  return { ok: result.ok, deep: result.deep, errors: result.errors, warnings: result.warnings }
})
