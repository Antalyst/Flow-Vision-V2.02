import { OFFICE_STAFF_TYPES, verifyScan } from '~~/server/lib/documents.ts'
import * as v from '~~/server/lib/validate.ts'

/** Dry run: tells the scanner what the scan would do (pick up / receive) before the user confirms. */
export default defineApiHandler(async (event) => {
  const user = await requireOfficeUser(event, 'LIAISON', ...OFFICE_STAFF_TYPES)
  const payload = v.reqStr(await readJson(event), 'payload', { max: 100, label: 'QR code' })
  return verifyScan(payload, user)
})
