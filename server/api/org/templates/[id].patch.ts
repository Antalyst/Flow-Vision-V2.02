import { Op } from 'sequelize'
import { DocumentTemplate, sequelize } from '~~/server/lib/models.ts'
import { audit } from '~~/server/lib/audit.ts'
import { conflict, notFound } from '~~/server/lib/errors.ts'
import { requirePage } from '~~/server/lib/team.ts'
import { readTemplateInput, templateDto } from '~~/server/lib/templates.ts'
import { isMissingTable, settingsTablesMissing } from '~~/server/lib/work-calendar.ts'

/** Edit a document template (CLIENT only): any field of the add form, plus is_active and sort_order. */
export default defineApiHandler(async (event) => {
  const user = await requireUser(event, 'CLIENT')
  requirePage(user, '/client/settings')
  const input = readTemplateInput(await readJson(event), true)
  try {
    const template = await sequelize.transaction(async (transaction) => {
      const row = await DocumentTemplate.findOne({ where: { id: routeParam(event, 'id'), org_id: user.org_id }, transaction })
      if (!row) throw notFound('Template')
      if (input.name && input.name !== row.name && (await DocumentTemplate.count({ where: { org_id: user.org_id, name: input.name as string, id: { [Op.ne]: row.id } }, transaction }))) {
        throw conflict(`There is already a template called “${input.name}”`, 'DUPLICATE')
      }
      // One default at a time.
      if (input.is_default) await DocumentTemplate.update({ is_default: false }, { where: { org_id: user.org_id, id: { [Op.ne]: row.id } }, transaction })
      return row.update(input, { transaction })
    })
    await audit(requestMeta(event), { action: 'TEMPLATE_UPDATE', entityType: 'document_template', entityId: template.id, after: { name: template.name } })
    return { template: templateDto(template) }
  } catch (err) {
    throw isMissingTable(err) ? settingsTablesMissing() : err
  }
})
