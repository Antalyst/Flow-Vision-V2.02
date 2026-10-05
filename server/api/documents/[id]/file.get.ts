import fs from 'node:fs'
import path from 'node:path'
import { Op } from 'sequelize'
import { openableWhere } from '~~/server/lib/document-queries.ts'
import { Document } from '~~/server/lib/models.ts'
import { notFound } from '~~/server/lib/errors.ts'
import { contentTypeFor, uploadPath } from '~~/server/lib/uploads.ts'

/** Stream the attachment. Auth is the session cookie, so a plain link works. */
export default defineApiHandler(async (event) => {
  const user = await requireUser(event)
  const doc = await Document.findOne({ where: { id: routeParam(event, 'id'), org_id: user.org_id, [Op.and]: [openableWhere(user)] } })
  const filePath = uploadPath(doc?.file_url)
  if (!doc || !filePath || !fs.existsSync(filePath)) throw notFound('Attachment')

  setResponseHeaders(event, {
    'Content-Type': contentTypeFor(doc.file_url, doc.file_type),
    'Content-Disposition': `inline; filename*=UTF-8''${encodeURIComponent(path.basename(filePath))}`,
    'Cache-Control': 'private, no-store',
  })
  return sendStream(event, fs.createReadStream(filePath))
})
