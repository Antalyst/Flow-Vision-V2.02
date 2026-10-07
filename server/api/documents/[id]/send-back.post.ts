import { Op } from 'sequelize'
import { Document, Issue, User, ISSUE_PRIORITIES, ISSUE_TYPES } from '~~/server/lib/models.ts'
import { OFFICE_STAFF_TYPES, sendBack } from '~~/server/lib/documents.ts'
import { loadDocumentDto, openableWhere } from '~~/server/lib/document-queries.ts'
import { issueIncludes } from '~~/server/lib/issues.ts'
import { issueDto } from '~~/server/lib/serializers.ts'
import { notify } from '~~/server/lib/notifications.ts'
import { audit } from '~~/server/lib/audit.ts'
import { notFound } from '~~/server/lib/errors.ts'
import * as v from '~~/server/lib/validate.ts'

/**
 * Flag an issue and send the document back to the previous office with one of this office's
 * messengers. Body: `liaison_user_id`, and either `issue_id` (an issue already flagged on this
 * document) or the issue to flag now (`title`, `description`, `category`, `severity`); `remarks`.
 */
export default defineApiHandler(async (event) => {
  const user = await requireOfficeUser(event, ...OFFICE_STAFF_TYPES)
  const documentId = routeParam(event, 'id')
  const body = await readJson(event)
  const liaisonUserId = v.reqStr(body, 'liaison_user_id', { max: 36, label: 'Messenger' })
  const remarks = v.str(body, 'remarks', { max: 2000 })
  if (!(await Document.count({ where: { id: documentId, org_id: user.org_id, [Op.and]: [openableWhere(user)] } }))) throw notFound('Document')

  // Flag it now when no issue was flagged beforehand.
  let issueId = v.str(body, 'issue_id', { max: 36 })
  let flagged = false
  if (!issueId) {
    const title = v.reqStr(body, 'title', { label: 'Issue' })
    const issue = await Issue.create({
      document_id: documentId,
      reported_by: user.id,
      title,
      description: v.str(body, 'description', { max: 5000 }),
      issue_type: v.oneOf(body, 'category', ISSUE_TYPES, { fallback: 'OTHER' }),
      priority: v.oneOf(body, 'severity', ISSUE_PRIORITIES, { fallback: 'MEDIUM' }),
    })
    issueId = issue.id as string
    flagged = true
  }

  try {
    await sendBack(documentId, user, { liaisonUserId, issueId, remarks })
  } catch (err) {
    // Nothing was sent back: don't leave the issue flagged just now behind.
    if (flagged) await Issue.destroy({ where: { id: issueId } })
    throw err
  }

  const issue = (await Issue.findByPk(issueId, { include: issueIncludes(user.org_id) }))!
  if (flagged) {
    const admins = await User.findAll({ where: { org_id: user.org_id, account_type: 'CLIENT', status: 'active' }, attributes: ['id'] })
    await notify(
      admins.map((a) => a.id),
      { type: 'ISSUE_REPORTED', title: `Issue reported: ${issue.title}`, body: 'Document sent back to the previous office', documentId, link: '/issues' },
      { excludeUserId: user.id },
    )
    await audit(requestMeta(event), { action: 'ISSUE_CREATE', entityType: 'issue', entityId: issue.id, after: issue.toJSON() })
  }
  return { document: await loadDocumentDto(documentId), issue: issueDto(issue) }
})
