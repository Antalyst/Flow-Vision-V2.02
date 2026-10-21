import fs from 'node:fs'
import path from 'node:path'
import { requirePage } from '~~/server/lib/team.ts'
import { httpError, notFound } from '~~/server/lib/errors.ts'
import { audit } from '~~/server/lib/audit.ts'
import { NAME_RE } from '~~/server/lib/backup/config.ts'
import { packagePath, readSidecar } from '~~/server/lib/backup/full.ts'
import { requireBackups } from '~~/server/lib/backup/service.ts'

/** Download a verified backup package (ADMIN), streamed from disk. */
export default defineApiHandler(async (event) => {
  const user = await requireUser(event, 'ADMIN')
  requirePage(user, '/client/backups')
  const cfg = await requireBackups()
  const name = routeParam(event, 'name')
  const file = NAME_RE.test(name) ? packagePath(cfg, name) : null
  const sidecar = file ? await readSidecar(cfg, name) : null
  if (!file || !sidecar) throw notFound('Backup')
  if (sidecar.status === 'FAILED') throw httpError(409, 'This backup failed verification and cannot be downloaded', 'BACKUP_NOT_VERIFIED')
  const size = fs.statSync(file).size
  await audit(requestMeta(event), { action: 'BACKUP_DOWNLOAD', entityType: 'backup', entityId: sidecar.backup_id, after: { name } })
  setResponseHeaders(event, {
    'Content-Type': file.endsWith('.fvenc') ? 'application/octet-stream' : 'application/zip',
    'Content-Disposition': `attachment; filename="${path.basename(file)}"`,
    'Content-Length': String(size),
    'Cache-Control': 'private, no-store',
    'X-Content-Type-Options': 'nosniff',
  })
  return sendStream(event, fs.createReadStream(file))
})
