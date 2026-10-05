import { KnowledgeFile } from '~~/server/lib/models.ts'
import { knowledgeDto } from '~~/server/lib/knowledge.ts'
import { audit } from '~~/server/lib/audit.ts'
import { notFound } from '~~/server/lib/errors.ts'
import * as v from '~~/server/lib/validate.ts'

/** Edit a knowledge file (CLIENT only): `title`, `description`, `is_active` (whether the AI uses it). */
export default defineApiHandler(async (event) => {
  const user = await requireUser(event, 'CLIENT')
  const body = await readJson(event)
  const file = await KnowledgeFile.findOne({ where: { id: routeParam(event, 'id'), org_id: user.org_id }, attributes: { exclude: ['content'] } })
  if (!file) throw notFound('Knowledge file')
  const updates: Record<string, unknown> = {}
  if ('title' in body) updates.title = v.reqStr(body, 'title', { max: 255, label: 'Title' })
  if ('description' in body) updates.description = v.str(body, 'description', { max: 2000 })
  if ('is_active' in body) updates.is_active = Boolean(body.is_active)
  await file.update(updates)
  await audit(requestMeta(event), { action: 'KNOWLEDGE_UPDATE', entityType: 'knowledge_file', entityId: file.id, after: { title: file.title, ...updates } })
  return { knowledge_file: knowledgeDto(file) }
})
