import { Op } from 'sequelize'
import { openableWhere } from '~~/server/lib/document-queries.ts'
import { Document, DocumentFile } from '~~/server/lib/models.ts'
import { notFound } from '~~/server/lib/errors.ts'
import { contentTypeFor, openUpload } from '~~/server/lib/uploads.ts'

/** Stream one of a document's files (bulk uploads have several). Auth is the session cookie. */
export default defineApiHandler(async (event) => {
  const user = await requireUser(event)
  const doc = await Document.findOne({ where: { id: routeParam(event, 'id'), org_id: user.org_id, [Op.and]: [openableWhere(user)] }, attributes: ['id'] })
  const file = doc ? await DocumentFile.findOne({ where: { id: routeParam(event, 'fileId'), document_id: doc.id } }) : null
  const stored = file ? await openUpload(file.file_url) : null
  if (!file || !stored) throw notFound('Attachment')

  setResponseHeaders(event, {
    'Content-Type': contentTypeFor(file.file_url, file.file_type),
    'Content-Disposition': `inline; filename*=UTF-8''${encodeURIComponent(stored.name)}`,
    'Content-Length': String(stored.size),
    'Cache-Control': 'private, no-store',
  })
  return sendStream(event, stored.stream)
})
