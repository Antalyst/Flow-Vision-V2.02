import { Document, DocumentFile } from '~~/server/lib/models.ts'
import { audit } from '~~/server/lib/audit.ts'
import { conflict, forbidden, notFound } from '~~/server/lib/errors.ts'
import { canManageDocument, SUBMITTER_TYPES } from '~~/server/lib/documents.ts'
import { removeUpload } from '~~/server/lib/uploads.ts'

export default defineApiHandler(async (event) => {
  const user = await requireUser(event, ...SUBMITTER_TYPES)
  const doc = await Document.findOne({ where: { id: routeParam(event, 'id'), org_id: user.org_id } })
  if (!doc) throw notFound('Document')
  if (!canManageDocument(doc, user)) throw forbidden('Only the person who uploaded this draft can delete it')
  if (doc.status !== 'CREATED') throw conflict('Only drafts can be deleted')
  // Every attached file (a bulk upload has several); the rows go with the document.
  const files = await DocumentFile.findAll({ where: { document_id: doc.id }, attributes: ['file_url'] })
  await doc.destroy()
  for (const url of new Set([doc.file_url, ...files.map((f) => f.file_url)])) removeUpload(url)
  await audit(requestMeta(event), { action: 'DOCUMENT_DELETE', entityType: 'document', entityId: doc.id, before: doc.toJSON() })
  return { ok: true }
})
