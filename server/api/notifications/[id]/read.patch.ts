import { Notification } from '~~/server/lib/models.ts'
import { notificationDto } from '~~/server/lib/serializers.ts'
import { notFound } from '~~/server/lib/errors.ts'

export default defineApiHandler(async (event) => {
  const user = await requireUser(event)
  const notification = await Notification.findOne({ where: { id: routeParam(event, 'id'), user_id: user.id } })
  if (!notification) throw notFound('Notification')
  if (!notification.is_read) await notification.update({ is_read: true, read_at: new Date() })
  return { notification: notificationDto(notification) }
})
