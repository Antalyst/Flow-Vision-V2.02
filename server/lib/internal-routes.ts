import { Op, type Transaction } from 'sequelize'
import { sequelize, InternalRoute, InternalRouteStep, Office, type Row } from './models.ts'
import { badRequest, conflict, forbidden, notFound } from './errors.ts'
import type { Actor, RequestMeta } from './auth.ts'
import { requirePage } from './team.ts'
import { requirePermission } from './dh-access.ts'
import { audit } from './audit.ts'
import * as v from './validate.ts'

/**
 * Internal transaction routes: an office's own ordered paths through its umbrella offices (units).
 *
 * Three different things move a document, and they don't mix:
 *   organization route   (organization_routes)  office to office, carried by messengers; each step is a checkpoint.
 *   umbrella hand-off     (documents.ts)          the office hands a received document to one unit and gets it back.
 *   internal route        (this file)             the office sends a received document through several of its units
 *                                                 in order; it comes back to the office at the end.
 * Both the hand-off and an internal route happen *inside* the office's route step: the document's
 * current_step_number never changes, and only the office releases it onward afterwards.
 *
 * Who manages internal routes: a Department Head of the (main) office with "Manage internal routes" (the
 * managing head always, a delegate only when granted). The ADMIN can read them. Every route belongs to
 * one office; another office never sees or edits it.
 */
export const INTERNAL_ROUTES_PAGE = '/employee/internal-routes'
const MIN_STEPS = 2
const MAX_STEPS = 10

/** The office whose internal routes this account manages: their own, if it is an active main office. */
export function requireInternalRouteManager(actor: Actor) {
  if (actor.account_type !== 'DEPARTMENT_HEAD') throw forbidden('Only an office’s Department Head manages its internal routes')
  requirePage(actor, INTERNAL_ROUTES_PAGE)
  requirePermission(actor, 'MANAGE_INTERNAL_ROUTES')
  const office = actor.office as Row | null
  if (!office || office.org_id !== actor.org_id || office.status === 'inactive') throw forbidden('Your account is not assigned to an active office')
  if (office.parent_office_id) throw forbidden('An umbrella office has no internal routes of its own')
  return office
}

/**
 * Whose routes this account may read: the ADMIN any office of the organization (or all); a Department
 * Head its own office's (an umbrella office's head: its parent's, which may pass through its unit).
 */
export function readableOfficeId(actor: Actor, requested: string | null): { officeId: string | null } {
  if (actor.account_type === 'ADMIN') return { officeId: requested }
  if (actor.account_type !== 'DEPARTMENT_HEAD') throw forbidden('Only Department Heads and the admin view internal routes')
  const office = actor.office as Row | null
  if (!office) throw forbidden('Your account is not assigned to an office')
  return { officeId: (office.parent_office_id as string | null) ?? (office.id as string) }
}

export function internalRouteDto(r: Row) {
  const steps = [...((r.steps as Row[] | undefined) ?? [])].sort((a, b) => a.step_number - b.step_number)
  return {
    id: r.id as string,
    office_id: r.office_id as string,
    office: r.office ? { id: r.office.id as string, name: r.office.name as string, code: r.office.code as string } : null,
    name: r.name as string,
    description: (r.description as string | null) ?? null,
    is_active: Boolean(r.is_active),
    steps: steps.map((s) => ({
      step_number: s.step_number as number,
      office_id: s.office_id as string,
      office: s.office ? { id: s.office.id as string, name: s.office.name as string, code: s.office.code as string, is_active: s.office.status !== 'inactive' } : null,
      action_label: (s.action_label as string | null) ?? null,
    })),
    created_at: r.created_at ? new Date(r.created_at).toISOString() : null,
    updated_at: r.updated_at ? new Date(r.updated_at).toISOString() : null,
  }
}

const include = [
  { model: InternalRouteStep, as: 'steps', include: [{ model: Office, as: 'office', attributes: ['id', 'name', 'code', 'status'] }] },
  { model: Office, as: 'office', attributes: ['id', 'name', 'code'] },
]

export function listInternalRoutes(orgId: string, officeId: string | null, { activeOnly = false } = {}, transaction?: Transaction) {
  return InternalRoute.findAll({
    where: { org_id: orgId, ...(officeId && { office_id: officeId }), ...(activeOnly && { is_active: true }) },
    include,
    order: [['name', 'ASC']],
    transaction,
  })
}

/** One route, only if it belongs to this office (another office's id is "not found", never "forbidden"). */
export async function findInternalRoute(orgId: string, officeId: string | null, id: string, transaction?: Transaction) {
  const route = await InternalRoute.findOne({ where: { id, org_id: orgId, ...(officeId && { office_id: officeId }) }, include, transaction })
  if (!route) throw notFound('Internal route')
  return route
}

/**
 * The steps of an internal route from a request body: 2–10 steps, each an *active umbrella office of this
 * office* in the same organization, no unit twice (a path, not a loop), optional action text.
 */
export async function readInternalSteps(orgId: string, officeId: string, raw: unknown, transaction?: Transaction) {
  if (!Array.isArray(raw)) throw badRequest('Steps must be a list', { field: 'steps' })
  if (raw.length < MIN_STEPS) throw badRequest(`An internal route needs at least ${MIN_STEPS} umbrella offices. To send a document to one, hand it to that umbrella office.`, { field: 'steps' })
  if (raw.length > MAX_STEPS) throw badRequest(`An internal route can have at most ${MAX_STEPS} steps`, { field: 'steps' })
  const list = raw.map((s, i) => {
    const step = (s && typeof s === 'object' ? s : {}) as Record<string, unknown>
    if (typeof step.office_id !== 'string' || !step.office_id) throw badRequest(`Step ${i + 1} needs an umbrella office`, { field: 'steps' })
    const label = typeof step.action_label === 'string' ? step.action_label.trim() : ''
    if (label.length > 255) throw badRequest(`Step ${i + 1}: the action is too long (255 characters at most)`, { field: 'steps' })
    return { office_id: step.office_id, action_label: label || null }
  })
  const ids = list.map((s) => s.office_id)
  if (new Set(ids).size !== ids.length) throw badRequest('Each umbrella office can appear only once in an internal route', { field: 'steps' })
  const units = await Office.findAll({ where: { id: { [Op.in]: ids }, org_id: orgId }, attributes: ['id', 'name', 'parent_office_id', 'status'], transaction })
  for (const [i, id] of ids.entries()) {
    const unit = units.find((u) => u.id === id)
    if (!unit || unit.parent_office_id !== officeId) throw badRequest(`Step ${i + 1} is not an umbrella office of your office`, { field: 'steps' })
    if (unit.status === 'inactive') throw badRequest(`${unit.name} is deactivated and can’t be a step`, { field: 'steps' })
  }
  return list.map((s, i) => ({ ...s, step_number: i + 1 }))
}

function readFields(body: Record<string, unknown>, partial: boolean) {
  const out: Record<string, unknown> = {}
  if (!partial || 'name' in body) out.name = v.reqStr(body, 'name', { max: 120, label: 'Name' })
  if (!partial || 'description' in body) out.description = v.str(body, 'description', { max: 500, label: 'Description' })
  if ('is_active' in body) {
    if (typeof body.is_active !== 'boolean') throw badRequest('is_active must be true or false', { field: 'is_active' })
    out.is_active = body.is_active
  }
  return out
}

async function assertNameFree(officeId: string, name: string, exceptId: string | null, transaction: Transaction) {
  const taken = await InternalRoute.findOne({ where: { office_id: officeId, name, ...(exceptId && { id: { [Op.ne]: exceptId } }) }, transaction })
  if (taken) throw conflict(`Your office already has an internal route called “${taken.name}”${taken.is_active ? '' : ' (deactivated: reactivate it or choose another name)'}`, 'DUPLICATE')
}

const isUniqueError = (err: unknown) => (err as { name?: string })?.name === 'SequelizeUniqueConstraintError'

export async function createInternalRoute(actor: Actor, body: Record<string, unknown>, meta: RequestMeta) {
  const office = requireInternalRouteManager(actor)
  const fields = readFields(body, false)
  try {
    return await sequelize.transaction(async (transaction) => {
      const steps = await readInternalSteps(actor.org_id as string, office.id as string, body.steps, transaction)
      await assertNameFree(office.id as string, fields.name as string, null, transaction)
      const now = new Date()
      const route = await InternalRoute.create({ ...fields, org_id: actor.org_id, office_id: office.id, is_active: fields.is_active ?? true, created_by: actor.id, created_at: now, updated_at: now }, { transaction })
      await InternalRouteStep.bulkCreate(steps.map((s) => ({ ...s, route_id: route.id, created_at: now })), { transaction })
      await audit(meta, { action: 'INTERNAL_ROUTE_CREATE', entityType: 'internal_route', entityId: route.id, after: { office_id: office.id, name: fields.name, steps: steps.map((s) => s.office_id) } }, transaction)
      return findInternalRoute(actor.org_id as string, office.id as string, route.id as string, transaction)
    })
  } catch (err) {
    if (isUniqueError(err)) throw conflict(`Your office already has an internal route called “${fields.name}”`, 'DUPLICATE')
    throw err
  }
}

/**
 * Edit a route: name, description, steps, active. Documents already on it keep the steps they started
 * with (each transaction stores a snapshot), so editing or deactivating never moves a document.
 */
export async function updateInternalRoute(actor: Actor, id: string, body: Record<string, unknown>, meta: RequestMeta) {
  const office = requireInternalRouteManager(actor)
  const fields = readFields(body, true)
  try {
    return await sequelize.transaction(async (transaction) => {
      const route = await InternalRoute.findOne({ where: { id, org_id: actor.org_id, office_id: office.id }, transaction, lock: transaction.LOCK.UPDATE })
      if (!route) throw notFound('Internal route')
      const before = internalRouteDto(await findInternalRoute(actor.org_id as string, office.id as string, id, transaction))
      if (fields.name !== undefined && fields.name !== route.name) await assertNameFree(office.id as string, fields.name as string, route.id as string, transaction)
      if (body.steps !== undefined) {
        const steps = await readInternalSteps(actor.org_id as string, office.id as string, body.steps, transaction)
        await InternalRouteStep.destroy({ where: { route_id: route.id }, transaction })
        await InternalRouteStep.bulkCreate(steps.map((s) => ({ ...s, route_id: route.id, created_at: new Date() })), { transaction })
      }
      await route.update({ ...fields, updated_at: new Date() }, { transaction })
      const after = internalRouteDto(await findInternalRoute(actor.org_id as string, office.id as string, id, transaction))
      await audit(
        meta,
        {
          action: fields.is_active === false && before.is_active ? 'INTERNAL_ROUTE_DEACTIVATE' : 'INTERNAL_ROUTE_UPDATE',
          entityType: 'internal_route',
          entityId: route.id,
          before: { name: before.name, is_active: before.is_active, steps: before.steps.map((s) => s.office_id) },
          after: { name: after.name, is_active: after.is_active, steps: after.steps.map((s) => s.office_id) },
        },
        transaction,
      )
      return findInternalRoute(actor.org_id as string, office.id as string, id, transaction)
    })
  } catch (err) {
    if (isUniqueError(err)) throw conflict(`Your office already has an internal route called “${fields.name}”`, 'DUPLICATE')
    throw err
  }
}
