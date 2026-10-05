import { Op } from 'sequelize'
import { Message, User } from '~~/server/lib/models.ts'
import { messagePage } from '~~/server/lib/messages.ts'
import { notFound } from '~~/server/lib/errors.ts'

export default defineApiHandler(async (event) => {
  const user = await requireUser(event)
  const partner = await User.findOne({ where: { id: routeParam(event, 'userId'), org_id: user.org_id }, attributes: ['id'] })
  if (!partner) throw notFound('User')
  const data = await messagePage(
    {
      conversation_type: 'DIRECT',
      [Op.or]: [
        { sender_id: user.id, recipient_id: partner.id },
        { sender_id: partner.id, recipient_id: user.id },
      ],
    },
    getQuery(event),
  )
  await Message.update(
    { is_read: true, read_at: new Date() },
    { where: { conversation_type: 'DIRECT', sender_id: partner.id, recipient_id: user.id, is_read: false } },
  )
  return { data }
})
