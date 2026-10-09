import { DocumentTemplate, Organization, sequelize } from '~~/server/lib/models.ts'
import { audit } from '~~/server/lib/audit.ts'
import { requirePage } from '~~/server/lib/team.ts'
import { starterTemplates, templateDto } from '~~/server/lib/templates.ts'
import { isMissingTable, settingsTablesMissing } from '~~/server/lib/work-calendar.ts'

/** Add the ready-made templates (Memorandum, Official Letter, Report) the organization doesn't have yet (CLIENT only). */
export default defineApiHandler(async (event) => {
  const user = await requireUser(event, 'CLIENT')
  requirePage(user, '/client/settings')
  const org = (await Organization.findByPk(user.org_id, { attributes: ['name'] }))!
  try {
    const created = await sequelize.transaction(async (transaction) => {
      const existing = await DocumentTemplate.findAll({ where: { org_id: user.org_id }, attributes: ['name', 'is_default'], transaction })
      const names = new Set(existing.map((t) => String(t.name).toLowerCase()))
      const hasDefault = existing.some((t) => t.is_default)
      const rows = starterTemplates(org.name)
        .filter((t) => !names.has(t.name.toLowerCase()))
        .map((t, i) => ({ ...t, is_default: t.is_default && !hasDefault, org_id: user.org_id, sort_order: existing.length + i, created_by: user.id }))
      return rows.length ? DocumentTemplate.bulkCreate(rows, { transaction }) : []
    })
    for (const t of created) await audit(requestMeta(event), { action: 'TEMPLATE_CREATE', entityType: 'document_template', entityId: t.id, after: { name: t.name } })
    setResponseStatus(event, 201)
    return { templates: created.map(templateDto) }
  } catch (err) {
    throw isMissingTable(err) ? settingsTablesMissing() : err
  }
})
