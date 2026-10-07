import { Office } from '~~/server/lib/models.ts'
import { audit } from '~~/server/lib/audit.ts'
import { readOffice } from '~~/server/lib/office-input.ts'
import { officeDto } from '~~/server/lib/serializers.ts'
import { requirePage } from '~~/server/lib/team.ts'

export default defineApiHandler(async (event) => {
  const user = await requireUser(event, 'CLIENT')
  requirePage(user, '/client/offices')
  const office = await Office.create({ ...readOffice(await readJson(event), false), org_id: user.org_id })
  await audit(requestMeta(event), { action: 'OFFICE_CREATE', entityType: 'office', entityId: office.id, after: office.toJSON() })
  setResponseStatus(event, 201)
  return { office: officeDto(office) }
})
