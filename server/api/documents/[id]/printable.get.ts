import path from 'node:path'
import { Op } from 'sequelize'
import { openableWhere } from '~~/server/lib/document-queries.ts'
import { Document } from '~~/server/lib/models.ts'
import { badRequest, notFound } from '~~/server/lib/errors.ts'
import * as v from '~~/server/lib/validate.ts'
import { readUpload } from '~~/server/lib/uploads.ts'
import { documentFileUrl } from '~~/server/lib/document-files.ts'

/**
 * A Word attachment as HTML, so the browser can print it together with the QR label.
 * (PDFs and images print straight from /file.) The page renders it in a sandboxed frame
 * without scripts; links are dropped anyway since paper can't follow them.
 */
export default defineApiHandler(async (event) => {
  const user = await requireUser(event)
  const doc = await Document.findOne({ where: { id: routeParam(event, 'id'), org_id: user.org_id, [Op.and]: [openableWhere(user)] } })
  // ?file=<id> picks one of a bulk upload's files; default: the first.
  const file = doc ? await readUpload(await documentFileUrl(doc, v.q(getQuery(event), 'file', 36))) : null
  if (!doc || !file) throw notFound('Attachment')
  if (path.extname(file.name).toLowerCase() !== '.docx') throw badRequest('Only Word (.docx) attachments are converted for printing')

  const mammoth = await import('mammoth')
  const { value } = await mammoth.convertToHtml({ buffer: file.data })
  setResponseHeaders(event, { 'Cache-Control': 'private, no-store' })
  return { html: value.replace(/\s(href|on\w+)="[^"]*"/gi, '') }
})
