import { addNote } from '~~/server/lib/documents.ts'
import * as v from '~~/server/lib/validate.ts'

export default defineApiHandler(async (event) => {
  const user = await requireUser(event)
  const body = await readJson(event)
  const remarks = v.reqStr(body, 'remarks', { max: 2000, label: 'Note' })
  setResponseStatus(event, 201)
  return { event: await addNote(routeParam(event, 'id'), user, remarks) }
})
