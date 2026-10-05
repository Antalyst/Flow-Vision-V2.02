import { User } from '~~/server/lib/models.ts'
import { createSession, getDummyHash, loadActor, serializeActor, verifyPassword } from '~~/server/lib/auth.ts'
import { audit } from '~~/server/lib/audit.ts'
import { badRequest, tooMany, unauthorized } from '~~/server/lib/errors.ts'
import { isBlocked, recordFailure } from '~~/server/lib/rate-limit.ts'
import * as v from '~~/server/lib/validate.ts'

export default defineApiHandler(async (event) => {
  const meta = requestMeta(event)
  const key = `login:${meta.ip}`
  if (isBlocked(key)) throw tooMany('Too many failed attempts — try again in a few minutes')

  const body = await readJson(event)
  const email = v.email(body)
  const password = typeof body.password === 'string' ? body.password : ''
  if (!password) throw badRequest('Password is required')

  const record = await User.scope('withPassword').findOne({ where: { email } })
  const valid = await verifyPassword(password, record?.password_hash ?? (await getDummyHash()))
  if (!record || !valid) {
    recordFailure(key)
    throw unauthorized('Email or password is incorrect')
  }
  if (record.status === 'inactive') throw unauthorized('This account is suspended')

  await record.update({ last_login: new Date() })
  const user = (await loadActor(record.id))!
  const { token, expiresAt } = await createSession(user.id, meta)
  setSessionCookie(event, token, expiresAt)
  await audit({ ...meta, user }, { action: 'LOGIN', entityType: 'user', entityId: user.id })
  return { user: await serializeActor(user) }
})
