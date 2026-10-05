import fs from 'node:fs'
import path from 'node:path'
import { Op } from 'sequelize'
import { openableWhere } from '~~/server/lib/document-queries.ts'
import { Document, DocumentFile } from '~~/server/lib/models.ts'
import { notFound } from '~~/server/lib/errors.ts'
import { contentTypeFor, uploadPath } from '~~/server/lib/uploads.ts'

/** Stream one of a document's files (bulk uploads have several). Auth is the session cookie. */
export default defineApiHandler(async (event) => {
  const user = await requireUser(event)
  const doc = await Document.findOne({ where: { id: routeParam(event, 'id'), org_id: user.org_id, [Op.and]: [openableWhere(user)] }, attributes: ['id'] })
  const file = doc ? await DocumentFile.findOne({ where: { id: routeParam(event, 'fileId'), document_id: doc.id } }) : null
  const filePath = uploadPath(file?.file_url)
  if (!file || !filePath || !fs.existsSync(filePath)) throw notFound('Attachment')

  setResponseHeaders(event, {
    'Content-Type': contentTypeFor(file.file_url, file.file_type),
    'Content-Disposition': `inline; filename*=UTF-8''${encodeURIComponent(path.basename(filePath))}`,
    'Cache-Control': 'private, no-store',
  })
  return sendStream(event, fs.createReadStream(filePath))
})
