import { Office } from '~~/server/lib/models.ts'
import { audit } from '~~/server/lib/audit.ts'
import { readOffice } from '~~/server/lib/office-input.ts'
import { withGeneratedCode } from '~~/server/lib/office-codes.ts'
import { officeDto } from '~~/server/lib/serializers.ts'
import { requirePage } from '~~/server/lib/team.ts'

/**
 * Add an office (ADMIN): { name, location }. The code is generated from the name (HR, CPO …) unless
 * one is given explicitly. Umbrella offices are added by the office's Department Head (/api/offices/umbrellas).
 */
export default defineApiHandler(async (event) => {
  const user = await requireUser(event, 'ADMIN')
  requirePage(user, '/client/offices')
  const { regenerate: _regenerate, ...fields } = readOffice(await readJson(event), false)
  const create = (code: string) => Office.create({ ...fields, code, org_id: user.org_id, parent_office_id: null })
  const office = typeof fields.code === 'string' ? await create(fields.code) : await withGeneratedCode(fields.name as string, null, create)
  await audit(requestMeta(event), { action: 'OFFICE_CREATE', entityType: 'office', entityId: office.id, after: office.toJSON() })
  setResponseStatus(event, 201)
  return { office: officeDto(office) }
})
