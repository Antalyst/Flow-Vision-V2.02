import { sequelize, Office, User } from '~~/server/lib/models.ts'
import { audit } from '~~/server/lib/audit.ts'
import { readOffice } from '~~/server/lib/office-input.ts'
import { withGeneratedCode } from '~~/server/lib/office-codes.ts'
import { officeDto, userSummary } from '~~/server/lib/serializers.ts'
import { applyHeadChoice, findUmbrella, readHeadChoice, requireUmbrellaManager } from '~~/server/lib/umbrellas.ts'

/**
 * Edit one of the Department Head's umbrella offices: name, is_active, and optionally `head` (move a
 * delegated Department Head there or create one). The code stays as it is when the name changes;
 * `regenerate_code: true` makes a new one from the name (the office prefix stays). An address saved
 * earlier is kept; the form no longer edits it.
 */
export default defineApiHandler(async (event) => {
  const actor = await requireUser(event, 'DEPARTMENT_HEAD')
  const parent = requireUmbrellaManager(actor)
  const umbrella = await findUmbrella(actor, parent, routeParam(event, 'id'))
  const body = await readJson(event)
  const { regenerate, ...updates } = readOffice(body, true, { parentCode: parent.code as string })
  const head = readHeadChoice(body, actor)
  const meta = requestMeta(event)
  const before = umbrella.toJSON()

  const assigned = await sequelize.transaction(async (transaction) => {
    if (regenerate) {
      await withGeneratedCode((updates.name as string | undefined) ?? (umbrella.name as string), parent.code as string, (code) => umbrella.update({ ...updates, code }, { transaction }), { excludeId: umbrella.id, transaction })
    } else {
      await umbrella.update(updates, { transaction })
    }
    const assigned = head ? await applyHeadChoice(actor, head, umbrella, meta, transaction) : null
    await audit(meta, { action: 'UMBRELLA_UPDATE', entityType: 'office', entityId: umbrella.id, before, after: { ...(umbrella.toJSON() as Record<string, unknown>), ...(assigned && { head_id: assigned.userId }) } }, transaction)
    return assigned
  })

  const headUser = assigned ? await User.findByPk(assigned.userId, { include: [{ model: Office, as: 'office' }] }) : null
  return {
    office: officeDto(umbrella),
    head: headUser ? { ...userSummary(headUser)!, email: headUser.email } : null,
    ...(assigned?.temporaryPassword && { temporary_password: assigned.temporaryPassword }),
  }
})
