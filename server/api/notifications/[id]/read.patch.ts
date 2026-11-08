import { Notification } from '~~/server/lib/models.ts'
import { notificationDto } from '~~/server/lib/serializers.ts'
import { notFound } from '~~/server/lib/errors.ts'
import { emit } from '~~/server/lib/realtime.ts'

export default defineApiHandler(async (event) => {
  const user = await requireUser(event)
  const notification = await Notification.findOne({ where: { id: routeParam(event, 'id'), user_id: user.id } })
  if (!notification) throw notFound('Notification')
  const changed = !notification.is_read
  if (changed) await notification.update({ is_read: true, read_at: new Date() })
  // The account's unread total after this, for the caller's badge (never a client-side guess).
  const unread = await Notification.count({ where: { user_id: user.id, is_read: false } })
  // The account's other tabs and devices update their badge and unread list from the database.
  if (changed) emit(`user:${user.id}`, 'notifications:changed', { unread })
  return { notification: notificationDto(notification), unread }
})
