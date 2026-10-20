import { Office } from '~~/server/lib/models.ts'
import { audit } from '~~/server/lib/audit.ts'
import { readOffice } from '~~/server/lib/office-input.ts'
import { officeDto } from '~~/server/lib/serializers.ts'
import { requireUmbrellaManager } from '~~/server/lib/umbrellas.ts'

/** Add an umbrella office under the Department Head's office: { name, code, location }. Code = office code + "-" + suffix. */
export default defineApiHandler(async (event) => {
  const actor = await requireUser(event, 'DEPARTMENT_HEAD')
  const parent = requireUmbrellaManager(actor)
  const fields = readOffice(await readJson(event), false, { parentCode: parent.code as string })
  const umbrella = await Office.create({ ...fields, org_id: actor.org_id, parent_office_id: parent.id, status: 'active' })
  await audit(requestMeta(event), { action: 'UMBRELLA_CREATE', entityType: 'office', entityId: umbrella.id, after: { ...(umbrella.toJSON() as Record<string, unknown>), parent_code: parent.code } })
  setResponseStatus(event, 201)
  return { office: officeDto(umbrella) }
})
