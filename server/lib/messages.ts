import { Op, type WhereOptions } from 'sequelize'
import { Message, User } from './models.ts'
import { messageDto } from './serializers.ts'

export const senderInclude = { model: User, as: 'sender', attributes: ['id', 'first_name', 'last_name', 'full_name', 'email', 'account_type', 'office_id'] }

/**
 * Newest-first page, returned oldest-first for display. Message ids are UUIDs, so the
 * cursor is `before` = an ISO timestamp.
 */
export async function messagePage(where: WhereOptions, query: Record<string, unknown>, extraInclude: any[] = []) {
  const limit = Math.min(Number(query.limit) || 50, 200)
  const before = typeof query.before === 'string' && !Number.isNaN(Date.parse(query.before)) ? new Date(query.before) : null
  const rows = await Message.findAll({
    where: { [Op.and]: [where, ...(before ? [{ created_at: { [Op.lt]: before } }] : [])] },
    include: [senderInclude, ...extraInclude],
    order: [['created_at', 'DESC']],
    limit,
  })
  return rows.reverse().map(messageDto)
}
