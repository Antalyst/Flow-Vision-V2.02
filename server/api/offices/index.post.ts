import { Office } from '~~/server/lib/models.ts'
import { audit } from '~~/server/lib/audit.ts'
import { readOffice } from '~~/server/lib/office-input.ts'
import { officeDto } from '~~/server/lib/serializers.ts'
import { requirePage } from '~~/server/lib/team.ts'

/** Add an office (ADMIN). Umbrella offices are added by the office's Department Head (/api/offices/umbrellas). */
export default defineApiHandler(async (event) => {
  const user = await requireUser(event, 'ADMIN')
  requirePage(user, '/client/offices')
  const office = await Office.create({ ...readOffice(await readJson(event), false), org_id: user.org_id, parent_office_id: null })
  await audit(requestMeta(event), { action: 'OFFICE_CREATE', entityType: 'office', entityId: office.id, after: office.toJSON() })
  setResponseStatus(event, 201)
  return { office: officeDto(office) }
})
