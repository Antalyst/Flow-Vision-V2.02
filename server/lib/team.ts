import type { Transaction } from 'sequelize'
import { Liaison, Office, type Row } from './models.ts'
import { badRequest } from './errors.ts'

export const officeInclude = { model: Office, as: 'office' }

/** EMPLOYEE / STAFF / LIAISON must belong to an active office in the same organization. */
export async function resolveOffice(officeId: unknown, orgId: string, accountType: string, transaction?: Transaction) {
  if (!officeId) {
    if (accountType !== 'CLIENT') throw badRequest(`${accountType} accounts must be assigned to an office`, { field: 'office_id' })
    return null
  }
  const office = await Office.findOne({ where: { id: String(officeId), org_id: orgId, status: 'active' }, transaction })
  if (!office) throw badRequest('Office not found', { field: 'office_id' })
  return office
}

/** Liaisons get a profile whose department follows their office (pickup scope). */
export async function syncLiaisonProfile(user: Row, office: Row | null, transaction?: Transaction) {
  if (user.account_type !== 'LIAISON' || !office) return
  const [profile] = await Liaison.findOrCreate({
    where: { user_id: user.id },
    defaults: { org_id: user.org_id, department: office.department ?? null, phone: user.phone ?? null },
    transaction,
  })
  if (profile.department !== office.department) await profile.update({ department: office.department ?? null }, { transaction })
}

/** Account types an EMPLOYEE can create and manage — always inside their own office. */
export const EMPLOYEE_MANAGED_TYPES = ['STAFF', 'LIAISON'] as const

/**
 * Who may manage an account: the CLIENT administrator manages everyone in the organization;
 * an EMPLOYEE manages the STAFF and LIAISON (messenger) accounts of their own office.
 */
export function canManageMember(actor: Row, member: Row) {
  if (member.org_id !== actor.org_id) return false
  if (actor.account_type === 'CLIENT') return true
  return (
    actor.account_type === 'EMPLOYEE' &&
    Boolean(actor.office_id) &&
    member.office_id === actor.office_id &&
    (EMPLOYEE_MANAGED_TYPES as readonly string[]).includes(member.account_type)
  )
}
