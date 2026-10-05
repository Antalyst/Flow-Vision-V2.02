import { fn, col } from 'sequelize'
import { Document, DocumentType, KnowledgeFile, Organization, User } from '~~/server/lib/models.ts'
import { documentTypeDto, knowledgeDto } from '~~/server/lib/knowledge.ts'
import { userAttrs } from '~~/server/lib/document-queries.ts'
import { env } from '~~/server/lib/env.ts'

/** Organization Settings (CLIENT only): profile, document types (with how many documents use each), AI knowledge files. */
export default defineApiHandler(async (event) => {
  const user = await requireUser(event, 'CLIENT')
  const [org, types, usage, files] = await Promise.all([
    Organization.findByPk(user.org_id),
    DocumentType.findAll({ where: { org_id: user.org_id }, order: [['sort_order', 'ASC'], ['name', 'ASC']] }),
    Document.findAll({ where: { org_id: user.org_id }, attributes: ['category', [fn('COUNT', col('id')), 'count']], group: ['category'], raw: true }) as unknown as Promise<
      Array<{ category: string | null; count: number }>
    >,
    // The extracted text can be huge: never send it to the browser.
    KnowledgeFile.findAll({
      where: { org_id: user.org_id },
      attributes: { exclude: ['content'] },
      include: [{ model: User, as: 'uploader', attributes: userAttrs }],
      order: [['created_at', 'DESC']],
    }),
  ])
  const usageByName = new Map(usage.map((u) => [u.category, Number(u.count)]))
  return {
    organization: { id: org!.id, name: org!.name, description: org!.description ?? null, website: org!.website ?? null },
    document_types: types.map((t) => documentTypeDto(t, usageByName.get(t.name) ?? 0)),
    knowledge_files: files.map(knowledgeDto),
    limits: { knowledge_max_bytes: env.maxKnowledgeBytes },
    ai_configured: Boolean(process.env.GROQ_API_KEY),
  }
})
