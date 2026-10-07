import type { Transaction } from 'sequelize'
import { Liaison, Office, type Row } from './models.ts'
import { badRequest, forbidden } from './errors.ts'
import { allPagesOf, canOpenPage, parsePageAccess, type PageRole } from '../../shared/page-access.ts'

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
/** Account types a STAFF member can create and manage — messengers of their own office. */
export const STAFF_MANAGED_TYPES = ['LIAISON'] as const

/** The account types an actor may create, or null when they manage everyone (CLIENT). */
export function managedTypesOf(actor: Row): readonly string[] | null {
  if (actor.account_type === 'CLIENT') return null
  if (actor.account_type === 'EMPLOYEE') return EMPLOYEE_MANAGED_TYPES
  if (actor.account_type === 'STAFF') return STAFF_MANAGED_TYPES
  return []
}

/** The team page each manager role works from; losing it means losing the right to manage accounts. */
export const TEAM_PAGE: Partial<Record<string, string>> = { CLIENT: '/client/accounts', EMPLOYEE: '/employee/team', STAFF: '/staff/team' }

/**
 * Who may manage an account: the CLIENT administrator manages everyone in the organization;
 * an EMPLOYEE manages the STAFF and LIAISON (messenger) accounts of their own office; a STAFF
 * member manages the messengers of their own office. A CLIENT whose own pages are limited can't
 * manage a CLIENT with unlimited pages (the owner), so access can't be taken from above.
 */
export function canManageMember(actor: Row, member: Row) {
  if (member.org_id !== actor.org_id) return false
  if (actor.account_type === 'CLIENT') {
    return !(member.account_type === 'CLIENT' && member.id !== actor.id && parsePageAccess(actor.page_access) && !parsePageAccess(member.page_access))
  }
  const types = managedTypesOf(actor) ?? []
  return Boolean(actor.office_id) && member.office_id === actor.office_id && types.includes(member.account_type)
}

/** Fails unless the actor's page access includes the page this action belongs to. */
export function requirePage(actor: Row, path: string) {
  if (!canOpenPage(actor.account_type, parsePageAccess(actor.page_access), path)) {
    throw forbidden('Your account does not have access to this page')
  }
}

/**
 * Validate `page_access` from a request body for an account of `accountType`.
 * null / omitted = every page. A manager whose own pages are limited can't grant a page of
 * their own role they don't have themselves.
 */
export function readPageAccess(body: Record<string, unknown>, accountType: string, actor: Row): string[] | null {
  const value = body.page_access
  const role = accountType as PageRole
  const grantable = new Set(allPagesOf(role))
  const actorAccess = parsePageAccess(actor.page_access)
  const actorPages = new Set(allPagesOf(actor.account_type as PageRole))
  if (value == null) {
    // "Every page" from a limited manager means every page they could grant.
    return actorAccess ? allPagesOf(role).filter((p) => !actorPages.has(p) || actorAccess.includes(p)) : null
  }
  if (!Array.isArray(value)) throw badRequest('Page access must be a list of pages', { field: 'page_access' })
  const pages = [...new Set(value.map(String))]
  for (const page of pages) {
    if (!grantable.has(page)) throw badRequest(`"${page}" is not a page a ${accountType} account can open`, { field: 'page_access' })
    if (actorAccess && actorPages.has(page) && !actorAccess.includes(page)) {
      throw forbidden(`You can't grant "${page}" because your own account doesn't have it`)
    }
  }
  // Keep the catalog order so the stored list reads the same way the sidebar does.
  return allPagesOf(role).filter((p) => pages.includes(p))
}
