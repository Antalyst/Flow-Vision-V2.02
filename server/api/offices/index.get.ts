import { fn, col } from 'sequelize'
import { Office, User } from '~~/server/lib/models.ts'
import { officeDto } from '~~/server/lib/serializers.ts'

export default defineApiHandler(async (event) => {
  const user = await requireUser(event)
  const where: Record<string, unknown> = { org_id: user.org_id }
  if (getQuery(event).active !== 'all') where.status = 'active'
  const offices = await Office.findAll({
    where,
    attributes: { include: [[fn('COUNT', col('members.id')), 'member_count']] },
    include: [{ model: User, as: 'members', attributes: [], required: false }],
    group: ['offices.id'],
    order: [['department', 'ASC'], ['name', 'ASC']],
  })
  return { data: offices.map(officeDto) }
})
