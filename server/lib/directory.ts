import { fn, col, Op, type WhereOptions } from 'sequelize'
import { ACCOUNT_TYPES, Office, User, type Row } from './models.ts'
import { badRequest, forbidden, notFound } from './errors.ts'
import { requirePage, TEAM_PAGE } from './team.ts'
import type { Actor } from './auth.ts'

/**
 * The users browser of the team pages (office cards → users of one office). Who sees what is
 * decided here, from the signed-in account and the offices table — never from the request:
 *
 *   ADMIN            every office of the organization: each (main) office with its umbrella offices,
 *                    plus the accounts that have no office (administrators).
 *   DEPARTMENT_HEAD  their own office and its umbrella offices only (an umbrella office's head:
 *                    that umbrella office only) — the offices it manages people in (team.ts managedOfficeIds).
 *   others           nothing (403).
 *
 * An "office family" is a main office and its umbrella offices. A request names a family by its
 * main office (`office_id`, or 'none' for accounts without an office) and may narrow it to the main
 * office alone ('main') or one umbrella office (`umbrella_id`); every id is checked against the scope.
 */

export const NO_OFFICE = 'none'
export const MAIN_ONLY = 'main'

/** The main offices whose families this account may browse (DEPARTMENT_HEAD: just its own office). */
export async function directoryRoots(actor: Actor): Promise<Row[]> {
  if (actor.account_type === 'ADMIN') {
    requirePage(actor, TEAM_PAGE.ADMIN!)
    return Office.findAll({ where: { org_id: actor.org_id, parent_office_id: null }, order: [['name', 'ASC']] })
  }
  if (actor.account_type === 'DEPARTMENT_HEAD') {
    requirePage(actor, TEAM_PAGE.DEPARTMENT_HEAD!)
    const own = actor.office as Row | null
    if (!own || own.org_id !== actor.org_id) throw forbidden('Your account is not assigned to an office')
    return [own]
  }
  throw forbidden('Only administrators and Department Heads browse accounts by office')
}

/** Every office of a family: the root and (for a main office) its umbrella offices. */
export async function familyOf(root: Row) {
  const children = root.parent_office_id ? [] : await Office.findAll({ where: { parent_office_id: root.id, org_id: root.org_id }, order: [['name', 'ASC']] })
  return [root, ...children]
}

/** Accounts counted per office and role, for the office cards. */
async function countsByOffice(orgId: string, officeIds: Array<string | null>) {
  const rows = (await User.findAll({
    where: { org_id: orgId, office_id: officeIds.includes(null) ? { [Op.or]: [{ [Op.in]: officeIds.filter(Boolean) }, { [Op.is]: null }] } : { [Op.in]: officeIds } },
    attributes: ['office_id', 'account_type', [fn('COUNT', col('id')), 'n']],
    group: ['office_id', 'account_type'],
    raw: true,
  })) as unknown as Array<{ office_id: string | null; account_type: string; n: number }>
  return rows
}

type RoleCounts = Record<string, number>
const emptyCounts = (): RoleCounts => Object.fromEntries(ACCOUNT_TYPES.map((t) => [t, 0]))

/** The office cards: each family's main office, its umbrella offices, and how many accounts of each role it holds. */
export async function directoryCards(actor: Actor) {
  const roots = await directoryRoots(actor)
  const families = await Promise.all(roots.map((r) => familyOf(r)))
  const ids = families.flat().map((o) => o.id as string)
  const withUnassigned = actor.account_type === 'ADMIN'
  const counts = ids.length || withUnassigned ? await countsByOffice(actor.org_id as string, [...ids, ...(withUnassigned ? [null] : [])]) : []
  const tally = (officeIds: Array<string | null>) => {
    const byRole = emptyCounts()
    for (const r of counts) if (officeIds.includes(r.office_id)) byRole[r.account_type] = (byRole[r.account_type] ?? 0) + Number(r.n)
    return { total: Object.values(byRole).reduce((a, b) => a + b, 0), by_role: byRole }
  }
  return {
    offices: families.map(([root, ...umbrellas]) => ({
      id: root!.id as string,
      name: root!.name as string,
      code: root!.code as string,
      is_active: root!.status !== 'inactive',
      is_umbrella: Boolean(root!.parent_office_id),
      counts: tally([root!.id as string, ...umbrellas.map((u) => u.id as string)]),
      main_count: tally([root!.id as string]).total,
      umbrellas: umbrellas.map((u) => ({ id: u.id as string, name: u.name as string, code: u.code as string, is_active: u.status !== 'inactive', count: tally([u.id as string]).total })),
    })),
    unassigned: withUnassigned ? tally([null]) : null,
  }
}

export interface DirectoryQuery {
  officeId: string
  umbrellaId: string | null
  accountType: string | null
  q: string | null
  page: number
  limit: number
}

/**
 * Resolve a directory request to the office ids it may cover, or throw: a family outside the scope
 * is "not found" (no hint that it exists), an umbrella id outside the family a bad request.
 */
export async function resolveDirectoryScope(actor: Actor, query: DirectoryQuery): Promise<{ officeIds: Array<string | null>; root: Row | null }> {
  const roots = await directoryRoots(actor)
  if (query.officeId === NO_OFFICE) {
    if (actor.account_type !== 'ADMIN') throw notFound('Office')
    if (query.umbrellaId) throw badRequest('Accounts without an office have no umbrella offices', { field: 'umbrella_id' })
    return { officeIds: [null], root: null }
  }
  const root = roots.find((r) => r.id === query.officeId)
  if (!root) throw notFound('Office')
  const family = await familyOf(root)
  if (!query.umbrellaId) return { officeIds: family.map((o) => o.id as string), root }
  if (query.umbrellaId === MAIN_ONLY) return { officeIds: [root.id as string], root }
  const umbrella = family.slice(1).find((o) => o.id === query.umbrellaId)
  if (!umbrella) throw badRequest('That umbrella office is not part of this office', { field: 'umbrella_id' })
  return { officeIds: [umbrella.id as string], root }
}

/** The WHERE of a directory page: the scoped offices, then the role and search filters. */
export function directoryWhere(orgId: string, officeIds: Array<string | null>, query: DirectoryQuery): WhereOptions {
  const and: WhereOptions[] = [{ org_id: orgId }, officeIds.includes(null) ? { office_id: { [Op.is]: null } } : { office_id: { [Op.in]: officeIds } }]
  if (query.accountType) and.push({ account_type: query.accountType })
  if (query.q) and.push({ [Op.or]: ['first_name', 'last_name', 'full_name', 'email'].map((c) => ({ [c]: { [Op.like]: `%${query.q}%` } })) })
  return { [Op.and]: and }
}
