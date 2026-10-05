import fs from 'node:fs'
import { KnowledgeFile } from '~~/server/lib/models.ts'
import { knowledgePath } from '~~/server/lib/knowledge.ts'
import { notFound } from '~~/server/lib/errors.ts'

/** Download a knowledge file (CLIENT only). */
export default defineApiHandler(async (event) => {
  const user = await requireUser(event, 'CLIENT')
  const file = await KnowledgeFile.findOne({ where: { id: routeParam(event, 'id'), org_id: user.org_id }, attributes: ['file_url', 'file_name', 'file_type'] })
  const filePath = knowledgePath(file?.file_url)
  if (!file || !filePath || !fs.existsSync(filePath)) throw notFound('Knowledge file')
  setResponseHeaders(event, {
    'Content-Type': file.file_type || 'application/octet-stream',
    'Content-Disposition': `attachment; filename*=UTF-8''${encodeURIComponent(file.file_name)}`,
    'Cache-Control': 'private, no-store',
  })
  return sendStream(event, fs.createReadStream(filePath))
})
