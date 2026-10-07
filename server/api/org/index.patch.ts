import { Organization } from '~~/server/lib/models.ts'
import { audit } from '~~/server/lib/audit.ts'
import { badRequest } from '~~/server/lib/errors.ts'
import * as v from '~~/server/lib/validate.ts'
import { requirePage } from '~~/server/lib/team.ts'

/** Organization profile (CLIENT only): name, description, website. */
export default defineApiHandler(async (event) => {
  const user = await requireUser(event, 'CLIENT')
  requirePage(user, '/client/settings')
  const body = await readJson(event)
  const org = (await Organization.findByPk(user.org_id))!
  const before = { name: org.name, description: org.description, website: org.website }
  const website = v.str(body, 'website', { max: 500, label: 'Website' })
  if (website && !/^https?:\/\/\S+$/i.test(website)) throw badRequest('Website must start with http:// or https://', { field: 'website' })
  await org.update({
    name: v.reqStr(body, 'name', { max: 255, label: 'Organization name' }),
    description: v.str(body, 'description', { max: 2000 }),
    website,
  })
  await audit(requestMeta(event), { action: 'ORG_UPDATE', entityType: 'organization', entityId: org.id, before, after: { name: org.name, description: org.description, website: org.website } })
  return { organization: { id: org.id, name: org.name, description: org.description ?? null, website: org.website ?? null } }
})
