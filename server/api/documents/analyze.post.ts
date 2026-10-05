import { Organization } from '~~/server/lib/models.ts'
import { SUBMITTER_TYPES } from '~~/server/lib/documents.ts'
import { extractText, suggestDocumentDetails } from '~~/server/lib/ai.ts'
import { activeDocumentTypes, knowledgeContext } from '~~/server/lib/knowledge.ts'
import { badRequest, httpError } from '~~/server/lib/errors.ts'
import { env } from '~~/server/lib/env.ts'

/**
 * multipart/form-data: file. Reads the file with AI and suggests a title, description and type.
 * The AI classifies into the organization's own document types and is given the passages of its
 * knowledge files that match the document (Organization Settings). Nothing is saved; the
 * suggestion pre-fills the upload form and is stored when the document is created.
 */
export default defineApiHandler(async (event) => {
  const user = await requireUser(event, ...SUBMITTER_TYPES)
  const part = (await readMultipartFormData(event))?.find((p) => p.name === 'file' && p.data.length)
  if (!part) throw badRequest('Attach a file to analyze')
  if (part.data.length > env.maxUploadBytes) throw httpError(413, 'File is too large', 'PAYLOAD_TOO_LARGE')

  const text = await extractText(part.data, part.filename, part.type).catch((err) => {
    console.error('[ai] text extraction failed', err)
    return ''
  })
  if (text.length < 20) {
    throw httpError(422, 'No readable text found. Auto-fill works with PDF and Word (.docx) files that contain text.', 'NO_TEXT')
  }

  const [org, types, knowledge] = await Promise.all([
    Organization.findByPk(user.org_id, { attributes: ['name'] }),
    activeDocumentTypes(user.org_id),
    knowledgeContext(user.org_id, text),
  ])
  const suggestion = await suggestDocumentDetails(text, {
    organization: (org?.name as string) || 'a Philippine city government',
    docTypes: types.map((t) => ({ name: t.name as string, description: t.description as string | null })),
    knowledge,
  })
  // Only ever suggest one of the organization's types (or Other).
  const known = types.find((t) => String(t.name).toLowerCase() === suggestion.document_type.toLowerCase())
  return { suggestion: { ...suggestion, document_type: known ? (known.name as string) : 'Other' }, used_knowledge: knowledge.length > 0 }
})
