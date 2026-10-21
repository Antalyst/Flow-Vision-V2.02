import { Liaison, User } from '~~/server/lib/models.ts'
import { createMember } from '~~/server/lib/members.ts'
import { officeInclude, requirePage, TEAM_PAGE } from '~~/server/lib/team.ts'
import { memberDto } from '~~/server/lib/serializers.ts'

/**
 * Invite a team member. The account starts as status 'pending' with a one-time
 * temporary password the inviter shares; it becomes 'active' when they set their own.
 * The ADMIN invites anyone; a DEPARTMENT_HEAD creates STAFF and LIAISON (messenger) accounts for their own office
 * and its umbrella offices, and the head (DEPARTMENT_HEAD) of each umbrella office; a STAFF member creates LIAISON
 * accounts for their own office. The rules live in server/lib/members.ts (shared with umbrella office creation).
 * The inviter also chooses which pages the new account may open (`page_access`, omitted = every page).
 */
export default defineApiHandler(async (event) => {
  const admin = await requireUser(event, 'ADMIN', 'DEPARTMENT_HEAD', 'STAFF')
  requirePage(admin, TEAM_PAGE[admin.account_type]!)
  const { userId, temporaryPassword } = await createMember(admin, await readJson(event), requestMeta(event))
  setResponseStatus(event, 201)
  const user = await User.findByPk(userId, { include: [officeInclude, { model: Liaison, as: 'liaisonProfile' }] })
  return { user: memberDto(user!), temporary_password: temporaryPassword }
})
