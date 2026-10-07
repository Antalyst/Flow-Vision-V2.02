import { Op, type WhereOptions } from 'sequelize'
import { sequelize, Document, DOCUMENT_STATUSES, PRIORITIES, User } from '~~/server/lib/models.ts'
import { badRequest } from '~~/server/lib/errors.ts'
import { defaultScope, documentAttributes, documentIncludes, scopeWhere, visibleWhere } from '~~/server/lib/document-queries.ts'
import { documentDtos } from '~~/server/lib/serializers.ts'
import * as v from '~~/server/lib/validate.ts'
import { parseRoutingDate } from '~~/server/lib/qr.ts'

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

  // Filters by role: CLIENT — the office the document is at now; EMPLOYEE — a staff member of
  // their own office (what that staff member uploaded or handled); everyone — the document type.
  const office = v.q(query, 'office', 36)
  if (office && user.account_type === 'CLIENT') and.push({ current_office_id: office })
  const staffId = v.q(query, 'staff', 36)
  if (staffId && user.account_type === 'EMPLOYEE') {
    const staff = await User.findOne({ where: { id: staffId, org_id: user.org_id, office_id: user.office_id ?? null, account_type: 'STAFF' }, attributes: ['id'] })
    if (!staff) throw badRequest('That staff member is not in your office', { field: 'staff' })
    const id = sequelize.escape(staff.id)
    and.push({
      [Op.or]: [
        { submitted_by: staff.id },
        sequelize.literal(
          `EXISTS (SELECT 1 FROM document_tracking t WHERE t.document_id = documents.id AND (t.handler_id = ${id} OR t.notes LIKE ${sequelize.escape(`%"by":"${staff.id}"%`)}))`,
        ),
      ],
    })
  }
  const type = v.q(query, 'type', 100)
  if (type) and.push({ category: type })

  // Matches the title, the QR code (or part of it), a tracking number (FV-1A2B3C4D is the start of
  // the id), or — typed as MMDDYY, the date segment of the QR code — the day it was uploaded.
  const search = v.q(query, 'q')
  if (search) {
    const idPrefix = search.replace(/^FV-?/i, '').toLowerCase()
    const qrMatch = /^[A-Z0-9-]{4,}$/i.test(search)
      ? [sequelize.literal(`EXISTS (SELECT 1 FROM qr_codes q WHERE q.document_id = documents.id AND q.qr_code_data LIKE ${sequelize.escape(`%${search.toUpperCase()}%`)})`)]
      : []
    const day = parseRoutingDate(search)
    and.push({
      [Op.or]: [
        { title: { [Op.like]: `%${search}%` } },
        ...qrMatch,
        ...(/^[0-9a-f-]{4,36}$/.test(idPrefix) ? [{ id: { [Op.like]: `${idPrefix}%` } }] : []),
        ...(day ? [{ created_at: { [Op.gte]: day.start, [Op.lt]: day.end } }] : []),
      ],
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
