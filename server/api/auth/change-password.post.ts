import { User } from '~~/server/lib/models.ts'
import { hashPassword, revokeAllSessions, verifyPassword } from '~~/server/lib/auth.ts'
import { audit } from '~~/server/lib/audit.ts'
import { badRequest, tooMany } from '~~/server/lib/errors.ts'
import { isBlocked, recordFailure } from '~~/server/lib/rate-limit.ts'
import * as v from '~~/server/lib/validate.ts'

export default defineApiHandler(async (event) => {
  const user = await requireUser(event)
  const key = `password:${user.id}`
  if (isBlocked(key)) throw tooMany('Too many failed attempts — try again in a few minutes')

  const body = await readJson(event)
  const current = typeof body.current_password === 'string' ? body.current_password : ''
  const next = v.password(body, 'new_password')

  const record = (await User.scope('withPassword').findByPk(user.id))!
  if (!(await verifyPassword(current, record.password_hash))) {
    recordFailure(key)
    throw badRequest('Current password is incorrect')
  }
  if (current === next) throw badRequest('New password must be different')

  // 'pending' marks a temporary password; choosing your own activates the account.
  await record.update({ password_hash: await hashPassword(next), status: 'active' })
  await revokeAllSessions(user.id, event.context.sessionId)
  await audit(requestMeta(event), { action: 'PASSWORD_CHANGE', entityType: 'user', entityId: user.id })
  return { ok: true }
})
