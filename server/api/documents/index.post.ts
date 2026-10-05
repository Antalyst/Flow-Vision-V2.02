import { createDocument, SUBMITTER_TYPES } from '~~/server/lib/documents.ts'
import { loadDocumentDto } from '~~/server/lib/document-queries.ts'
import { parseDocumentForm, removeUpload } from '~~/server/lib/uploads.ts'
import * as v from '~~/server/lib/validate.ts'

/** multipart/form-data: title, description, document_type, route_id, submit, file.
 *  Priority and the target completion time are set automatically (see priority.ts and enterRoute). */
export default defineApiHandler(async (event) => {
  const user = await requireUser(event, ...SUBMITTER_TYPES)
  const { fields, file } = await parseDocumentForm(await readMultipartFormData(event))
  try {
    const doc = await createDocument(
      user,
      {
        title: v.reqStr(fields, 'title', { label: 'Title' }),
        description: v.str(fields, 'description', { max: 5000 }),
        document_type: v.str(fields, 'document_type', { max: 100 }),
        route_id: v.str(fields, 'route_id', { max: 36 }),
        // Multipart sends booleans as strings; submitting is the default.
        submit: !['false', '0'].includes(fields.submit ?? ''),
      },
      file,
      requestMeta(event),
    )
    setResponseStatus(event, 201)
    return { document: await loadDocumentDto(doc.id) }
  } catch (err) {
    removeUpload(file?.fileUrl)
    throw err
  }
})
