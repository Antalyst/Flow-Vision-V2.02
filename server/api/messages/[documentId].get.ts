import { Op } from 'sequelize'
import { openableWhere } from '~~/server/lib/document-queries.ts'
import { Document } from '~~/server/lib/models.ts'
import { messagePage } from '~~/server/lib/messages.ts'
import { notFound } from '~~/server/lib/errors.ts'

/** A document's discussion thread (conversation_type GROUP). */
export default defineApiHandler(async (event) => {
  const user = await requireUser(event)
  const doc = await Document.findOne({ where: { id: routeParam(event, 'documentId'), org_id: user.org_id, [Op.and]: [openableWhere(user)] }, attributes: ['id'] })
  if (!doc) throw notFound('Document')
  return { data: await messagePage({ conversation_type: 'GROUP', document_id: doc.id }, getQuery(event)) }
})
