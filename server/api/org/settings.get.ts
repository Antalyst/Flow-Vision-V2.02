import { fn, col } from 'sequelize'
import { Document, DocumentType, KnowledgeFile, Organization, OrganizationHoliday, OrganizationSettings, User } from '~~/server/lib/models.ts'
import { documentTypeDto, knowledgeDto } from '~~/server/lib/knowledge.ts'
import { userAttrs } from '~~/server/lib/document-queries.ts'
import { env } from '~~/server/lib/env.ts'
import { requirePage } from '~~/server/lib/team.ts'
import { imageKey, imageVersion } from '~~/server/lib/org-assets.ts'
import { listTemplates, templateDto } from '~~/server/lib/templates.ts'
import { holidayDto, isMissingTable, settingsUnavailable, workCalendarDto } from '~~/server/lib/work-calendar.ts'

/**
 * Organization Settings (CLIENT only): profile and logo, working hours and holidays, document
 * types (with how many documents use each), document templates, AI knowledge files.
 */
export default defineApiHandler(async (event) => {
  const user = await requireUser(event, 'CLIENT')
  requirePage(user, '/client/settings')
  const [org, types, usage, files, calendar, templates] = await Promise.all([
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
    // Working hours and holidays; their tables may not exist yet (npm run db:add-settings).
    Promise.all([
      OrganizationSettings.findByPk(user.org_id),
      OrganizationHoliday.findAll({ where: { org_id: user.org_id }, order: [['holiday_date', 'ASC']] }),
    ]).catch((err) => {
      if (!isMissingTable(err)) throw err
      settingsUnavailable()
      return null
    }),
    listTemplates(user.org_id),
  ])
  const usageByName = new Map(usage.map((u) => [u.category, Number(u.count)]))
  const [settings, holidays] = calendar ?? [null, []]
  return {
    organization: {
      id: org!.id,
      name: org!.name,
      description: org!.description ?? null,
      website: org!.website ?? null,
      logo_url: imageKey(org!.logo_url) ? `/api/org/logo?v=${imageVersion(org!.logo_url)}` : null,
    },
    work_calendar: workCalendarDto(settings, Boolean(calendar)),
    holidays: holidays.map(holidayDto),
    document_types: types.map((t) => documentTypeDto(t, usageByName.get(t.name) ?? 0)),
    templates: templates.map(templateDto),
    knowledge_files: files.map(knowledgeDto),
    limits: { knowledge_max_bytes: env.maxKnowledgeBytes },
    ai_configured: Boolean(process.env.GROQ_API_KEY),
  }
})
