import { Op } from 'sequelize'
import { sequelize, Liaison, Office, User } from '~~/server/lib/models.ts'
import { audit } from '~~/server/lib/audit.ts'
import { conflict, notFound } from '~~/server/lib/errors.ts'
import { readOffice } from '~~/server/lib/office-input.ts'
import { officeDto } from '~~/server/lib/serializers.ts'
import { requirePage } from '~~/server/lib/team.ts'

/**
 * Edit an office or umbrella office (ADMIN): name, code, address, active. An umbrella's code keeps
 * its office's prefix; when an office's code changes, its umbrellas' codes follow
 * (CHO-SNTR → CHOX-SNTR). Codes already printed on QR labels don't change.
 */
export default defineApiHandler(async (event) => {
  const user = await requireUser(event, 'ADMIN')
  requirePage(user, '/client/offices')
  const office = await Office.findOne({ where: { id: routeParam(event, 'id'), org_id: user.org_id }, include: [{ model: Office, as: 'parent', attributes: ['id', 'code'] }] })
  if (!office) throw notFound('Office')

  const before = office.toJSON()
  const updates = readOffice(await readJson(event), true, { parentCode: (office.parent?.code as string | undefined) ?? null })
  const codeChanged = typeof updates.code === 'string' && updates.code !== before.code

  await sequelize.transaction(async (transaction) => {
    await office.update(updates, { transaction })
    if (codeChanged && !office.parent_office_id) {
      const umbrellas = await Office.findAll({ where: { parent_office_id: office.id }, transaction })
      for (const u of umbrellas) {
        const next = `${updates.code}${String(u.code).slice(String(before.code).length)}`
        if (await Office.count({ where: { code: next, id: { [Op.ne]: u.id } }, transaction })) throw conflict(`The umbrella code ${next} is already in use`, 'DUPLICATE')
        await u.update({ code: next }, { transaction })
      }
    }
  })

  // Liaison pickup scope follows their office's department (offices created before departments were dropped).
  if (updates.department && updates.department !== before.department) {
    const liaisonUsers = await User.findAll({ where: { office_id: office.id, account_type: 'LIAISON' }, attributes: ['id'] })
    if (liaisonUsers.length) await Liaison.update({ department: updates.department }, { where: { user_id: liaisonUsers.map((u) => u.id) } })
  }
  await audit(requestMeta(event), { action: 'OFFICE_UPDATE', entityType: 'office', entityId: office.id, before, after: office.toJSON() })
  return { office: officeDto(office) }
})
