import { QueryTypes } from 'sequelize'
import { sequelize, Liaison } from '~~/server/lib/models.ts'
import { liaisonWorkloadSql } from '~~/server/lib/document-queries.ts'
import { liaisonDto } from '~~/server/lib/serializers.ts'
import { conflict, notFound } from '~~/server/lib/errors.ts'
import * as v from '~~/server/lib/validate.ts'

/** The schema keeps one on/off switch (`available`); BUSY is derived from assigned and carried documents. */
export default defineApiHandler(async (event) => {
  const user = await requireUser(event, 'LIAISON')
  const availability = v.oneOf(await readJson(event), 'availability', ['AVAILABLE', 'BUSY', 'OFF_DUTY'] as const, { required: true })
  const profile = await Liaison.findOne({ where: { user_id: user.id } })
  if (!profile) throw notFound('Liaison profile')

  const [row] = await sequelize.query<{ n: number }>(`SELECT ${liaisonWorkloadSql(sequelize.escape(user.id))} AS n`, { type: QueryTypes.SELECT })
  const workload = Number(row?.n ?? 0)
  // Nobody would be accountable for a document released to an off-duty messenger.
  if (availability === 'OFF_DUTY' && workload > 0) {
    throw conflict('Deliver the document you were given (or ask the office to cancel the release) before going off duty', 'MESSENGER_BUSY')
  }
  await profile.update({ available: availability !== 'OFF_DUTY' })
  return { profile: liaisonDto(profile, workload) }
})
