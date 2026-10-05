import { Op, type WhereOptions } from 'sequelize'
import { sequelize, Document, Office, User } from './models.ts'
import { badRequest } from './errors.ts'
import { AT_OFFICE, CARRYING, documentDtoOne } from './serializers.ts'
import type { Actor } from './auth.ts'
import type { AccountType } from './models.ts'

export const userAttrs = ['id', 'first_name', 'last_name', 'full_name', 'email', 'account_type']

/** A column of the document's current visit (latest document_tracking row for its current step). */
export const currentVisit = (column: string, doc = 'documents') =>
  `(SELECT t.${column} FROM document_tracking t WHERE t.document_id = ${doc}.id AND t.step_number = ${doc}.current_step_number ORDER BY t.created_at DESC LIMIT 1)`

// Computed per row so lists can show progress, destination, SLA and visit state without extra round trips.
export const documentAttributes: any = {
  include: [
    [sequelize.literal('(SELECT COUNT(*) FROM route_steps rs WHERE rs.route_id = documents.route_id)'), 'total_steps'],
    [sequelize.literal('(SELECT r.name FROM organization_routes r WHERE r.id = documents.route_id)'), 'route_name'],
    [
      sequelize.literal(
        '(SELECT o.name FROM route_steps rs JOIN offices o ON o.id = rs.office_id WHERE rs.route_id = documents.route_id AND rs.step_number = documents.current_step_number + 1)',
      ),
      'next_office_name',
    ],
    [sequelize.literal('(SELECT COALESCE(rs.sla_days, 0) * 24 + rs.sla_hours FROM route_steps rs WHERE rs.route_id = documents.route_id AND rs.step_number = documents.current_step_number)'), 'step_sla_hours'],
    [sequelize.literal(currentVisit('handler_id')), 'visit_handler_id'],
    [sequelize.literal(currentVisit('liaison_id')), 'visit_liaison_id'],
    [sequelize.literal(currentVisit('arrived_at')), 'visit_arrived_at'],
    [sequelize.literal(currentVisit('updated_at')), 'visit_updated_at'],
    [sequelize.literal('(SELECT q.qr_code_data FROM qr_codes q WHERE q.document_id = documents.id)'), 'qr_code'],
    // Origin = where the uploader belongs: their assigned office, or (CLIENT, no office) the organization.
    [sequelize.literal('(SELECT o.id FROM users u JOIN offices o ON o.id = u.office_id WHERE u.id = documents.submitted_by)'), 'origin_office_id'],
    [sequelize.literal('(SELECT o.name FROM users u JOIN offices o ON o.id = u.office_id WHERE u.id = documents.submitted_by)'), 'origin_office_name'],
    [sequelize.literal('(SELECT g.name FROM organizations g WHERE g.id = documents.org_id)'), 'org_name'],
  ],
}

export const documentIncludes = [
  { model: Office, as: 'currentOffice' },
  { model: User, as: 'submitter', attributes: userAttrs },
]

/** Reload a document in its API shape (after a workflow command). */
export async function loadDocumentDto(id: string) {
  const doc = await Document.findByPk(id, { attributes: documentAttributes, include: documentIncludes })
  return doc ? documentDtoOne(doc) : null
}

const lit = (sql: string) => sequelize.literal(sql)
const esc = (value: string) => sequelize.escape(value)

/** Documents travelling towards `officeId` (destination = the step after the current one). */
export const incomingTo = (officeId: string) =>
  lit(`EXISTS (SELECT 1 FROM route_steps rs WHERE rs.route_id = documents.route_id AND rs.step_number = documents.current_step_number + 1 AND rs.office_id = ${esc(officeId)})`)

// A document waiting at an office has an open pickup once it is released to a messenger.
export const hasOpenPickup = () => lit(`${currentVisit('liaison_id')} IS NOT NULL`)
export const noOpenPickup = () => lit(`${currentVisit('liaison_id')} IS NULL`)
export const isReceived = () => lit(`${currentVisit('handler_id')} IS NOT NULL`)
export const notReceived = () => lit(`${currentVisit('handler_id')} IS NULL`)
export const carriedBy = (userId: string) => lit(`${currentVisit('liaison_id')} = ${esc(userId)}`)
export const atFinalStep = () =>
  lit('(SELECT rs.is_final_checkpoint FROM route_steps rs WHERE rs.route_id = documents.route_id AND rs.step_number = documents.current_step_number) = 1')

/** Documents released to this messenger and waiting at an office for them to pick up. */
export function pickupsWhere(actor: Actor): WhereOptions {
  return { status: { [Op.in]: AT_OFFICE }, [Op.and]: [carriedBy(actor.id)] }
}

/**
 * SQL: how many documents a messenger has work on — released to them and waiting for pickup,
 * or being carried. A messenger with any is busy and can't be given another one.
 */
export const liaisonWorkloadSql = (userIdSql: string) =>
  `(SELECT COUNT(*) FROM documents d WHERE d.status IN (${[...AT_OFFICE, ...CARRYING].map((s) => `'${s}'`).join(',')}) AND ${currentVisit('liaison_id', 'd')} = ${userIdSql})`

export const DOCUMENT_SCOPES = ['all', 'mine', 'team', 'visited', 'office', 'incoming', 'carrying', 'pickups'] as const
export const defaultScope: Record<AccountType, (typeof DOCUMENT_SCOPES)[number]> = { CLIENT: 'all', EMPLOYEE: 'office', STAFF: 'mine', LIAISON: 'carrying' }

export function scopeWhere(scope: string, actor: Actor): WhereOptions {
  switch (scope) {
    case 'all':
      return {}
    case 'mine':
      return { submitted_by: actor.id }
    case 'team':
      // Uploaded by the other members of my office (its staff and employees).
      if (!actor.office_id) return { id: null }
      return { submitted_by: { [Op.ne]: actor.id }, [Op.and]: [submittedFromOffice(actor.office_id)] }
    case 'visited':
      if (!actor.office_id) return { id: null }
      return { [Op.and]: [visitedOffice(actor.office_id)] }
    case 'office':
      if (!actor.office_id) return { id: null }
      return { current_office_id: actor.office_id, status: { [Op.in]: [...AT_OFFICE, ...CARRYING] } }
    case 'incoming':
      if (!actor.office_id) return { id: null }
      return { status: { [Op.in]: CARRYING }, [Op.and]: [incomingTo(actor.office_id)] }
    case 'carrying':
      return { status: { [Op.in]: CARRYING }, [Op.and]: [carriedBy(actor.id)] }
    case 'pickups':
      return pickupsWhere(actor)
    default:
      throw badRequest('Unknown scope')
  }
}

/** Uploaded by a member of `officeId`. */
export const submittedFromOffice = (officeId: string) => lit(`documents.submitted_by IN (SELECT u.id FROM users u WHERE u.office_id = ${esc(officeId)})`)

/** Arrived at (or started from) `officeId` at some point on its route. */
export const visitedOffice = (officeId: string) => lit(`EXISTS (SELECT 1 FROM document_tracking t WHERE t.document_id = documents.id AND t.office_id = ${esc(officeId)})`)

/**
 * Which documents an account can see (lists, search, tracking):
 *   CLIENT    every document in the organization
 *   EMPLOYEE  its own uploads, uploads by its office's staff, and every document that is
 *             at, arrived at, or is heading to its office
 *   STAFF     only its own uploads
 *   LIAISON   unchanged — pickups and deliveries are filtered by scope
 */
export function visibleWhere(actor: Actor): WhereOptions {
  switch (actor.account_type) {
    case 'EMPLOYEE': {
      if (!actor.office_id) return { submitted_by: actor.id }
      const office = actor.office_id as string
      return {
        [Op.or]: [
          { submitted_by: actor.id },
          { current_office_id: office, status: { [Op.ne]: 'CREATED' } },
          submittedFromOffice(office),
          visitedOffice(office),
          { [Op.and]: [{ status: { [Op.in]: CARRYING } }, incomingTo(office)] },
        ],
      }
    }
    case 'STAFF':
      return { submitted_by: actor.id }
    default:
      return {}
  }
}

/**
 * Who can open a single document: everyone it is visible to, plus STAFF for documents
 * waiting at their own office — they still receive and approve those, even though the
 * documents don't show up in their lists.
 */
export function openableWhere(actor: Actor): WhereOptions {
  if (actor.account_type === 'STAFF' && actor.office_id) {
    return { [Op.or]: [visibleWhere(actor), { current_office_id: actor.office_id, status: { [Op.in]: AT_OFFICE } }] }
  }
  return visibleWhere(actor)
}
