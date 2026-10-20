import { Op } from 'sequelize'
import { Document, Issue, User } from '~~/server/lib/models.ts'
import { OFFICE_STAFF_TYPES, sendBack } from '~~/server/lib/documents.ts'
import { openableWhere } from '~~/server/lib/document-queries.ts'
import { issueIncludes, readIssueInput } from '~~/server/lib/issues.ts'
import { issueDto } from '~~/server/lib/serializers.ts'
import { notify } from '~~/server/lib/notifications.ts'
import { audit } from '~~/server/lib/audit.ts'
import { badRequest, notFound } from '~~/server/lib/errors.ts'
import * as v from '~~/server/lib/validate.ts'
import { loadDocumentFor } from '~~/server/lib/qr-access.ts'
import { requirePermission } from '~~/server/lib/dh-access.ts'

/**
 * Flag an issue and send the document back to the previous office; that office's liaisons are notified and
 * one of them claims the pickup. Body: either `issue_id` (an issue already flagged on this document) or the
 * issue to flag now (`title`, `category`, `description` — the priority follows the category); `remarks`.
 * The flagging office no longer picks a messenger (`liaison_user_id` is refused).
 */
export default defineApiHandler(async (event) => {
  const user = await requireOfficeUser(event, ...OFFICE_STAFF_TYPES)
  const documentId = routeParam(event, 'id')
  // Permission first: an account that can't send back learns nothing else here.
  requirePermission(user, 'SEND_BACK_DOCUMENTS')
  const body = await readJson(event)
  if (body.liaison_user_id) throw badRequest('The liaisons of the office it goes back to pick it up: don’t choose a messenger', { field: 'liaison_user_id' })
  const remarks = v.str(body, 'remarks', { max: 2000 })
  if (!(await Document.count({ where: { id: documentId, org_id: user.org_id, [Op.and]: [openableWhere(user)] } }))) throw notFound('Document')

  // Flag it now when no issue was flagged beforehand.
  let issueId = v.str(body, 'issue_id', { max: 36 })
  let flagged = false
  if (!issueId) {
    const input = readIssueInput(body)
    const issue = await Issue.create({ document_id: documentId, reported_by: user.id, title: input.title, description: input.description, issue_type: input.category, priority: input.priority })
    issueId = issue.id as string
    flagged = true
  }

  try {
    await sendBack(documentId, user, { issueId, remarks })
  } catch (err) {
    // Nothing was sent back: don't leave the issue flagged just now behind.
    if (flagged) await Issue.destroy({ where: { id: issueId } })
    throw err
  }

  const issue = (await Issue.findByPk(issueId, { include: issueIncludes(user.org_id) }))!
  if (flagged) {
    const admins = await User.findAll({ where: { org_id: user.org_id, account_type: 'ADMIN', status: 'active' }, attributes: ['id'] })
    await notify(
      admins.map((a) => a.id),
      { type: 'ISSUE_REPORTED', title: `Issue reported: ${issue.title}`, body: 'Document sent back to the previous office', documentId, link: '/issues' },
      { excludeUserId: user.id },
    )
    await audit(requestMeta(event), { action: 'ISSUE_CREATE', entityType: 'issue', entityId: issue.id, after: issue.toJSON() })
  }
  return { document: await loadDocumentFor(documentId, user), issue: issueDto(issue) }
})
