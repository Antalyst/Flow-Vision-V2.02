import { User } from '~~/server/lib/models.ts'
import { generateTempPassword, hashPassword, revokeAllSessions } from '~~/server/lib/auth.ts'
import { audit } from '~~/server/lib/audit.ts'
import { notFound } from '~~/server/lib/errors.ts'
import { canManageMember, requirePage, TEAM_PAGE } from '~~/server/lib/team.ts'

export default defineApiHandler(async (event) => {
  const admin = await requireUser(event, 'CLIENT', 'EMPLOYEE', 'STAFF')
  requirePage(admin, TEAM_PAGE[admin.account_type]!)
  const user = await User.findOne({ where: { id: routeParam(event, 'id'), org_id: admin.org_id } })
  if (!user || !canManageMember(admin, user)) throw notFound('User')
  const tempPassword = generateTempPassword()
  // Back to 'pending' (temporary password) unless the account is suspended.
  await user.update({ password_hash: await hashPassword(tempPassword), status: user.status === 'inactive' ? 'inactive' : 'pending' })
  await revokeAllSessions(user.id)
  await audit(requestMeta(event), { action: 'USER_PASSWORD_RESET', entityType: 'user', entityId: user.id })
  return { temporary_password: tempPassword }
})
