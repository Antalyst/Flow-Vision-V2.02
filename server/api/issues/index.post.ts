import { Op } from 'sequelize'
import { Document, Issue, User } from '~~/server/lib/models.ts'
import { openableWhere } from '~~/server/lib/document-queries.ts'
import { issueIncludes, readIssueInput } from '~~/server/lib/issues.ts'
import { issueDto } from '~~/server/lib/serializers.ts'
import { notify } from '~~/server/lib/notifications.ts'
import { audit } from '~~/server/lib/audit.ts'
import { badRequest } from '~~/server/lib/errors.ts'

/**
 * Report an issue about a document (issues.document_id is required): { document_id, title, category,
 * description }. The priority follows the category; "Other" needs a description.
 */
export default defineApiHandler(async (event) => {
  const user = await requireUser(event)
  const body = await readJson(event)
  const { title, category, description, priority: severity } = readIssueInput(body)

  const doc = body.document_id
    ? await Document.findOne({ where: { id: String(body.document_id), org_id: user.org_id, [Op.and]: [openableWhere(user)] }, attributes: ['id'] })
    : null
  if (!doc) throw badRequest('Choose the document this issue is about', { field: 'document_id' })

  const issue = await Issue.create({ document_id: doc.id, reported_by: user.id, title, description, issue_type: category, priority: severity })

  // ADMIN accounts administer the organization, so they hear about every new issue.
  const admins = await User.findAll({ where: { org_id: user.org_id, account_type: 'ADMIN', status: 'active' }, attributes: ['id'] })
  await notify(
    admins.map((a) => a.id),
    { type: 'ISSUE_REPORTED', title: `Issue reported: ${title}`, body: `${severity} · ${category.replace(/_/g, ' ').toLowerCase()}`, documentId: doc.id, link: '/issues' },
    { excludeUserId: user.id },
  )
  await audit(requestMeta(event), { action: 'ISSUE_CREATE', entityType: 'issue', entityId: issue.id, after: issue.toJSON() })

  setResponseStatus(event, 201)
  return { issue: issueDto((await Issue.findByPk(issue.id, { include: issueIncludes(user.org_id) }))!) }
})
