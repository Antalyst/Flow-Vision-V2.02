import { DocumentTemplate } from '~~/server/lib/models.ts'
import { audit } from '~~/server/lib/audit.ts'
import { notFound } from '~~/server/lib/errors.ts'
import { requirePage } from '~~/server/lib/team.ts'
import { removeImage } from '~~/server/lib/org-assets.ts'
import { templateDto } from '~~/server/lib/templates.ts'

/** Remove a template's signature image (CLIENT only); the signature block keeps the name and position. */
export default defineApiHandler(async (event) => {
  const user = await requireUser(event, 'CLIENT')
  requirePage(user, '/client/settings')
  const template = await DocumentTemplate.findOne({ where: { id: routeParam(event, 'id'), org_id: user.org_id } })
  if (!template) throw notFound('Template')
  const previous = template.signature_url
  await template.update({ signature_url: null })
  await removeImage(previous)
  await audit(requestMeta(event), { action: 'TEMPLATE_UPDATE', entityType: 'document_template', entityId: template.id, after: { name: template.name, signature: 'removed' } })
  return { template: templateDto(template) }
})
