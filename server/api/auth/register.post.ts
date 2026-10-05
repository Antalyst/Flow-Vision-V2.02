import { sequelize, Organization, User } from '~~/server/lib/models.ts'
import { createSession, fullNameOf, hashPassword, loadActor, serializeActor } from '~~/server/lib/auth.ts'
import { audit } from '~~/server/lib/audit.ts'
import { createDefaultDocumentTypes } from '~~/server/lib/knowledge.ts'
import { conflict, tooMany } from '~~/server/lib/errors.ts'
import { isBlocked, recordFailure } from '~~/server/lib/rate-limit.ts'
import * as v from '~~/server/lib/validate.ts'

/** Public sign-up creates a new organization with its first CLIENT (administrator) account. */
export default defineApiHandler(async (event) => {
  const meta = requestMeta(event)
  const key = `register:${meta.ip}`
  if (isBlocked(key)) throw tooMany('Too many attempts — try again in a few minutes')

  try {
    const body = await readJson(event)
    const orgName = v.reqStr(body, 'organization_name', { max: 255, label: 'Organization name' })
    const firstName = v.reqStr(body, 'first_name', { max: 100, label: 'First name' })
    const lastName = v.reqStr(body, 'last_name', { max: 100, label: 'Last name' })
    const email = v.email(body)
    const password = v.password(body)

    if (await User.count({ where: { email } })) throw conflict('An account with that email already exists', 'EMAIL_TAKEN')

    const passwordHash = await hashPassword(password)
    const userId = await sequelize.transaction(async (transaction) => {
      const org = await Organization.create({ name: orgName, status: 'active' }, { transaction })
      const user = await User.create(
        {
          org_id: org.id,
          account_type: 'CLIENT',
          email,
          password_hash: passwordHash,
          first_name: firstName,
          last_name: lastName,
          full_name: fullNameOf(firstName, lastName),
          status: 'active',
        },
        { transaction },
      )
      await org.update({ created_by: user.id }, { transaction })
      // A starting set of document types; the CLIENT edits them in Organization Settings.
      await createDefaultDocumentTypes(org.id, user.id, transaction)
      await audit(meta, { action: 'ORG_REGISTER', entityType: 'organization', entityId: org.id, userId: user.id }, transaction)
      return user.id as string
    })

    const { token, expiresAt } = await createSession(userId, meta)
    setSessionCookie(event, token, expiresAt)
    setResponseStatus(event, 201)
    return { user: await serializeActor((await loadActor(userId))!) }
  } catch (err) {
    recordFailure(key)
    throw err
  }
})
