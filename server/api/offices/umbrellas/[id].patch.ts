import { audit } from '~~/server/lib/audit.ts'
import { readOffice } from '~~/server/lib/office-input.ts'
import { officeDto } from '~~/server/lib/serializers.ts'
import { findUmbrella, requireUmbrellaManager } from '~~/server/lib/umbrellas.ts'

/** Edit one of the Department Head's umbrella offices: name, code (keeps the office prefix), location, is_active. */
export default defineApiHandler(async (event) => {
  const actor = await requireUser(event, 'DEPARTMENT_HEAD')
  const parent = requireUmbrellaManager(actor)
  const umbrella = await findUmbrella(actor, parent, routeParam(event, 'id'))
  const before = umbrella.toJSON()
  await umbrella.update(readOffice(await readJson(event), true, { parentCode: parent.code as string }))
  await audit(requestMeta(event), { action: 'UMBRELLA_UPDATE', entityType: 'office', entityId: umbrella.id, before, after: umbrella.toJSON() })
  return { office: officeDto(umbrella) }
})
