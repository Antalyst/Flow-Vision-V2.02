import { sequelize, Document, DocumentType, Office } from '~~/server/lib/models.ts'
import { documentTypeDto, readProcessingTime } from '~~/server/lib/knowledge.ts'
import { assertTypeNameFree, readTypeOffice } from '~~/server/lib/document-type-input.ts'
import { audit } from '~~/server/lib/audit.ts'
import { notFound } from '~~/server/lib/errors.ts'
import * as v from '~~/server/lib/validate.ts'
import { requirePage } from '~~/server/lib/team.ts'

/**
 * Edit a document type (ADMIN only): `name`, `description`, `office_id` (null = Global),
 * `processing_days` / `processing_hours` / `processing_minutes` (applies to documents submitted from
 * now on), `is_active` (offered when uploading), `sort_order`. Renaming also renames it on the
 * documents that use it — unless another type still has the old name.
 */
export default defineApiHandler(async (event) => {
  const user = await requireUser(event, 'ADMIN')
  requirePage(user, '/client/settings')
  const body = await readJson(event)
  const officeInclude = { model: Office, as: 'office', attributes: ['id', 'name', 'code'] }
  const type = await DocumentType.findOne({ where: { id: routeParam(event, 'id'), org_id: user.org_id }, include: [officeInclude] })
  if (!type) throw notFound('Document type')
  const before = documentTypeDto(type)

  const updates: Record<string, unknown> = {}
  if ('office_id' in body) updates.office_id = await readTypeOffice(user.org_id, body.office_id)
  if ('name' in body) updates.name = v.reqStr(body, 'name', { max: 100, label: 'Name' })
  if ('name' in updates || 'office_id' in updates) {
    await assertTypeNameFree(user.org_id, ('office_id' in updates ? updates.office_id : type.office_id) as string | null, (updates.name as string) ?? type.name, type.id)
  }
  if ('description' in body) updates.description = v.str(body, 'description', { max: 500 })
  if ('processing_days' in body || 'processing_hours' in body || 'processing_minutes' in body) {
    Object.assign(updates, readProcessingTime({ processing_days: type.processing_days, processing_hours: type.processing_hours, processing_minutes: type.processing_minutes, ...body }))
  }
  if ('is_active' in body) updates.is_active = Boolean(body.is_active)
  if ('sort_order' in body && Number.isInteger(Number(body.sort_order))) updates.sort_order = Number(body.sort_order)

  await sequelize.transaction(async (transaction) => {
    const oldName = type.name as string
    await type.update(updates, { transaction })
    if (updates.name && updates.name !== oldName && !(await DocumentType.count({ where: { org_id: user.org_id, name: oldName }, transaction }))) {
      await Document.update({ category: updates.name }, { where: { org_id: user.org_id, category: oldName }, transaction })
    }
  })
  await type.reload({ include: [officeInclude] })
  await audit(requestMeta(event), { action: 'DOCUMENT_TYPE_UPDATE', entityType: 'document_type', entityId: type.id, before, after: documentTypeDto(type) })
  return { document_type: documentTypeDto(type) }
})
