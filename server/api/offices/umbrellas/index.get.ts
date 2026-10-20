import { officeDto, userSummary } from '~~/server/lib/serializers.ts'
import { requireUmbrellaManager, umbrellaRows } from '~~/server/lib/umbrellas.ts'

/** The umbrella offices of the signed-in Department Head's office, with their heads. */
export default defineApiHandler(async (event) => {
  const actor = await requireUser(event, 'DEPARTMENT_HEAD')
  const parent = requireUmbrellaManager(actor)
  const { umbrellas, heads } = await umbrellaRows(parent.id as string)
  return {
    office: officeDto(parent),
    data: umbrellas.map((u) => {
      // Several Department Heads may be assigned to one umbrella office.
      const assigned = heads.filter((h) => h.office_id === u.id && h.status !== 'inactive')
      return { ...officeDto(u)!, heads: assigned.map((h) => ({ ...userSummary(h)!, delegated: Boolean(h.assigned_by) })), head: assigned[0] ? userSummary(assigned[0]) : null }
    }),
  }
})
