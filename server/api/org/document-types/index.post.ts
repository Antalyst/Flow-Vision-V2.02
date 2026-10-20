import { DocumentType, Office } from '~~/server/lib/models.ts'
import { documentTypeDto, readProcessingTime } from '~~/server/lib/knowledge.ts'
import { assertTypeNameFree, readTypeOffice } from '~~/server/lib/document-type-input.ts'
import { audit } from '~~/server/lib/audit.ts'
import * as v from '~~/server/lib/validate.ts'
import { requirePage } from '~~/server/lib/team.ts'

/**
 * Add a document type (ADMIN only): name, description, office_id (empty = Global, offered to every
 * office), processing_days + processing_hours + processing_minutes (how long such documents may take).
 */
export default defineApiHandler(async (event) => {
  const user = await requireUser(event, 'ADMIN')
  requirePage(user, '/client/settings')
  const body = await readJson(event)
  const name = v.reqStr(body, 'name', { max: 100, label: 'Name' })
  const officeId = await readTypeOffice(user.org_id, body.office_id)
  await assertTypeNameFree(user.org_id, officeId, name)
  const last = (await DocumentType.max('sort_order', { where: { org_id: user.org_id } })) as number | null
  const type = await DocumentType.create({
    org_id: user.org_id,
    office_id: officeId,
    name,
    description: v.str(body, 'description', { max: 500 }),
    ...readProcessingTime(body),
    sort_order: (last ?? -1) + 1,
    created_by: user.id,
  })
  await audit(requestMeta(event), { action: 'DOCUMENT_TYPE_CREATE', entityType: 'document_type', entityId: type.id, after: { name, office_id: officeId } })
  await type.reload({ include: [{ model: Office, as: 'office', attributes: ['id', 'name', 'code'] }] })
  setResponseStatus(event, 201)
  return { document_type: documentTypeDto(type, 0) }
})
