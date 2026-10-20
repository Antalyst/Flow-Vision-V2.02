import { Op } from 'sequelize'
import { Document, Issue, ISSUE_STATUSES } from '~~/server/lib/models.ts'
import { openableWhere } from '~~/server/lib/document-queries.ts'
import { issueIncludes } from '~~/server/lib/issues.ts'
import { issueDto } from '~~/server/lib/serializers.ts'
import * as v from '~~/server/lib/validate.ts'

/**
 * Issues, newest first. Query: `status`, `document_id`, `mine=true`, `q` (title, description, the
 * document's title or tracking number, the reporter's name).
 * The ADMIN sees every issue of the organization; everyone else only issues about documents they may
 * open, plus the ones they reported or were assigned.
 */
export default defineApiHandler(async (event) => {
  const user = await requireUser(event)
  const query = getQuery(event)
  const and: Record<string | symbol, unknown>[] = []
  const status = v.oneOf(query, 'status', ISSUE_STATUSES)
  if (status) and.push({ status })
  const documentId = v.q(query, 'document_id', 36)
  if (documentId) and.push({ document_id: documentId })
  if (query.mine === 'true') and.push({ [Op.or]: [{ reported_by: user.id }, { assigned_to: user.id }] })

  if (user.account_type !== 'ADMIN') {
    // openableWhere is written against the `documents` table, so resolve it to ids first.
    const openable = await Document.findAll({ where: { org_id: user.org_id, [Op.and]: [openableWhere(user)] }, attributes: ['id'], raw: true })
    and.push({ [Op.or]: [{ document_id: { [Op.in]: openable.map((d) => d.id as string) } }, { reported_by: user.id }, { assigned_to: user.id }] })
  }

  const search = v.q(query, 'q')
  if (search) {
    const like = `%${search.replace(/[\\%_]/g, (c) => `\\${c}`)}%`
    const idPrefix = search.replace(/^FV-?/i, '').toLowerCase()
    and.push({
      [Op.or]: [
        { title: { [Op.like]: like } },
        { description: { [Op.like]: like } },
        { '$document.title$': { [Op.like]: like } },
        { '$reporter.full_name$': { [Op.like]: like } },
        ...(/^[0-9a-f-]{4,36}$/.test(idPrefix) ? [{ document_id: { [Op.like]: `${idPrefix}%` } }] : []),
      ],
    })
  }

  const issues = await Issue.findAll({
    where: { [Op.and]: and },
    include: issueIncludes(user.org_id),
    order: [['reported_at', 'DESC']],
    limit: 200,
    // The search reaches into the joined document and reporter.
    subQuery: false,
  })
  return { data: issues.map(issueDto) }
})
