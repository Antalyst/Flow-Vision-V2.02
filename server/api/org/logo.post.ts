import { Organization } from '~~/server/lib/models.ts'
import { audit } from '~~/server/lib/audit.ts'
import { requirePage } from '~~/server/lib/team.ts'
import { imageVersion, readImagePart, removeImage, saveImage } from '~~/server/lib/org-assets.ts'

/**
 * Upload the organization logo (CLIENT only). multipart/form-data: file (PNG or JPG, up to 2 MB).
 * It goes on every QR label and on the letterhead of document templates.
 */
export default defineApiHandler(async (event) => {
  const user = await requireUser(event, 'CLIENT')
  requirePage(user, '/client/settings')
  const part = await readImagePart(event)
  const key = await saveImage('org', 'logo', part.data)
  const org = (await Organization.findByPk(user.org_id))!
  const previous = org.logo_url
  try {
    await org.update({ logo_url: key })
  } catch (err) {
    await removeImage(key)
    throw err
  }
  await removeImage(previous)
  await audit(requestMeta(event), { action: 'ORG_LOGO_UPDATE', entityType: 'organization', entityId: org.id, after: { name: org.name } })
  setResponseStatus(event, 201)
  return { logo_url: `/api/org/logo?v=${imageVersion(key)}` }
})
