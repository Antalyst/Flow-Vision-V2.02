import { Document } from '~~/server/lib/models.ts'
import { audit } from '~~/server/lib/audit.ts'
import { conflict, forbidden, notFound } from '~~/server/lib/errors.ts'
import { allowedHoursFor, canManageDocument, SUBMITTER_TYPES } from '~~/server/lib/documents.ts'
import { routeForNewDocument } from '~~/server/lib/routes.ts'
import { autoPriority } from '~~/server/lib/priority.ts'
import { loadDocumentDto } from '~~/server/lib/document-queries.ts'
import { parseDocumentForm, removeUpload } from '~~/server/lib/uploads.ts'
import * as v from '~~/server/lib/validate.ts'

/** Edit a draft (multipart, incl. `route_id`). Once a document enters its route, its content is frozen. */
export default defineApiHandler(async (event) => {
  const user = await requireUser(event, ...SUBMITTER_TYPES)
  const doc = await Document.findOne({ where: { id: routeParam(event, 'id'), org_id: user.org_id } })
  if (!doc) throw notFound('Document')
  if (!canManageDocument(doc, user)) throw forbidden('Only the person who uploaded this draft can edit it')
  if (doc.status !== 'CREATED') throw conflict('Only drafts can be edited')

  const { fields, file } = await parseDocumentForm(await readMultipartFormData(event))
  try {
    const before = doc.toJSON()
    const updates: Record<string, unknown> = {}
    if ('title' in fields) updates.title = v.reqStr(fields, 'title', { label: 'Title' })
    if ('description' in fields) updates.description = v.str(fields, 'description', { max: 5000 })
    if ('document_type' in fields) updates.category = v.str(fields, 'document_type', { max: 100 })
    const routeId = v.str(fields, 'route_id', { max: 36 })
    if (routeId && routeId !== doc.route_id) updates.route_id = (await routeForNewDocument(user.org_id, routeId)).id
    // Priority is never chosen by hand: it follows the (edited) content and the type's processing time.
    const routeIdAfter = (updates.route_id as string | undefined) ?? doc.route_id
    updates.priority = autoPriority({
      title: (updates.title as string | undefined) ?? doc.title,
      description: 'description' in updates ? (updates.description as string | null) : doc.description,
      document_type: 'category' in updates ? (updates.category as string | null) : doc.category,
      routeHours: (await allowedHoursFor(user.org_id, 'category' in updates ? (updates.category as string | null) : doc.category, routeIdAfter)) || null,
    })
    const oldFile = file ? doc.file_url : null
    if (file) Object.assign(updates, { file_url: file.fileUrl, file_type: file.fileType, file_size: file.size })

    await doc.update(updates)
    removeUpload(oldFile)
    await audit(requestMeta(event), { action: 'DOCUMENT_UPDATE', entityType: 'document', entityId: doc.id, before, after: doc.toJSON() })
    return { document: await loadDocumentDto(doc.id) }
  } catch (err) {
    removeUpload(file?.fileUrl)
    throw err
  }
})
