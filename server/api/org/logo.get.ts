import { Organization } from '~~/server/lib/models.ts'
import { notFound } from '~~/server/lib/errors.ts'
import { readImage, sendImage } from '~~/server/lib/org-assets.ts'

/** The organization's logo (any account of the organization: it is printed on QR labels and letterheads). */
export default defineApiHandler(async (event) => {
  const user = await requireUser(event)
  const org = await Organization.findByPk(user.org_id, { attributes: ['logo_url'] })
  const image = await readImage(org?.logo_url)
  if (!image) throw notFound('Logo')
  return sendImage(event, image)
})
