import { DocumentTemplate, sequelize } from '~~/server/lib/models.ts'
import { audit } from '~~/server/lib/audit.ts'
import { conflict } from '~~/server/lib/errors.ts'
import { requirePage } from '~~/server/lib/team.ts'
import { readTemplateInput, templateDto } from '~~/server/lib/templates.ts'
import { isMissingTable, settingsTablesMissing } from '~~/server/lib/work-calendar.ts'

/**
 * Add a document template (CLIENT only): name, description (when the AI should use it),
 * show_logo, header_text, body_guide, signatory_name, signatory_title, footer_text, is_default.
 */
export default defineApiHandler(async (event) => {
  const user = await requireUser(event, 'CLIENT')
  requirePage(user, '/client/settings')
  const input = readTemplateInput(await readJson(event), false)
  try {
    const template = await sequelize.transaction(async (transaction) => {
      if (await DocumentTemplate.count({ where: { org_id: user.org_id, name: input.name as string }, transaction })) {
        throw conflict(`There is already a template called “${input.name}”`, 'DUPLICATE')
      }
      const count = await DocumentTemplate.count({ where: { org_id: user.org_id }, transaction })
      // The first template is the default until another is chosen.
      const isDefault = Boolean(input.is_default) || count === 0
      if (isDefault) await DocumentTemplate.update({ is_default: false }, { where: { org_id: user.org_id }, transaction })
      return DocumentTemplate.create({ ...input, org_id: user.org_id, is_default: isDefault, sort_order: count, created_by: user.id }, { transaction })
    })
    await audit(requestMeta(event), { action: 'TEMPLATE_CREATE', entityType: 'document_template', entityId: template.id, after: { name: template.name } })
    setResponseStatus(event, 201)
    return { template: templateDto(template) }
  } catch (err) {
    throw isMissingTable(err) ? settingsTablesMissing() : err
  }
})
