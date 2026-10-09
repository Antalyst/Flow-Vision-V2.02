import { DocumentTemplate } from '~~/server/lib/models.ts'
import { audit } from '~~/server/lib/audit.ts'
import { notFound } from '~~/server/lib/errors.ts'
import { requirePage } from '~~/server/lib/team.ts'
import { readImagePart, removeImage, saveImage } from '~~/server/lib/org-assets.ts'
import { templateDto } from '~~/server/lib/templates.ts'

/** Upload a template's signature image (CLIENT only). multipart/form-data: file (PNG or JPG, up to 2 MB). */
export default defineApiHandler(async (event) => {
  const user = await requireUser(event, 'CLIENT')
  requirePage(user, '/client/settings')
  const template = await DocumentTemplate.findOne({ where: { id: routeParam(event, 'id'), org_id: user.org_id } })
  if (!template) throw notFound('Template')
  const part = await readImagePart(event)
  const key = await saveImage('templates', 'signature', part.data)
  const previous = template.signature_url
  try {
    await template.update({ signature_url: key })
  } catch (err) {
    await removeImage(key)
    throw err
  }
  await removeImage(previous)
  await audit(requestMeta(event), { action: 'TEMPLATE_UPDATE', entityType: 'document_template', entityId: template.id, after: { name: template.name, signature: 'uploaded' } })
  setResponseStatus(event, 201)
  return { template: templateDto(template) }
})
