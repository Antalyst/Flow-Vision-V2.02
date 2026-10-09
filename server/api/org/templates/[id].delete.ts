import { DocumentTemplate } from '~~/server/lib/models.ts'
import { audit } from '~~/server/lib/audit.ts'
import { notFound } from '~~/server/lib/errors.ts'
import { requirePage } from '~~/server/lib/team.ts'
import { removeImage } from '~~/server/lib/org-assets.ts'

/** Delete a document template and its signature image (CLIENT only). */
export default defineApiHandler(async (event) => {
  const user = await requireUser(event, 'CLIENT')
  requirePage(user, '/client/settings')
  const template = await DocumentTemplate.findOne({ where: { id: routeParam(event, 'id'), org_id: user.org_id } })
  if (!template) throw notFound('Template')
  await template.destroy()
  await removeImage(template.signature_url)
  await audit(requestMeta(event), { action: 'TEMPLATE_DELETE', entityType: 'document_template', entityId: template.id, before: { name: template.name } })
  return { ok: true }
})
