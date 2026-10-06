import { SUBMITTER_TYPES } from '~~/server/lib/documents.ts'
import { appendStagedUpload } from '~~/server/lib/uploads.ts'
import { badRequest } from '~~/server/lib/errors.ts'

/** multipart/form-data: key (from POST /uploads), index (1, 2, … in order), file (that part's bytes). */
export default defineApiHandler(async (event) => {
  const user = await requireUser(event, ...SUBMITTER_TYPES)
  const parts = await readMultipartFormData(event)
  const field = (name: string) => parts?.find((p) => p.name === name && p.filename === undefined)?.data.toString('utf8') ?? ''
  const chunk = parts?.find((p) => p.name === 'file' && p.data.length)
  const index = Number(field('index'))
  if (!chunk || !field('key') || !Number.isInteger(index) || index < 1) throw badRequest('key, index and file are required')
  return { received: await appendStagedUpload(field('key'), index, chunk.data, user.id) }
})
