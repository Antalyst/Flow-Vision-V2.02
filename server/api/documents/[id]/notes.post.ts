import { Op } from 'sequelize'
import { Document } from '~~/server/lib/models.ts'
import { addNote } from '~~/server/lib/documents.ts'
import { openableWhere } from '~~/server/lib/document-queries.ts'
import { notFound } from '~~/server/lib/errors.ts'
import * as v from '~~/server/lib/validate.ts'

/** Notes go on the timeline of documents the person can open — nobody else's. */
export default defineApiHandler(async (event) => {
  const user = await requireUser(event)
  if (!(await Document.count({ where: { id: routeParam(event, 'id'), org_id: user.org_id, [Op.and]: [openableWhere(user)] } }))) throw notFound('Document')
  const body = await readJson(event)
  const remarks = v.reqStr(body, 'remarks', { max: 2000, label: 'Note' })
  setResponseStatus(event, 201)
  return { event: await addNote(routeParam(event, 'id'), user, remarks) }
})
