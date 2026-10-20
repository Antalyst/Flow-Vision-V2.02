import { Office, User } from '~~/server/lib/models.ts'
import { knowledgeDto, readKnowledgeKind, resolveKnowledgeOffice, saveKnowledgeFile } from '~~/server/lib/knowledge.ts'
import { userAttrs } from '~~/server/lib/document-queries.ts'
import { audit } from '~~/server/lib/audit.ts'
import { badRequest } from '~~/server/lib/errors.ts'
import { env } from '~~/server/lib/env.ts'
import { readUploadParts } from '~~/server/lib/multipart.ts'
import * as v from '~~/server/lib/validate.ts'
import { requirePage } from '~~/server/lib/team.ts'

/**
 * Upload an AI knowledge file (ADMIN only). multipart/form-data: file, title, description,
 * office_id (empty = organization-wide), kind (GENERAL | CITIZENS_CHARTER).
 * The scope is what the admin picks — never the uploader's own office.
 */
export default defineApiHandler(async (event) => {
  const user = await requireUser(event, 'ADMIN')
  requirePage(user, '/client/settings')
  // Not h3's readMultipartFormData: it fails on files of ~108 MiB and up (see server/lib/multipart.ts).
  const parts = (await readUploadParts(event, { maxBytes: env.maxKnowledgeBytes })) ?? []
  const filePart = parts.find((p) => p.name === 'file' && p.filename !== undefined && p.data.length)
  if (!filePart) throw badRequest('Choose a file to upload')
  const fields = Object.fromEntries(parts.filter((p) => p.filename === undefined && p.name).map((p) => [p.name!, p.data.toString('utf8')]))
  const office = await resolveKnowledgeOffice(user.org_id, fields.office_id)

  const file = await saveKnowledgeFile(filePart, {
    orgId: user.org_id,
    userId: user.id,
    title: v.str(fields, 'title', { max: 255 }),
    description: v.str(fields, 'description', { max: 2000 }),
    officeId: (office?.id as string | undefined) ?? null,
    kind: readKnowledgeKind(fields.kind),
  })
  await audit(requestMeta(event), {
    action: 'KNOWLEDGE_UPLOAD',
    entityType: 'knowledge_file',
    entityId: file.id,
    after: { title: file.title, file_name: file.file_name, status: file.status, office_id: file.office_id ?? null, kind: file.kind },
  })
  await file.reload({
    attributes: { exclude: ['content'] },
    include: [
      { model: User, as: 'uploader', attributes: userAttrs },
      { model: Office, as: 'office', attributes: ['id', 'name'] },
    ],
  })
  setResponseStatus(event, 201)
  return { knowledge_file: knowledgeDto(file) }
})
