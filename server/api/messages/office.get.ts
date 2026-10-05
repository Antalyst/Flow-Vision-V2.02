import { Op } from 'sequelize'
import { sequelize } from '~~/server/lib/models.ts'
import { messagePage } from '~~/server/lib/messages.ts'

/** The office channel: OFFICE messages sent by anyone currently in my office. */
export default defineApiHandler(async (event) => {
  const user = await requireOfficeUser(event)
  const fromMyOffice = sequelize.literal(`(SELECT u.office_id FROM users u WHERE u.id = messages.sender_id) = ${sequelize.escape(user.office_id)}`)
  return { data: await messagePage({ conversation_type: 'OFFICE', [Op.and]: [fromMyOffice] }, getQuery(event)) }
})
