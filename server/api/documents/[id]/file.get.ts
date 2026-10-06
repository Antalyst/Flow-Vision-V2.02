import { Op } from 'sequelize'
import { openableWhere } from '~~/server/lib/document-queries.ts'
import { Document } from '~~/server/lib/models.ts'
import { notFound } from '~~/server/lib/errors.ts'
import { contentTypeFor, openUpload } from '~~/server/lib/uploads.ts'

/** Stream the attachment. Auth is the session cookie, so a plain link works. */
export default defineApiHandler(async (event) => {
  const user = await requireUser(event)
  const doc = await Document.findOne({ where: { id: routeParam(event, 'id'), org_id: user.org_id, [Op.and]: [openableWhere(user)] } })
  const file = doc ? await openUpload(doc.file_url) : null
  if (!doc || !file) throw notFound('Attachment')

  setResponseHeaders(event, {
    'Content-Type': contentTypeFor(doc.file_url, doc.file_type),
    'Content-Disposition': `inline; filename*=UTF-8''${encodeURIComponent(file.name)}`,
    'Content-Length': String(file.size),
    'Cache-Control': 'private, no-store',
  })
  return sendStream(event, file.stream)
})
