import { KnowledgeFile } from '~~/server/lib/models.ts'
import { removeKnowledgeFile } from '~~/server/lib/knowledge.ts'
import { audit } from '~~/server/lib/audit.ts'
import { notFound } from '~~/server/lib/errors.ts'

/** Delete a knowledge file and its stored copy (CLIENT only). The AI stops using it at once. */
export default defineApiHandler(async (event) => {
  const user = await requireUser(event, 'CLIENT')
  const file = await KnowledgeFile.findOne({ where: { id: routeParam(event, 'id'), org_id: user.org_id }, attributes: ['id', 'title', 'file_url'] })
  if (!file) throw notFound('Knowledge file')
  await file.destroy()
  await removeKnowledgeFile(file.file_url)
  await audit(requestMeta(event), { action: 'KNOWLEDGE_DELETE', entityType: 'knowledge_file', entityId: file.id, before: { title: file.title } })
  return { ok: true }
})
