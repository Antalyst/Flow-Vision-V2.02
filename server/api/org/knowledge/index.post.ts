import { User } from '~~/server/lib/models.ts'
import { knowledgeDto, saveKnowledgeFile } from '~~/server/lib/knowledge.ts'
import { userAttrs } from '~~/server/lib/document-queries.ts'
import { audit } from '~~/server/lib/audit.ts'
import { badRequest } from '~~/server/lib/errors.ts'
import * as v from '~~/server/lib/validate.ts'

/**
 * Upload an AI knowledge file (CLIENT only). multipart/form-data: file, title, description.
 * Its text is extracted right away and used whenever the AI reads an uploaded document.
 */
export default defineApiHandler(async (event) => {
  const user = await requireUser(event, 'CLIENT')
  const parts = (await readMultipartFormData(event)) ?? []
  const filePart = parts.find((p) => p.name === 'file' && p.filename !== undefined && p.data.length)
  if (!filePart) throw badRequest('Choose a file to upload')
  const fields = Object.fromEntries(parts.filter((p) => p.filename === undefined && p.name).map((p) => [p.name!, p.data.toString('utf8')]))

  const file = await saveKnowledgeFile(filePart, {
    orgId: user.org_id,
    userId: user.id,
    title: v.str(fields, 'title', { max: 255 }),
    description: v.str(fields, 'description', { max: 2000 }),
  })
  await audit(requestMeta(event), { action: 'KNOWLEDGE_UPLOAD', entityType: 'knowledge_file', entityId: file.id, after: { title: file.title, file_name: file.file_name, status: file.status } })
  await file.reload({ attributes: { exclude: ['content'] }, include: [{ model: User, as: 'uploader', attributes: userAttrs }] })
  setResponseStatus(event, 201)
  return { knowledge_file: knowledgeDto(file) }
})
