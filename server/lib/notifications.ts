import { Op, type Transaction } from 'sequelize'
import { Notification, User } from './models.ts'
import { emitAfterCommit } from './realtime.ts'
import type { AccountType } from './models.ts'

interface NotificationInput {
  type: string
  title: string
  body?: string | null
  documentId?: string | null
  link?: string | null
}

/**
 * Create a notification for each recipient and push it over the socket once committed.
 * `recipients` may contain duplicates or nulls; `excludeUserId` skips the actor.
 */
export async function notify(
  recipients: Array<string | null | undefined>,
  { type, title, body = null, documentId = null, link = null }: NotificationInput,
  { transaction, excludeUserId }: { transaction?: Transaction; excludeUserId?: string } = {},
) {
  const userIds = [...new Set(recipients.filter(Boolean) as string[])].filter((id) => id !== excludeUserId)
  if (!userIds.length) return

  await Notification.bulkCreate(
    userIds.map((user_id) => ({
      user_id,
      type: type.slice(0, 50),
      title: title.slice(0, 255),
      message: body ?? title, // message is NOT NULL in the schema
      document_id: documentId,
      action_url: link,
    })),
    { transaction },
  )
  const payload = { type, title, body, document_id: documentId, link, created_at: new Date().toISOString() }
  emitAfterCommit(transaction, userIds.map((id) => `user:${id}`), 'notification', payload)
}

/** Active users at an office, optionally limited to some account types. */
export async function officeMemberIds(officeId: string | null | undefined, accountTypes: AccountType[] = ['EMPLOYEE', 'STAFF'], transaction?: Transaction) {
  if (!officeId) return []
  const users = await User.findAll({
    where: { office_id: officeId, status: { [Op.ne]: 'inactive' }, account_type: { [Op.in]: accountTypes } },
    attributes: ['id'],
    transaction,
  })
  return users.map((u) => u.id as string)
}
