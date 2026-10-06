import { createDocument, SUBMITTER_TYPES } from '~~/server/lib/documents.ts'
import { loadDocumentDto } from '~~/server/lib/document-queries.ts'
import { parseDocumentForm, removeUpload } from '~~/server/lib/uploads.ts'
import { badRequest } from '~~/server/lib/errors.ts'
import * as v from '~~/server/lib/validate.ts'

/**
 * multipart/form-data: title, description, document_type, route_id, submit, file (once, or
 * repeated for a bulk upload — all files go under one document and one QR code), upload (the key
 * of a large file sent ahead in parts via POST /uploads; mixed with `file` parts, order kept), pages.
 * `pages`: how many pages/sheets the paper has — required in spirit for photos only; otherwise it
 * defaults to the number of files. Priority and the target completion time are set automatically.
 */
export default defineApiHandler(async (event) => {
  const user = await requireUser(event, ...SUBMITTER_TYPES)
  const { fields, files } = await parseDocumentForm(await readMultipartFormData(event), user.id)
  try {
    let pages: number | null = null
    if (fields.pages) {
      pages = Number(fields.pages)
      if (!Number.isInteger(pages) || pages < 1 || pages > 9999) throw badRequest('Number of pages must be a whole number from 1 to 9999', { field: 'pages' })
    }
    const doc = await createDocument(
      user,
      {
        title: v.reqStr(fields, 'title', { label: 'Title' }),
        description: v.str(fields, 'description', { max: 5000 }),
        document_type: v.str(fields, 'document_type', { max: 100 }),
        route_id: v.str(fields, 'route_id', { max: 36 }),
        // Multipart sends booleans as strings; submitting is the default.
        submit: !['false', '0'].includes(fields.submit ?? ''),
        pages,
      },
      files,
      requestMeta(event),
    )
    setResponseStatus(event, 201)
    return { document: await loadDocumentDto(doc.id) }
  } catch (err) {
    files.forEach((f) => removeUpload(f.fileUrl))
    throw err
  }
})
