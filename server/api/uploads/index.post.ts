import { SUBMITTER_TYPES } from '~~/server/lib/documents.ts'
import { startStagedUpload } from '~~/server/lib/uploads.ts'
import { badRequest } from '~~/server/lib/errors.ts'

/**
 * multipart/form-data: file (the first part of a large file, named like the file), size (the whole
 * file's bytes). Large files are sent in parts of up to 3 MB — the live server (Vercel) takes at most
 * 4.5 MB per request — then the upload form refers to them by the returned key (`upload` field).
 */
export default defineApiHandler(async (event) => {
  const user = await requireUser(event, ...SUBMITTER_TYPES)
  const parts = await readMultipartFormData(event)
  const file = parts?.find((p) => p.name === 'file' && p.filename !== undefined && p.data.length)
  if (!file) throw badRequest('Attach the first part of the file')
  const size = Number(parts?.find((p) => p.name === 'size')?.data.toString('utf8'))
  setResponseStatus(event, 201)
  return { key: await startStagedUpload(file, size, user.id) }
})
