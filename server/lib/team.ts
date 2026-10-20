import type { Transaction } from 'sequelize'
import { Liaison, Office, type Row } from './models.ts'
import { badRequest, forbidden } from './errors.ts'
import { hasPermission, isDelegatedHead } from './dh-access.ts'
import { allPagesOf, canOpenPage, parsePageAccess, type PageRole } from '../../shared/page-access.ts'

export const officeInclude = { model: Office, as: 'office' }

/** DEPARTMENT_HEAD / STAFF / LIAISON must belong to an active office in the same organization. */
export async function resolveOffice(officeId: unknown, orgId: string, accountType: string, transaction?: Transaction) {
  if (!officeId) {
    if (accountType !== 'ADMIN') throw badRequest(`${accountType} accounts must be assigned to an office`, { field: 'office_id' })
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

/** Account types a DEPARTMENT_HEAD may manage: STAFF and LIAISON (with "Manage staff and messengers"), delegated DEPARTMENT_HEADs (with "Assign Department Heads"). */
export const DEPARTMENT_HEAD_MANAGED_TYPES = ['STAFF', 'LIAISON', 'DEPARTMENT_HEAD'] as const
/** Account types a STAFF member can create and manage — messengers of their own office. */
export const STAFF_MANAGED_TYPES = ['LIAISON'] as const

/**
 * The account types an actor may create, or null when they manage everyone (ADMIN). A managing
 * Department Head has all three; a delegated one only what its permissions allow.
 */
export function managedTypesOf(actor: Row): readonly string[] | null {
  if (actor.account_type === 'ADMIN') return null
  if (actor.account_type === 'DEPARTMENT_HEAD') {
    return DEPARTMENT_HEAD_MANAGED_TYPES.filter((t) => hasPermission(actor, t === 'DEPARTMENT_HEAD' ? 'ASSIGN_HEADS' : 'MANAGE_TEAM'))
  }
  if (actor.account_type === 'STAFF') return STAFF_MANAGED_TYPES
  return []
}

/** The team page each manager role works from; losing it means losing the right to manage accounts. */
export const TEAM_PAGE: Partial<Record<string, string>> = { ADMIN: '/client/accounts', DEPARTMENT_HEAD: '/employee/team', STAFF: '/staff/team' }

/** Is `member` (with `office` loaded) in the actor's own office or one of its umbrella offices? */
const inFamily = (actor: Row, member: Row) =>
  Boolean(actor.office_id) && (member.office_id === actor.office_id || (Boolean(member.office?.parent_office_id) && member.office.parent_office_id === actor.office_id))

/**
 * Who may manage an account (member.office must be loaded):
 *   ADMIN            everyone in the organization (a page-limited ADMIN not an unlimited one, the owner)
 *   DEPARTMENT_HEAD  STAFF and LIAISON of their office and its umbrella offices ("Manage staff and
 *                    messengers"); delegated Department Heads there ("Assign Department Heads") — a
 *                    delegated head only the delegates it assigned itself. Never a managing
 *                    Department Head, and never itself.
 *   STAFF            the messengers of their own office
 */
export function canManageMember(actor: Row, member: Row) {
  if (member.org_id !== actor.org_id) return false
  if (actor.account_type === 'ADMIN') {
    return !(member.account_type === 'ADMIN' && member.id !== actor.id && parsePageAccess(actor.page_access) && !parsePageAccess(member.page_access))
  }
  const types = managedTypesOf(actor) ?? []
  if (!actor.office_id || member.id === actor.id || !types.includes(member.account_type)) return false
  if (actor.account_type === 'STAFF') return member.office_id === actor.office_id
  if (!inFamily(actor, member)) return false
  if (member.account_type === 'DEPARTMENT_HEAD') {
    if (!member.assigned_by) return false
    return isDelegatedHead(actor) ? member.assigned_by === actor.id : true
  }
  return true
}

/** The offices a manager places accounts in: their own office and its umbrella offices. */
export async function managedOfficeIds(actor: Row, transaction?: Transaction) {
  if (!actor.office_id) return []
  const umbrellas = await Office.findAll({ where: { parent_office_id: actor.office_id, org_id: actor.org_id }, attributes: ['id'], transaction })
  return [actor.office_id as string, ...umbrellas.map((u) => u.id as string)]
}

/**
 * Where a DEPARTMENT_HEAD / STAFF manager may put an account of `accountType`: their own office, or
 * (DEPARTMENT_HEAD) one of its umbrella offices. Any number of delegated Department Heads may be
 * assigned to an office or umbrella office.
 */
export async function assertManagerPlacement(actor: Row, accountType: string, office: Row | null) {
  if (!office) throw badRequest('Choose the office', { field: 'office_id' })
  const own = office.id === actor.office_id
  const umbrella = office.parent_office_id === actor.office_id && actor.account_type === 'DEPARTMENT_HEAD'
  if (!own && !umbrella) throw forbidden('You can only add people to your own office or its umbrella offices')
  if (!(managedTypesOf(actor) ?? []).includes(accountType)) throw forbidden('Your account doesn’t have the permission to add this kind of account')
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
