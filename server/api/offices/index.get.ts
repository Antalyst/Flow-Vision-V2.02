import { fn, col, literal } from 'sequelize'
import { Office, User } from '~~/server/lib/models.ts'
import { officeDto } from '~~/server/lib/serializers.ts'

/** The organization's offices and umbrella offices (each umbrella with its parent), A–Z. */
export default defineApiHandler(async (event) => {
  const user = await requireUser(event)
  const where: Record<string, unknown> = { org_id: user.org_id }
  if (getQuery(event).active !== 'all') where.status = 'active'
  const offices = await Office.findAll({
    where,
    attributes: {
      include: [
        [fn('COUNT', col('members.id')), 'member_count'],
        [literal("SUM(CASE WHEN `members`.`account_type` = 'LIAISON' AND `members`.`status` <> 'inactive' THEN 1 ELSE 0 END)"), 'messenger_count'],
      ],
    },
    include: [
      { model: User, as: 'members', attributes: [], required: false },
      { model: Office, as: 'parent', attributes: ['id', 'name', 'code'], required: false },
    ],
    group: ['offices.id', 'parent.id'],
    order: [['name', 'ASC']],
  })
  return {
    data: offices.map((o) => ({ ...officeDto(o)!, messenger_count: Number(o.get('messenger_count') ?? 0) })),
  }
})
