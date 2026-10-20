import { importCharterServices } from '~~/server/lib/charter-types.ts'
import { audit } from '~~/server/lib/audit.ts'
import { requirePage } from '~~/server/lib/team.ts'

/**
 * Import ticked services as document types (ADMIN only):
 * { file_id, rows: [{ name, category, office_id (null = Global), page }], switch_off_defaults }.
 * Existing types (same name, same office) are skipped. Processing times stay unset until the ADMIN sets them.
 */
export default defineApiHandler(async (event) => {
  const user = await requireUser(event, 'ADMIN')
  requirePage(user, '/client/settings')
  const body = await readJson(event)
  const result = await importCharterServices(user.org_id, user.id, body)
  await audit(requestMeta(event), { action: 'DOCUMENT_TYPE_IMPORT', entityType: 'knowledge_file', entityId: String(body.file_id), after: result })
  return result
})
