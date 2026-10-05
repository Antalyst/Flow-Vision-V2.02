import { DocumentType } from '~~/server/lib/models.ts'
import { documentTypeDto, readProcessingTime } from '~~/server/lib/knowledge.ts'
import { audit } from '~~/server/lib/audit.ts'
import { conflict } from '~~/server/lib/errors.ts'
import * as v from '~~/server/lib/validate.ts'

/** Add a document type (CLIENT only): name, description, processing_days + processing_hours (how long such documents may take). */
export default defineApiHandler(async (event) => {
  const user = await requireUser(event, 'CLIENT')
  const body = await readJson(event)
  const name = v.reqStr(body, 'name', { max: 100, label: 'Name' })
  if (await DocumentType.count({ where: { org_id: user.org_id, name } })) throw conflict(`There is already a document type called “${name}”`, 'DUPLICATE')
  const last = (await DocumentType.max('sort_order', { where: { org_id: user.org_id } })) as number | null
  const type = await DocumentType.create({
    org_id: user.org_id,
    name,
    description: v.str(body, 'description', { max: 500 }),
    ...readProcessingTime(body),
    sort_order: (last ?? -1) + 1,
    created_by: user.id,
  })
  await audit(requestMeta(event), { action: 'DOCUMENT_TYPE_CREATE', entityType: 'document_type', entityId: type.id, after: { name } })
  setResponseStatus(event, 201)
  return { document_type: documentTypeDto(type, 0) }
})
