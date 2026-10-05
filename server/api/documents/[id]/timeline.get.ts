import { Op } from 'sequelize'
import { openableWhere } from '~~/server/lib/document-queries.ts'
import { Document } from '~~/server/lib/models.ts'
import { documentTimeline } from '~~/server/lib/documents.ts'
import { notFound } from '~~/server/lib/errors.ts'

export default defineApiHandler(async (event) => {
  const user = await requireUser(event)
  const doc = await Document.findOne({ where: { id: routeParam(event, 'id'), org_id: user.org_id, [Op.and]: [openableWhere(user)] } })
  if (!doc) throw notFound('Document')
  return { data: await documentTimeline(doc) }
})
