import type { Transaction } from 'sequelize'
import { DepartmentHeadAssignment, User, type Row } from './models.ts'
import { badRequest, forbidden } from './errors.ts'
import { DH_PERMISSIONS, DH_PERMISSION_META, MAIN_OFFICE_ONLY, parsePermissions, type DhPermission } from '../../shared/dh-permissions.ts'

/**
 * Server-side Department Head permissions (shared/dh-permissions.ts). The actor is always the signed-in
 * account as loaded from the database (auth.ts loadActor), never anything from the request.
 *
 *   managing Department Head   DEPARTMENT_HEAD with users.assigned_by NULL (created by the ADMIN): every permission
 *   delegated Department Head  DEPARTMENT_HEAD with users.assigned_by set: only users.permissions
 *   any other role             not limited here — its role rules apply exactly as before
 */

export const isDelegatedHead = (actor: Row | null | undefined) => actor?.account_type === 'DEPARTMENT_HEAD' && Boolean(actor.assigned_by)

/** The permissions a Department Head holds right now; null for other roles (permissions don't apply to them). */
export function effectivePermissions(actor: Row): DhPermission[] | null {
  if (actor.account_type !== 'DEPARTMENT_HEAD') return null
  if (!actor.assigned_by) return [...DH_PERMISSIONS]
  return parsePermissions(actor.permissions)
}

/** May this account do `permission`? Always true for roles other than DEPARTMENT_HEAD. */
export function hasPermission(actor: Row, permission: DhPermission) {
  const granted = effectivePermissions(actor)
  return granted === null || granted.includes(permission)
}

export function requirePermission(actor: Row, permission: DhPermission) {
  if (!hasPermission(actor, permission)) {
    throw forbidden(`Your account doesn’t have the “${DH_PERMISSION_META[permission].label}” permission. Ask the Department Head who assigned you.`)
  }
}

/**
 * Permissions a manager grants a delegated Department Head, from a request body: a list, each one the
 * manager holds themselves; "Manage umbrella offices" only for a delegate of a main office.
 * Missing = none (permissions are granted explicitly, never by default).
 */
export function readGrantedPermissions(body: Record<string, unknown>, actor: Row, targetOffice: Row | null): DhPermission[] {
  const value = body.permissions
  if (value == null) return []
  if (!Array.isArray(value)) throw badRequest('Permissions must be a list', { field: 'permissions' })
  const own = effectivePermissions(actor) ?? [...DH_PERMISSIONS] // the ADMIN may grant any
  const out: DhPermission[] = []
  for (const raw of new Set(value.map(String))) {
    if (!(DH_PERMISSIONS as readonly string[]).includes(raw)) throw badRequest(`Unknown permission “${raw}”`, { field: 'permissions' })
    const p = raw as DhPermission
    if (!own.includes(p)) throw forbidden(`You can’t grant “${DH_PERMISSION_META[p].label}” because your own account doesn’t have it`)
    if (MAIN_OFFICE_ONLY.includes(p) && targetOffice?.parent_office_id) {
      throw badRequest(`“${DH_PERMISSION_META[p].label}” can only be granted to a Department Head of a main office`, { field: 'permissions' })
    }
    out.push(p)
  }
  return DH_PERMISSIONS.filter((p) => out.includes(p))
}

/** Append one entry to the assignment history (who, when, what). Never updated or deleted. */
export function recordAssignment(
  entry: { orgId: string; userId: string; officeId: string | null; action: 'ASSIGNED' | 'UPDATED' | 'REVOKED' | 'REINSTATED'; permissions: DhPermission[] | null; changedBy: string; note?: string | null },
  transaction?: Transaction,
) {
  return DepartmentHeadAssignment.create(
    {
      org_id: entry.orgId,
      user_id: entry.userId,
      office_id: entry.officeId,
      action: entry.action,
      permissions: entry.permissions ? JSON.stringify(entry.permissions) : null,
      changed_by: entry.changedBy,
      note: entry.note?.slice(0, 500) ?? null,
      created_at: new Date(),
    },
    { transaction },
  )
}

/**
 * Least privilege down the chain: a delegate never holds more than the Department Head who assigned
 * it holds now. When `grantorId`'s permissions shrink to `grantorPermissions` (or it is no longer a
 * Department Head: pass []), every delegate it assigned loses what the grantor lost, and so on down —
 * each change written to the history with a note. Suspension is not a reduction: it is enforced at sign-in
 * and keeps the assignments for when the account is reinstated. Returns how many delegates changed.
 */
export async function cascadeToDelegates(
  grantor: { id: string; name: string },
  grantorPermissions: DhPermission[],
  changedBy: string,
  transaction?: Transaction,
  depth = 0,
): Promise<number> {
  if (depth > 25) return 0 // a chain can't loop (no one assigns their own grantor), but never recurse forever
  const delegates = await User.findAll({
    where: { assigned_by: grantor.id, account_type: 'DEPARTMENT_HEAD' },
    attributes: ['id', 'org_id', 'office_id', 'first_name', 'last_name', 'full_name', 'permissions'],
    transaction,
    ...(transaction && { lock: transaction.LOCK.UPDATE }),
  })
  let changed = 0
  for (const d of delegates) {
    const current = parsePermissions(d.permissions)
    const next = current.filter((p) => grantorPermissions.includes(p))
    if (next.length === current.length) continue
    const removed = current.filter((p) => !next.includes(p)).map((p) => DH_PERMISSION_META[p].label)
    await d.update({ permissions: JSON.stringify(next) }, { transaction })
    await recordAssignment(
      {
        orgId: d.org_id as string,
        userId: d.id as string,
        officeId: (d.office_id as string | null) ?? null,
        action: 'UPDATED',
        permissions: next,
        changedBy,
        note: `Removed automatically because ${grantor.name}, who assigned this account, no longer has: ${removed.join(', ')}`,
      },
      transaction,
    )
    changed += 1 + (await cascadeToDelegates({ id: d.id as string, name: (d.full_name as string) || 'a delegate' }, next, changedBy, transaction, depth + 1))
  }
  return changed
}
