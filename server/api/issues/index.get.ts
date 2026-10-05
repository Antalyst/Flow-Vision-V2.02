import { Op } from 'sequelize'
import { Issue, ISSUE_STATUSES } from '~~/server/lib/models.ts'
import { issueIncludes } from '~~/server/lib/issues.ts'
import { issueDto } from '~~/server/lib/serializers.ts'
import * as v from '~~/server/lib/validate.ts'

export default defineApiHandler(async (event) => {
  const user = await requireUser(event)
  const query = getQuery(event)
  const where: Record<string | symbol, unknown> = {}
  const status = v.oneOf(query, 'status', ISSUE_STATUSES)
  if (status) where.status = status
  const documentId = v.q(query, 'document_id', 36)
  if (documentId) where.document_id = documentId
  if (query.mine === 'true') where[Op.or] = [{ reported_by: user.id }, { assigned_to: user.id }]

  const issues = await Issue.findAll({ where, include: issueIncludes(user.org_id), order: [['reported_at', 'DESC']], limit: 200 })
  return { data: issues.map(issueDto) }
})
