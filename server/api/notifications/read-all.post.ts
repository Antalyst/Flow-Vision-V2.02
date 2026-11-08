import { Notification } from '~~/server/lib/models.ts'
import { emit } from '~~/server/lib/realtime.ts'

export default defineApiHandler(async (event) => {
  const user = await requireUser(event)
  const [updated] = await Notification.update({ is_read: true, read_at: new Date() }, { where: { user_id: user.id, is_read: false } })
  // The account's other tabs and devices clear their badge and unread list.
  if (updated) emit(`user:${user.id}`, 'notifications:changed', { unread: 0 })
  return { updated }
})
