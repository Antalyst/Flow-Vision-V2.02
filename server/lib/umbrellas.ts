import { fn, col } from 'sequelize'
import { Office, User, type Row } from './models.ts'
import { forbidden, notFound } from './errors.ts'
import type { Actor } from './auth.ts'
import { requirePage } from './team.ts'
import { requirePermission } from './dh-access.ts'

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
