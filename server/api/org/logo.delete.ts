import { Organization } from '~~/server/lib/models.ts'
import { audit } from '~~/server/lib/audit.ts'
import { requirePage } from '~~/server/lib/team.ts'
import { imageKey, removeImage } from '~~/server/lib/org-assets.ts'

/** Remove the organization logo (CLIENT only). */
export default defineApiHandler(async (event) => {
  const user = await requireUser(event, 'CLIENT')
  requirePage(user, '/client/settings')
  const org = (await Organization.findByPk(user.org_id))!
  const previous = org.logo_url
  // Only our own stored logo is cleared; an outside URL from older data is left alone.
  if (imageKey(previous)) {
    await org.update({ logo_url: null })
    await removeImage(previous)
  }
  await audit(requestMeta(event), { action: 'ORG_LOGO_DELETE', entityType: 'organization', entityId: org.id, before: { name: org.name } })
  return { ok: true }
})
