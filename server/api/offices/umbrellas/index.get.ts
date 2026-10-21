import { Office } from '~~/server/lib/models.ts'
import { officeDto, userSummary } from '~~/server/lib/serializers.ts'
import { managedTypesOf } from '~~/server/lib/team.ts'
import { eligibleHeads, requireUmbrellaManager, umbrellaRows } from '~~/server/lib/umbrellas.ts'

/**
 * The umbrella offices of the signed-in Department Head's office, with their heads, the codes in use
 * (for the form's code preview) and — when the account may assign heads — the delegated Department
 * Heads it could make the head of one.
 */
export default defineApiHandler(async (event) => {
  const actor = await requireUser(event, 'DEPARTMENT_HEAD')
  const parent = requireUmbrellaManager(actor)
  const { umbrellas, heads } = await umbrellaRows(parent.id as string)
  const canAssignHeads = (managedTypesOf(actor) ?? []).includes('DEPARTMENT_HEAD')
  const candidates = canAssignHeads ? await eligibleHeads(actor, parent.id as string) : []
  // Every code starting with this office's prefix, so the preview skips the ones already taken.
  const codes = (await Office.findAll({ where: { parent_office_id: parent.id }, attributes: ['code'] })).map((o) => o.code as string)
  return {
    office: officeDto(parent),
    can_assign_heads: canAssignHeads,
    codes_in_use: codes,
    eligible_heads: candidates.map((u) => ({ ...userSummary(u)!, email: u.email })),
    data: umbrellas.map((u) => {
      // Several Department Heads may be assigned to one umbrella office.
      const assigned = heads.filter((h) => h.office_id === u.id && h.status !== 'inactive')
      return { ...officeDto(u)!, heads: assigned.map((h) => ({ ...userSummary(h)!, delegated: Boolean(h.assigned_by) })), head: assigned[0] ? userSummary(assigned[0]) : null }
    }),
  }
})
