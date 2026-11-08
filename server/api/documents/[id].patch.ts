import { sequelize, Document, DocumentFile } from '~~/server/lib/models.ts'
import { audit } from '~~/server/lib/audit.ts'
import { badRequest, conflict, forbidden, notFound } from '~~/server/lib/errors.ts'
import { allowedHoursFor, canManageDocument, routingFrom, SUBMITTER_TYPES } from '~~/server/lib/documents.ts'
import { routeForNewDocument } from '~~/server/lib/routes.ts'
import { findUsableInternalRoute } from '~~/server/lib/internal-routes.ts'
import { autoPriority } from '~~/server/lib/priority.ts'
import { parseDocumentForm, removeUpload } from '~~/server/lib/uploads.ts'
import * as v from '~~/server/lib/validate.ts'
import { loadDocumentFor } from '~~/server/lib/qr-access.ts'

/** Edit a draft (multipart, incl. `routing_mode` + `route_id` / `internal_route_id`). Once a document enters its route, its content is frozen. */
export default defineApiHandler(async (event) => {
  const user = await requireUser(event, ...SUBMITTER_TYPES)
  const doc = await Document.findOne({ where: { id: routeParam(event, 'id'), org_id: user.org_id } })
  if (!doc) throw notFound('Document')
  if (!canManageDocument(doc, user)) throw forbidden('Only the person who uploaded this draft can edit it')
  if (doc.status !== 'CREATED') throw conflict('Only drafts can be edited')

  const { fields, files } = await parseDocumentForm(await readMultipartFormData(event), user.id)
  try {
    const before = doc.toJSON()
    const updates: Record<string, unknown> = {}
    if ('title' in fields) updates.title = v.reqStr(fields, 'title', { label: 'Title' })
    if ('description' in fields) updates.description = v.str(fields, 'description', { max: 5000 })
    if ('document_type' in fields) updates.category = v.str(fields, 'document_type', { max: 100 })
    // The routing: another Document Route, or a switch between Global Routing and an internal process. The
    // other one is cleared in the same update (a document has exactly one), and both are checked against the
    // session's account: an internal route only of the uploader's own office. Validated again on submission.
    const routing = routingFrom(fields)
    if (routing?.mode === 'INTERNAL') {
      Object.assign(updates, { route_id: null, internal_route_id: (await findUsableInternalRoute(user, routing.internalRouteId)).id })
    } else if (routing && (routing.routeId ? routing.routeId !== doc.route_id : !doc.route_id)) {
      Object.assign(updates, { route_id: (await routeForNewDocument(user.org_id, routing.routeId)).id, internal_route_id: null })
    }
    // Priority is never chosen by hand: it follows the (edited) content and the type's processing time.
    const routeIdAfter = 'route_id' in updates ? (updates.route_id as string | null) : doc.route_id
    updates.priority = autoPriority({
      title: (updates.title as string | undefined) ?? doc.title,
      description: 'description' in updates ? (updates.description as string | null) : doc.description,
      document_type: 'category' in updates ? (updates.category as string | null) : doc.category,
      routeHours: (await allowedHoursFor(user.org_id, 'category' in updates ? (updates.category as string | null) : doc.category, routeIdAfter, undefined, user.office_id)) || null,
    })
    // New files replace all of the draft's files (one, or a bulk set).
    const first = files[0]
    const oldFiles = first ? [doc.file_url, ...(await DocumentFile.findAll({ where: { document_id: doc.id }, attributes: ['file_url'] })).map((f) => f.file_url)] : []
    if (first) Object.assign(updates, { file_url: first.fileUrl, file_type: first.fileType, file_size: first.size, pages: files.length })
    if (fields.pages) {
      const pages = Number(fields.pages)
      if (!Number.isInteger(pages) || pages < 1 || pages > 9999) throw badRequest('Number of pages must be a whole number from 1 to 9999', { field: 'pages' })
      updates.pages = pages
    }

    await sequelize.transaction(async (transaction) => {
      await doc.update(updates, { transaction })
      if (first) {
        await DocumentFile.destroy({ where: { document_id: doc.id }, transaction })
        await DocumentFile.bulkCreate(
          files.map((f, i) => ({ document_id: doc.id, file_url: f.fileUrl, file_name: f.name, file_type: f.fileType, file_size: f.size, sort_order: i })),
          { transaction },
        )
      }
    })
    for (const url of new Set(oldFiles)) removeUpload(url)
    await audit(requestMeta(event), { action: 'DOCUMENT_UPDATE', entityType: 'document', entityId: doc.id, before, after: doc.toJSON() })
    return { document: await loadDocumentFor(doc.id, user) }
  } catch (err) {
    files.forEach((f) => removeUpload(f.fileUrl))
    throw err
  }
})
