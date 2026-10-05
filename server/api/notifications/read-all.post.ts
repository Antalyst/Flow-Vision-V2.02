import { Notification } from '~~/server/lib/models.ts'

export default defineApiHandler(async (event) => {
  const user = await requireUser(event)
  const [updated] = await Notification.update({ is_read: true, read_at: new Date() }, { where: { user_id: user.id, is_read: false } })
  return { updated }
})
