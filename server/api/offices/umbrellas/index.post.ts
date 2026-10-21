import { sequelize, Office, User } from '~~/server/lib/models.ts'
import { audit } from '~~/server/lib/audit.ts'
import { readOffice } from '~~/server/lib/office-input.ts'
import { withGeneratedCode } from '~~/server/lib/office-codes.ts'
import { officeDto, userSummary } from '~~/server/lib/serializers.ts'
import { applyHeadChoice, readHeadChoice, requireUmbrellaManager } from '~~/server/lib/umbrellas.ts'

/**
 * Add an umbrella office under the Department Head's office: { name, head? }. No address is asked
 * for. The code is the office's code + a suffix generated from the name (CHO + Sanitation Unit →
 * CHO-SU) unless a code is given explicitly. `head` (see umbrellas.ts readHeadChoice) moves an
 * existing delegated Department Head there or creates one; the office and its head are written
 * together, so a failure leaves neither.
 */
export default defineApiHandler(async (event) => {
  const actor = await requireUser(event, 'DEPARTMENT_HEAD')
  const parent = requireUmbrellaManager(actor)
  const body = await readJson(event)
  const { regenerate: _regenerate, ...fields } = readOffice(body, false, { parentCode: parent.code as string })
  const head = readHeadChoice(body, actor)
  const meta = requestMeta(event)

  const { umbrella, assigned } = await sequelize.transaction(async (transaction) => {
    const create = (code: string) => Office.create({ ...fields, code, org_id: actor.org_id, parent_office_id: parent.id, status: 'active' }, { transaction })
    const umbrella = typeof fields.code === 'string' ? await create(fields.code) : await withGeneratedCode(fields.name as string, parent.code as string, create, { transaction })
    const assigned = head ? await applyHeadChoice(actor, head, umbrella, meta, transaction) : null
    await audit(meta, { action: 'UMBRELLA_CREATE', entityType: 'office', entityId: umbrella.id, after: { ...(umbrella.toJSON() as Record<string, unknown>), parent_code: parent.code, head_id: assigned?.userId ?? null } }, transaction)
    return { umbrella, assigned }
  })

  setResponseStatus(event, 201)
  const headUser = assigned ? await User.findByPk(assigned.userId, { include: [{ model: Office, as: 'office' }] }) : null
  return {
    office: officeDto(umbrella),
    head: headUser ? { ...userSummary(headUser)!, email: headUser.email } : null,
    ...(assigned?.temporaryPassword && { temporary_password: assigned.temporaryPassword }),
  }
})
