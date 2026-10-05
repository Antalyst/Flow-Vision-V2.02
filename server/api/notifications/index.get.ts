import { Notification } from '~~/server/lib/models.ts'
import { notificationDto } from '~~/server/lib/serializers.ts'

export default defineApiHandler(async (event) => {
  const user = await requireUser(event)
  const query = getQuery(event)
  const where: Record<string, unknown> = { user_id: user.id }
  if (query.unread === 'true') where.is_read = false
  const limit = Math.min(Number(query.limit) || 30, 100)
  const [rows, unread] = await Promise.all([
    Notification.findAll({ where, order: [['created_at', 'DESC']], limit }),
    Notification.count({ where: { user_id: user.id, is_read: false } }),
  ])
  return { data: rows.map(notificationDto), unread }
})
