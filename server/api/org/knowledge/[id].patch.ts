import { KnowledgeFile, Office } from '~~/server/lib/models.ts'
import { knowledgeDto, readKnowledgeKind, resolveKnowledgeOffice } from '~~/server/lib/knowledge.ts'
import { audit } from '~~/server/lib/audit.ts'
import { notFound } from '~~/server/lib/errors.ts'
import * as v from '~~/server/lib/validate.ts'
import { requirePage } from '~~/server/lib/team.ts'

/**
 * Edit a knowledge file (ADMIN only): `title`, `description`, `is_active` (whether the AI uses it),
 * `office_id` (null = organization-wide, else only that office and the ADMIN) and `kind`.
 */
export default defineApiHandler(async (event) => {
  const user = await requireUser(event, 'ADMIN')
  requirePage(user, '/client/settings')
  const body = await readJson(event)
  const file = await KnowledgeFile.findOne({ where: { id: routeParam(event, 'id'), org_id: user.org_id }, attributes: { exclude: ['content'] } })
  if (!file) throw notFound('Knowledge file')
  const before = { title: file.title, office_id: file.office_id ?? null, kind: file.kind, is_active: Boolean(file.is_active) }
  const updates: Record<string, unknown> = {}
  if ('title' in body) updates.title = v.reqStr(body, 'title', { max: 255, label: 'Title' })
  if ('description' in body) updates.description = v.str(body, 'description', { max: 2000 })
  if ('is_active' in body) updates.is_active = Boolean(body.is_active)
  if ('office_id' in body) updates.office_id = ((await resolveKnowledgeOffice(user.org_id, body.office_id))?.id as string | undefined) ?? null
  if ('kind' in body) updates.kind = readKnowledgeKind(body.kind) ?? 'GENERAL'
  await file.update(updates)
  await audit(requestMeta(event), { action: 'KNOWLEDGE_UPDATE', entityType: 'knowledge_file', entityId: file.id, before, after: { title: file.title, ...updates } })
  await file.reload({ attributes: { exclude: ['content'] }, include: [{ model: Office, as: 'office', attributes: ['id', 'name'] }] })
  return { knowledge_file: knowledgeDto(file) }
})
