import { Op, type WhereOptions } from 'sequelize'
import { sequelize, Document, DOCUMENT_STATUSES, PRIORITIES } from '~~/server/lib/models.ts'
import { defaultScope, documentAttributes, documentIncludes, scopeWhere, visibleWhere } from '~~/server/lib/document-queries.ts'
import { documentDtos } from '~~/server/lib/serializers.ts'
import * as v from '~~/server/lib/validate.ts'

export default defineApiHandler(async (event) => {
  const user = await requireUser(event)
  const query = getQuery(event)
  const scope = v.q(query, 'scope') || defaultScope[user.account_type as keyof typeof defaultScope]
  const { limit, offset, page } = v.pagination(query)

  // A scope narrows what the account may see; it never widens it.
  const and: WhereOptions[] = [{ org_id: user.org_id }, visibleWhere(user), scopeWhere(scope, user)]
  // Once approved, a document leaves everyone's lists except its owner's (and the CLIENT
  // administrator's, who oversees the organization). It stays reachable from the activity log.
  if (user.account_type !== 'CLIENT') and.push({ [Op.or]: [{ status: { [Op.ne]: 'COMPLETED' } }, { submitted_by: user.id }] })

  const statuses = v.q(query, 'status', 200).split(',').map((s) => s.trim().toUpperCase()).filter((s) => (DOCUMENT_STATUSES as readonly string[]).includes(s))
  if (statuses.length) and.push({ status: { [Op.in]: statuses } })

  const priority = v.q(query, 'priority').toUpperCase()
  if ((PRIORITIES as readonly string[]).includes(priority)) and.push({ priority })

  // Matches the title, the QR code (or its digits), or a tracking number (FV-1A2B3C4D is the start of the id).
  const search = v.q(query, 'q')
  if (search) {
    const idPrefix = search.replace(/^FV-?/i, '').toLowerCase()
    const qrMatch = /^[A-Z0-9-]{4,}$/i.test(search)
      ? [sequelize.literal(`EXISTS (SELECT 1 FROM qr_codes q WHERE q.document_id = documents.id AND q.qr_code_data LIKE ${sequelize.escape(`%${search.toUpperCase()}%`)})`)]
      : []
    and.push({
      [Op.or]: [{ title: { [Op.like]: `%${search}%` } }, ...qrMatch, ...(/^[0-9a-f-]{4,36}$/.test(idPrefix) ? [{ id: { [Op.like]: `${idPrefix}%` } }] : [])],
    })
  }

  const { rows, count } = await Document.findAndCountAll({
    where: { [Op.and]: and },
    attributes: documentAttributes,
    include: documentIncludes,
    order: [['updated_at', 'DESC']],
    limit,
    offset,
    distinct: true,
  })
  return { data: await documentDtos(rows), meta: { page, limit, total: count, scope } }
})
