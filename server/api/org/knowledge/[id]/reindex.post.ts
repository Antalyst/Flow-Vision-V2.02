import { KnowledgeFile, Office } from '~~/server/lib/models.ts'
import { knowledgeDto, reindexKnowledgeFile } from '~~/server/lib/knowledge.ts'
import { audit } from '~~/server/lib/audit.ts'
import { notFound } from '~~/server/lib/errors.ts'
import { requirePage } from '~~/server/lib/team.ts'

/**
 * Re-read a knowledge file from its stored copy (ADMIN only), keeping its lines, headings and
 * pages — for files uploaded before that was done. Nothing has to be uploaded again; the file's
 * office scope, kind and on/off state don't change.
 */
export default defineApiHandler(async (event) => {
  const user = await requireUser(event, 'ADMIN')
  requirePage(user, '/client/settings')
  const file = await KnowledgeFile.findOne({ where: { id: routeParam(event, 'id'), org_id: user.org_id }, attributes: { exclude: ['content'] } })
  if (!file) throw notFound('Knowledge file')
  const before = { status: file.status, char_count: file.char_count, index_version: file.index_version }
  await reindexKnowledgeFile(file)
  await audit(requestMeta(event), {
    action: 'KNOWLEDGE_REINDEX',
    entityType: 'knowledge_file',
    entityId: file.id,
    before,
    after: { status: file.status, char_count: file.char_count, index_version: file.index_version },
  })
  await file.reload({ attributes: { exclude: ['content'] }, include: [{ model: Office, as: 'office', attributes: ['id', 'name'] }] })
  return { knowledge_file: knowledgeDto(file) }
})
