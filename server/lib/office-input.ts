import * as v from './validate.ts'
import { badRequest } from './errors.ts'
import { OFFICE_CODE_RE } from './qr.ts'

export const normalizeOfficeCode = (raw: string) => raw.trim().toUpperCase().replace(/\s+/g, '-')

/**
 * Map the API's office fields onto the offices table. `parentCode`: the parent office's code, when
 * the office is an umbrella office — its code must then start with it (CHO → CHO-SNTR).
 */
export function readOffice(body: Record<string, unknown>, partial: boolean, { parentCode = null as string | null } = {}) {
  const out: Record<string, unknown> = {}
  if (!partial || 'name' in body) out.name = v.reqStr(body, 'name', { max: 255, label: 'Office name' })
  if (!partial || 'code' in body) {
    const code = normalizeOfficeCode(v.reqStr(body, 'code', { max: 50, label: 'Office code' }))
    if (!OFFICE_CODE_RE.test(code)) throw badRequest('Office code may only use letters, digits and dashes, e.g. BAG-HR-HRMSO', { field: 'code' })
    if (parentCode && !code.startsWith(`${parentCode}-`)) {
      throw badRequest(`An umbrella office's code starts with its office's code: ${parentCode}-…, e.g. ${parentCode}-SNTR`, { field: 'code' })
    }
    out.code = code
  }
  // Departments are no longer asked for. Older clients may still send one; it is kept if given.
  const dept = v.str(body, 'department', { max: 100 }) ?? v.str(body, 'department_name', { max: 100 })
  if (dept) out.department = dept
  if (!partial || 'location' in body) out.address = v.str(body, 'location', { max: 1000 })
  if (partial && 'is_active' in body) out.status = body.is_active ? 'active' : 'inactive'
  return out
}
