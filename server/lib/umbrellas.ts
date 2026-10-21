import { fn, col, Op, type Transaction } from 'sequelize'
import { Office, User, type Row } from './models.ts'
import { badRequest, forbidden, notFound } from './errors.ts'
import type { Actor, RequestMeta } from './auth.ts'
import { audit } from './audit.ts'
import { canManageMember, managedTypesOf, requirePage, TEAM_PAGE } from './team.ts'
import { cascadeToDelegates, recordAssignment, requirePermission } from './dh-access.ts'
import { createMember } from './members.ts'
import { MAIN_OFFICE_ONLY, parsePermissions } from '../../shared/dh-permissions.ts'

/**
 * Umbrella offices: divisions or units under an office (e.g. a Sanitation unit under the City Health
 * Office). Each is a full office — its own code (the office's code + a suffix, CHO-SNTR), route step,
 * QR prefix, staff and messengers — whose parent is the office. Only a Department Head of the
 * (main) office with "Manage umbrella offices" adds and edits them: the managing head always, a
 * delegated head only when granted. Any number of Department Heads may be assigned to an umbrella.
 */
export const UMBRELLA_PAGE = '/employee/umbrellas'

/** The office whose umbrellas this Department Head manages: their own, if it is a top-level, active office. */
export function requireUmbrellaManager(actor: Actor) {
  if (actor.account_type !== 'DEPARTMENT_HEAD') throw forbidden('Only an office’s Department Head manages its umbrella offices')
  requirePage(actor, UMBRELLA_PAGE)
  requirePermission(actor, 'MANAGE_UMBRELLAS')
  const office = actor.office as Row | null
  if (!office || office.org_id !== actor.org_id || office.status === 'inactive') throw forbidden('Your account is not assigned to an active office')
  if (office.parent_office_id) throw forbidden('An umbrella office can’t have umbrella offices of its own')
  return office
}

export async function findUmbrella(actor: Actor, parent: Row, id: string) {
  const umbrella = await Office.findOne({ where: { id, org_id: actor.org_id, parent_office_id: parent.id } })
  if (!umbrella) throw notFound('Umbrella office')
  return umbrella
}

/** An umbrella office with its member count and head (null while nobody heads it yet). */
export async function umbrellaRows(parentId: string) {
  const umbrellas = await Office.findAll({
    where: { parent_office_id: parentId },
    attributes: { include: [[fn('COUNT', col('members.id')), 'member_count']] },
    include: [{ model: User, as: 'members', attributes: [], required: false }],
    group: ['offices.id'],
    order: [['name', 'ASC']],
  })
  const heads = await User.findAll({
    where: { office_id: umbrellas.map((u) => u.id), account_type: 'DEPARTMENT_HEAD' },
    attributes: ['id', 'office_id', 'first_name', 'last_name', 'full_name', 'email', 'account_type', 'status', 'assigned_by'],
    order: [['created_at', 'ASC']],
  })
  return { umbrellas, heads }
}

// ---------------------------------------------------------------------------
// The Department Head of an umbrella office, chosen when it is created or edited
// ---------------------------------------------------------------------------

/**
 * `head` in an umbrella create / edit request:
 *   { mode: 'existing', user_id }                                   move a delegated Department Head there
 *   { mode: 'new', first_name, last_name, email, phone?, permissions? } create the account there (createMember)
 * Omitted or null: no change. Either way the actor needs "Assign Department Heads" and the Staff & messengers page.
 */
export type HeadChoice = { mode: 'existing'; userId: string } | { mode: 'new'; body: Record<string, unknown> }

export function readHeadChoice(body: Record<string, unknown>, actor: Actor): HeadChoice | null {
  const head = body.head as Record<string, unknown> | null | undefined
  if (head == null) return null
  if (typeof head !== 'object' || Array.isArray(head)) throw badRequest('head must be an object', { field: 'head' })
  if (!(managedTypesOf(actor) ?? []).includes('DEPARTMENT_HEAD')) {
    throw forbidden('Your account doesn’t have the “Assign Department Heads” permission. Create the umbrella office without a head, or ask the Department Head who assigned you.')
  }
  requirePage(actor, TEAM_PAGE.DEPARTMENT_HEAD!)
  if (head.mode === 'existing') {
    const userId = typeof head.user_id === 'string' ? head.user_id : ''
    if (!userId) throw badRequest('Choose the Department Head', { field: 'head.user_id' })
    return { mode: 'existing', userId }
  }
  if (head.mode === 'new') return { mode: 'new', body: head }
  throw badRequest('head.mode must be "existing" or "new"', { field: 'head.mode' })
}

/**
 * Delegated Department Heads this actor may move to an umbrella office: active, theirs to manage
 * (the same rule as the team pages), in their office or one of its umbrella offices — never a
 * managing head (who runs an office) and never the actor. `exceptOfficeId`: leave out its own heads.
 */
export async function eligibleHeads(actor: Actor, parentId: string, exceptOfficeId: string | null = null, transaction?: Transaction) {
  const family = await Office.findAll({ where: { org_id: actor.org_id, [Op.or]: [{ id: parentId }, { parent_office_id: parentId }] }, attributes: ['id'], transaction })
  const users = await User.findAll({
    where: {
      org_id: actor.org_id,
      account_type: 'DEPARTMENT_HEAD',
      assigned_by: { [Op.ne]: null },
      status: { [Op.ne]: 'inactive' },
      office_id: { [Op.in]: family.map((o) => o.id).filter((id) => id !== exceptOfficeId) },
    },
    include: [{ model: Office, as: 'office' }],
    order: [['last_name', 'ASC'], ['first_name', 'ASC']],
    transaction,
  })
  return users.filter((u) => canManageMember(actor, u))
}

/**
 * Make an existing delegated Department Head the head of `umbrella`: their office changes; what only
 * a main office's head may do is dropped (and dropped from the delegates they assigned, recorded);
 * the move is written to the assignment history and the audit log. Other heads keep their places:
 * an office may have several Department Heads.
 */
export async function moveHeadTo(actor: Actor, userId: string, umbrella: Row, meta: RequestMeta, transaction: Transaction) {
  const user = await User.findOne({ where: { id: userId, org_id: actor.org_id }, include: [{ model: Office, as: 'office' }], transaction, lock: transaction.LOCK.UPDATE })
  const eligible = user && (await eligibleHeads(actor, umbrella.parent_office_id as string, umbrella.id as string, transaction)).some((u) => u.id === user.id)
  if (!user || !eligible) {
    throw badRequest('That account can’t head this umbrella office: choose an active delegated Department Head of your office or its umbrella offices whom you manage', { field: 'head.user_id' })
  }
  const before = { ...(user.toJSON() as Record<string, unknown>), office: undefined }
  const permissions = parsePermissions(user.permissions).filter((p) => !MAIN_OFFICE_ONLY.includes(p))
  await user.update({ office_id: umbrella.id, department: umbrella.department ?? null, permissions: JSON.stringify(permissions) }, { transaction })
  await recordAssignment({ orgId: actor.org_id, userId: user.id, officeId: umbrella.id as string, action: 'UPDATED', permissions, changedBy: actor.id, note: `Made Department Head of ${umbrella.name}` }, transaction)
  await cascadeToDelegates({ id: user.id as string, name: (user.full_name as string) || 'their grantor' }, permissions, actor.id, transaction)
  await audit(meta, { action: 'USER_UPDATE', entityType: 'user', entityId: user.id, before, after: user.toJSON() }, transaction)
  return user
}

/** Apply a head choice to `umbrella` inside the caller's transaction; returns the head and, for a new account, its temporary password. */
export async function applyHeadChoice(actor: Actor, choice: HeadChoice, umbrella: Row, meta: RequestMeta, transaction: Transaction) {
  if (choice.mode === 'existing') {
    const user = await moveHeadTo(actor, choice.userId, umbrella, meta, transaction)
    return { userId: user.id as string, temporaryPassword: null as string | null }
  }
  const { userId, temporaryPassword } = await createMember(actor, { ...choice.body, account_type: 'DEPARTMENT_HEAD', office_id: umbrella.id }, meta, { transaction })
  return { userId, temporaryPassword: temporaryPassword as string | null }
}
