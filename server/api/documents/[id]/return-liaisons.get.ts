import { Op } from 'sequelize'
import { Document, User } from '~~/server/lib/models.ts'
import { getCurrentVisit, returnLiaisons, returnTargetPreview } from '~~/server/lib/documents.ts'
import { openableWhere } from '~~/server/lib/document-queries.ts'
import { notFound } from '~~/server/lib/errors.ts'

/**
 * Where a send-back of this document goes (the previous office, or from the first office its origin) and
 * the liaisons who may fetch it, in recommended order (the uploader's own unit first). For the office
 * holding it (before and after flagging) and the admin. Names and availability only.
 */
export default defineApiHandler(async (event) => {
  const user = await requireUser(event, 'ADMIN', 'DEPARTMENT_HEAD', 'STAFF')
  const doc = await Document.findOne({ where: { id: routeParam(event, 'id'), org_id: user.org_id, [Op.and]: [openableWhere(user)] } })
  if (!doc) throw notFound('Document')
  if (user.account_type !== 'ADMIN' && user.office_id !== doc.current_office_id) throw notFound('Document')
  const visit = doc.status === 'CREATED' ? null : await getCurrentVisit(doc)
  const target = await returnTargetPreview(doc, visit)
  if (!target) return { office: null, liaisons: [] }
  const uploader = await User.findByPk(doc.submitted_by, { attributes: ['office_id'] })
  return { office: target, liaisons: await returnLiaisons(user.org_id as string, target.id, (uploader?.office_id as string | null) ?? null) }
})
