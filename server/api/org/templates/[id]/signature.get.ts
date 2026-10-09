import { DocumentTemplate } from '~~/server/lib/models.ts'
import { notFound } from '~~/server/lib/errors.ts'
import { readImage, sendImage } from '~~/server/lib/org-assets.ts'
import { SUBMITTER_TYPES } from '~~/server/lib/documents.ts'

/** A template's signature image (accounts of the organization that draft documents with the AI). */
export default defineApiHandler(async (event) => {
  const user = await requireUser(event, ...SUBMITTER_TYPES)
  const template = await DocumentTemplate.findOne({ where: { id: routeParam(event, 'id'), org_id: user.org_id }, attributes: ['signature_url'] })
  const image = await readImage(template?.signature_url)
  if (!image) throw notFound('Signature')
  return sendImage(event, image)
})
