import { Liaison, Office, User } from '~~/server/lib/models.ts'
import { audit } from '~~/server/lib/audit.ts'
import { notFound } from '~~/server/lib/errors.ts'
import { readOffice } from '~~/server/lib/office-input.ts'
import { officeDto } from '~~/server/lib/serializers.ts'

export default defineApiHandler(async (event) => {
  const user = await requireUser(event, 'CLIENT')
  const office = await Office.findOne({ where: { id: routeParam(event, 'id'), org_id: user.org_id } })
  if (!office) throw notFound('Office')

  const before = office.toJSON()
  const updates = readOffice(await readJson(event), true)
  await office.update(updates)

  // Liaison pickup scope follows their office's department.
  if (updates.department && updates.department !== before.department) {
    const liaisonUsers = await User.findAll({ where: { office_id: office.id, account_type: 'LIAISON' }, attributes: ['id'] })
    if (liaisonUsers.length) await Liaison.update({ department: updates.department }, { where: { user_id: liaisonUsers.map((u) => u.id) } })
  }
  await audit(requestMeta(event), { action: 'OFFICE_UPDATE', entityType: 'office', entityId: office.id, before, after: office.toJSON() })
  return { office: officeDto(office) }
})
