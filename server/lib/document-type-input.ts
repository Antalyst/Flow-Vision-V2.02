import { Op, type Transaction } from 'sequelize'
import { DocumentType, Office } from './models.ts'
import { badRequest, conflict } from './errors.ts'

/**
 * Who a document type is for, as the ADMIN chooses it: null/'' = Global (every office, e.g. Payroll),
 * or one active office / umbrella office of the organization.
 */
export async function readTypeOffice(orgId: string, value: unknown, transaction?: Transaction) {
  if (value == null || value === '' || value === 'GLOBAL') return null
  const office = await Office.findOne({ where: { id: String(value), org_id: orgId, status: 'active' }, attributes: ['id'], transaction })
  if (!office) throw badRequest('Office not found', { field: 'office_id' })
  return office.id as string
}

/** A name may repeat across offices, but not twice for the same office (or twice as Global). */
export async function assertTypeNameFree(orgId: string, officeId: string | null, name: string, exceptId?: string, transaction?: Transaction) {
  const taken = await DocumentType.count({ where: { org_id: orgId, office_id: officeId, name, ...(exceptId && { id: { [Op.ne]: exceptId } }) }, transaction })
  if (taken) throw conflict(officeId ? `This office already has a document type called “${name}”` : `There is already a Global document type called “${name}”`, 'DUPLICATE')
}
