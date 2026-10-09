import { Organization } from '~~/server/lib/models.ts'
import { imageKey, imageVersion } from '~~/server/lib/org-assets.ts'
import { listTemplates, templateDto } from '~~/server/lib/templates.ts'
import { SUBMITTER_TYPES } from '~~/server/lib/documents.ts'

/**
 * The organization's active document templates, with its name and logo — what the AI Assistant's
 * canvas lays a drafted document out on (any account that uploads documents).
 */
export default defineApiHandler(async (event) => {
  const user = await requireUser(event, ...SUBMITTER_TYPES)
  const [org, templates] = await Promise.all([Organization.findByPk(user.org_id, { attributes: ['name', 'logo_url'] }), listTemplates(user.org_id, { activeOnly: true })])
  return {
    organization: { name: org?.name ?? '', logo_url: imageKey(org?.logo_url) ? `/api/org/logo?v=${imageVersion(org?.logo_url)}` : null },
    templates: templates.map(templateDto),
  }
})
