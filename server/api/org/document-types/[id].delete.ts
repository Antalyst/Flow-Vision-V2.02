import { DocumentType } from '~~/server/lib/models.ts'
import { audit } from '~~/server/lib/audit.ts'
import { notFound } from '~~/server/lib/errors.ts'

/** Remove a document type (CLIENT only). Documents already filed under it keep the name. */
export default defineApiHandler(async (event) => {
  const user = await requireUser(event, 'CLIENT')
  const type = await DocumentType.findOne({ where: { id: routeParam(event, 'id'), org_id: user.org_id } })
  if (!type) throw notFound('Document type')
  await type.destroy()
  await audit(requestMeta(event), { action: 'DOCUMENT_TYPE_DELETE', entityType: 'document_type', entityId: type.id, before: { name: type.name } })
  return { ok: true }
})
