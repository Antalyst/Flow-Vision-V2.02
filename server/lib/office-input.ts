import * as v from './validate.ts'
import { badRequest } from './errors.ts'
import { OFFICE_CODE_RE } from './qr.ts'

/** Map the API's office fields onto the offices table. */
export function readOffice(body: Record<string, unknown>, partial: boolean) {
  const out: Record<string, unknown> = {}
  if (!partial || 'name' in body) out.name = v.reqStr(body, 'name', { max: 255, label: 'Office name' })
  if (!partial || 'code' in body) {
    const code = v.reqStr(body, 'code', { max: 50, label: 'Office code' }).toUpperCase().replace(/\s+/g, '-')
    if (!OFFICE_CODE_RE.test(code)) throw badRequest('Office code may only use letters, digits and dashes, e.g. BAG-HR-HRMSO', { field: 'code' })
    out.code = code
  }
  // The UI still sends department_code/department_name; the schema has one department column.
  if (!partial || 'department' in body || 'department_name' in body || 'department_code' in body) {
    const dept = v.str(body, 'department', { max: 100 }) ?? v.str(body, 'department_name', { max: 100 }) ?? v.str(body, 'department_code', { max: 100 })
    if (!dept) throw badRequest('Department is required', { field: 'department' })
    out.department = dept
  }
  if (!partial || 'location' in body) out.address = v.str(body, 'location', { max: 1000 })
  if (partial && 'is_active' in body) out.status = body.is_active ? 'active' : 'inactive'
  return out
}
