import { Issue, User, ISSUE_PRIORITIES, ISSUE_STATUSES } from '~~/server/lib/models.ts'
import { issueIncludes } from '~~/server/lib/issues.ts'
import { issueDto } from '~~/server/lib/serializers.ts'
import { notify } from '~~/server/lib/notifications.ts'
import { audit } from '~~/server/lib/audit.ts'
import { badRequest, forbidden, notFound } from '~~/server/lib/errors.ts'
import * as v from '~~/server/lib/validate.ts'

/** CLIENT, the reporter or the assignee can move an issue through its lifecycle. */
export default defineApiHandler(async (event) => {
  const user = await requireUser(event)
  const issue = await Issue.findByPk(routeParam(event, 'id'), { include: issueIncludes(user.org_id) })
  if (!issue) throw notFound('Issue')
  const isClient = user.account_type === 'CLIENT'
  if (!isClient && issue.reported_by !== user.id && issue.assigned_to !== user.id) {
    throw forbidden('Only the reporter, the assignee or a CLIENT can update this issue')
  }

  const body = await readJson(event)
  const before = issue.toJSON()
  const updates: Record<string, unknown> = {}
  if ('status' in body) updates.status = v.oneOf(body, 'status', ISSUE_STATUSES, { required: true })
  if ('severity' in body) updates.priority = v.oneOf(body, 'severity', ISSUE_PRIORITIES, { required: true })
  if ('resolution' in body) updates.resolution_notes = v.str(body, 'resolution', { max: 5000 })
  if ('assigned_to' in body) {
    if (!isClient) throw forbidden('Only a CLIENT can assign issues')
    if (body.assigned_to) {
      const assignee = await User.findOne({ where: { id: String(body.assigned_to), org_id: user.org_id }, attributes: ['id'] })
      if (!assignee) throw badRequest('Assignee not found')
      updates.assigned_to = assignee.id
    } else {
      updates.assigned_to = null
    }
  }
  const closing = ['RESOLVED', 'CLOSED']
  if (typeof updates.status === 'string' && closing.includes(updates.status) && !closing.includes(issue.status)) updates.resolved_at = new Date()

  await issue.update(updates)
  if (updates.assigned_to && updates.assigned_to !== before.assigned_to) {
    await notify(
      [updates.assigned_to as string],
      { type: 'ISSUE_ASSIGNED', title: `Issue assigned to you: ${issue.title}`, documentId: issue.document_id, link: '/issues' },
      { excludeUserId: user.id },
    )
  }
  await audit(requestMeta(event), { action: 'ISSUE_UPDATE', entityType: 'issue', entityId: issue.id, before, after: issue.toJSON() })
  return { issue: issueDto((await Issue.findByPk(issue.id, { include: issueIncludes(user.org_id) }))!) }
})
