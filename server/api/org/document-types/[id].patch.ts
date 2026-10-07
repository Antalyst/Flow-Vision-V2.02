import { Op } from 'sequelize'
import { sequelize, Document, DocumentType } from '~~/server/lib/models.ts'
import { documentTypeDto, readProcessingTime } from '~~/server/lib/knowledge.ts'
import { audit } from '~~/server/lib/audit.ts'
import { conflict, notFound } from '~~/server/lib/errors.ts'
import * as v from '~~/server/lib/validate.ts'
import { requirePage } from '~~/server/lib/team.ts'

/**
 * Edit a document type (CLIENT only): `name`, `description`, `processing_days` / `processing_hours`
 * (applies to documents submitted from now on), `is_active` (offered when uploading),
 * `sort_order`. Renaming also renames it on the documents that use it, so lists stay consistent.
 */
export default defineApiHandler(async (event) => {
  const user = await requireUser(event, 'CLIENT')
  requirePage(user, '/client/settings')
  const body = await readJson(event)
  const type = await DocumentType.findOne({ where: { id: routeParam(event, 'id'), org_id: user.org_id } })
  if (!type) throw notFound('Document type')
  const before = documentTypeDto(type)

  const updates: Record<string, unknown> = {}
  if ('name' in body) {
    const name = v.reqStr(body, 'name', { max: 100, label: 'Name' })
    if (name !== type.name && (await DocumentType.count({ where: { org_id: user.org_id, name, id: { [Op.ne]: type.id } } }))) {
      throw conflict(`There is already a document type called “${name}”`, 'DUPLICATE')
    }
    updates.name = name
  }
  if ('description' in body) updates.description = v.str(body, 'description', { max: 500 })
  if ('processing_days' in body || 'processing_hours' in body) {
    Object.assign(updates, readProcessingTime({ processing_days: type.processing_days, processing_hours: type.processing_hours, ...body }))
  }
  if ('is_active' in body) updates.is_active = Boolean(body.is_active)
  if ('sort_order' in body && Number.isInteger(Number(body.sort_order))) updates.sort_order = Number(body.sort_order)

  await sequelize.transaction(async (transaction) => {
    const oldName = type.name as string
    await type.update(updates, { transaction })
    if (updates.name && updates.name !== oldName) {
      await Document.update({ category: updates.name }, { where: { org_id: user.org_id, category: oldName }, transaction })
    }
  })
  await audit(requestMeta(event), { action: 'DOCUMENT_TYPE_UPDATE', entityType: 'document_type', entityId: type.id, before, after: documentTypeDto(type) })
  return { document_type: documentTypeDto(type) }
})
