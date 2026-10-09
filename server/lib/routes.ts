import { Op, fn, col, type Transaction } from 'sequelize'
import { sequelize, Document, Office, Organization, OrganizationRoute, RouteStep, type Row } from './models.ts'
import { badRequest, conflict, notFound } from './errors.ts'
import { AT_OFFICE, CARRYING } from './serializers.ts'

/**
 * An organization has any number of Document Routes; each document follows the one it was
 * submitted on (documents.route_id).
 *   organization_routes.is_active = 1  the route is offered for new documents
 *   organization_routes.is_active = 0  retired, or a snapshot of an edited route's earlier steps
 * A route keeps its id when it is edited. When its steps change while documents are in flight
 * (or completed) on it, those documents first move to an inactive copy of the old steps, so
 * their current_step_number keeps pointing at the same office and their history stays intact.
 */

const IN_FLIGHT = [...AT_OFFICE, ...CARRYING]
// Documents that ran on a route's steps. Drafts and returned documents (re)enter at step 1.
const RAN_ON_STEPS = { [Op.notIn]: ['CREATED', 'RETURNED'] }

const stepInclude = { model: RouteStep, as: 'steps', include: [{ model: Office, as: 'office' }] }
const stepOrder: any = [[{ model: RouteStep, as: 'steps' }, 'step_number', 'ASC']]

export function getRouteWithSteps(routeId: string, transaction?: Transaction) {
  return OrganizationRoute.findByPk(routeId, { include: [stepInclude], order: stepOrder, transaction })
}

/** The routes offered for new documents, A–Z. */
export function listActiveRoutes(orgId: string) {
  return OrganizationRoute.findAll({ where: { org_id: orgId, is_active: true }, include: [stepInclude], order: [['name', 'ASC'], ...stepOrder] })
}

export function countActiveRoutes(orgId: string) {
  return OrganizationRoute.count({ where: { org_id: orgId, is_active: true } })
}

/** Documents in flight per route id. */
export async function inFlightCounts(routeIds: string[]) {
  if (!routeIds.length) return new Map<string, number>()
  const rows = (await Document.findAll({
    where: { route_id: { [Op.in]: routeIds }, status: { [Op.in]: IN_FLIGHT } },
    attributes: ['route_id', [fn('COUNT', col('id')), 'count']],
    group: ['route_id'],
    raw: true,
  })) as unknown as Array<{ route_id: string; count: number }>
  return new Map(rows.map((r) => [r.route_id, Number(r.count)]))
}

export async function getStep(routeId: string | null, stepNumber: number | null, transaction?: Transaction): Promise<Row | null> {
  if (!routeId || !stepNumber) return null
  return RouteStep.findOne({ where: { route_id: routeId, step_number: stepNumber }, include: [{ model: Office, as: 'office' }], transaction })
}

/**
 * An active route and its steps, share-locked so the route can't be edited until the
 * transaction (a document entering it) commits.
 */
export async function getLiveRoute(orgId: string, routeId: string, transaction: Transaction) {
  const route = await OrganizationRoute.findOne({ where: { id: routeId, org_id: orgId, is_active: true }, transaction, lock: transaction.LOCK.SHARE })
  if (!route) return null
  const steps = await RouteStep.findAll({ where: { route_id: route.id }, order: [['step_number', 'ASC']], transaction, lock: transaction.LOCK.SHARE })
  return { route, steps }
}

/** The route a new document is pinned to: the one asked for, or the only active route. */
export async function routeForNewDocument(orgId: string, routeId: string | null, transaction?: Transaction) {
  if (routeId) {
    const route = await OrganizationRoute.findOne({ where: { id: routeId, org_id: orgId, is_active: true }, transaction })
    if (!route) throw badRequest('That route is not available. Pick one of your organization’s Document Routes.', { field: 'route_id' })
    return route
  }
  const active = await OrganizationRoute.findAll({ where: { org_id: orgId, is_active: true }, attributes: ['id'], limit: 2, transaction })
  if (!active.length) throw conflict('Your organization has no Document Route yet. Create one on the Document Routes page first.', 'NO_ACTIVE_ROUTE')
  if (active.length > 1) throw badRequest('Choose the Document Route this document should follow', { field: 'route_id' })
  return active[0]!
}

// ---------------------------------------------------------------------------
// Commands (CLIENT)
// ---------------------------------------------------------------------------

export interface StepInput {
  office_id?: unknown
  action_label?: unknown
  sla_days?: unknown
  sla_hours?: unknown
}

export interface RouteInput {
  name?: string
  description?: string | null
  steps?: unknown
}

type StepRow = { step_number: number; office_id: string; action_description: string; sla_days: number; sla_hours: number; is_final_checkpoint: boolean }

const int = (value: unknown) => Number.parseInt(String(value ?? ''), 10)

/**
 * A step's own processing time (route_steps.sla_days / sla_hours). Optional and no longer set by
 * the route builder: how long a document may take now comes from its document type
 * (Organization Settings). Older routes keep theirs, as a fallback for untimed types.
 */
function readSla(step: StepInput, index: number) {
  const days = int(step.sla_days)
  const hours = int(step.sla_hours)
  const d = Number.isNaN(days) ? 0 : days
  const h = Number.isNaN(hours) ? 0 : hours
  if (d < 0 || d > 365) throw badRequest(`Step ${index + 1}: days must be between 0 and 365`)
  if (h < 0 || h > 23) throw badRequest(`Step ${index + 1}: hours must be between 0 and 23`)
  return { sla_days: d, sla_hours: h }
}

/** Total processing time of a step, in hours. */
export const stepHours = (s: Record<string, any>) => Number(s.sla_days ?? 0) * 24 + Number(s.sla_hours ?? 0)

/** Total processing time of a route: every step's days, and every step's hours. */
export async function routeTimeOf(routeId: string, transaction?: Transaction) {
  const steps = await RouteStep.findAll({ where: { route_id: routeId }, attributes: ['sla_days', 'sla_hours'], transaction })
  return { days: steps.reduce((n, s) => n + Number(s.sla_days ?? 0), 0), hours: steps.reduce((n, s) => n + Number(s.sla_hours ?? 0), 0) }
}

/** Total processing time of a route (every step's days + hours), in hours. */
export async function routeHoursOf(routeId: string, transaction?: Transaction) {
  const { days, hours } = await routeTimeOf(routeId, transaction)
  return days * 24 + hours
}

/** Validate submitted steps against the organization's active offices. The last step is the final checkpoint. */
async function readSteps(orgId: string, steps: unknown, transaction: Transaction): Promise<StepRow[]> {
  if (!Array.isArray(steps) || steps.length === 0) throw badRequest('A route needs at least one step')
  if (steps.length > 30) throw badRequest('A route can have at most 30 steps')
  const list = steps as StepInput[]

  const officeIds = list.map((s) => s?.office_id)
  if (officeIds.some((id) => typeof id !== 'string')) throw badRequest('Every step needs an office')
  for (let i = 1; i < officeIds.length; i += 1) {
    if (officeIds[i] === officeIds[i - 1]) throw badRequest(`Steps ${i} and ${i + 1} use the same office back to back`)
  }
  const unique = [...new Set(officeIds as string[])]
  const offices = await Office.count({ where: { id: { [Op.in]: unique }, org_id: orgId, status: 'active' }, transaction })
  if (offices !== unique.length) throw badRequest('One or more offices are invalid or inactive')

  return list.map((step, index) => ({
    step_number: index + 1,
    office_id: step.office_id as string,
    action_description: (typeof step.action_label === 'string' && step.action_label.trim().slice(0, 255)) || 'Review',
    ...readSla(step, index),
    is_final_checkpoint: index === list.length - 1,
  }))
}

// Step times are no longer edited (they come from document types), so only offices and actions count.
const sameSteps = (a: Row[], b: StepRow[]) =>
  a.length === b.length && a.every((s, i) => s.office_id === b[i]!.office_id && s.action_description === b[i]!.action_description)

/** Serialises route changes within an organization (name checks, final-checkpoint sync). */
const lockOrganization = (orgId: string, transaction: Transaction) => Organization.findByPk(orgId, { transaction, lock: transaction.LOCK.UPDATE })

async function assertNameFree(orgId: string, name: string, exceptId: string | null, transaction: Transaction) {
  // The column collation is case-insensitive, so "HR route" and "hr route" collide.
  const taken = await OrganizationRoute.findOne({
    where: { org_id: orgId, is_active: true, name, ...(exceptId && { id: { [Op.ne]: exceptId } }) },
    transaction,
  })
  if (taken) throw conflict(`There is already a Document Route called "${taken.name}"`, 'DUPLICATE')
}

/**
 * offices.is_final_checkpoint decides which STAFF have approval authority: the office ends an
 * active route, or ends a retired one that still has documents in flight.
 */
async function syncFinalCheckpoints(orgId: string, transaction: Transaction) {
  await sequelize.query(
    `UPDATE offices o SET o.is_final_checkpoint = EXISTS (
       SELECT 1 FROM route_steps rs JOIN organization_routes r ON r.id = rs.route_id
       WHERE rs.office_id = o.id AND rs.is_final_checkpoint = 1 AND r.org_id = o.org_id
         AND (r.is_active = 1 OR EXISTS (SELECT 1 FROM documents d WHERE d.route_id = r.id AND d.status IN (:inFlight)))
     )
     WHERE o.org_id = :orgId`,
    { replacements: { orgId, inFlight: IN_FLIGHT }, transaction },
  )
}

/** Move the documents that ran on `route`'s current steps to an inactive copy of them. Returns how many moved. */
async function preserveStepsForDocuments(route: Row, steps: Row[], transaction: Transaction) {
  const used = await Document.count({ where: { route_id: route.id, status: RAN_ON_STEPS }, transaction })
  if (!used) return 0
  const copy = await OrganizationRoute.create(
    { org_id: route.org_id, name: route.name, description: route.description, is_active: false, created_by: route.created_by },
    { transaction },
  )
  await RouteStep.bulkCreate(
    steps.map((s) => ({
      route_id: copy.id,
      step_number: s.step_number,
      office_id: s.office_id,
      sla_days: s.sla_days,
      sla_hours: s.sla_hours,
      action_description: s.action_description,
      is_final_checkpoint: s.is_final_checkpoint,
    })),
    { transaction },
  )
  // Bookkeeping only: keep updated_at so activity-ordered lists don't reshuffle.
  const [moved] = await Document.update(
    { route_id: copy.id, updated_at: sequelize.literal('updated_at') },
    { where: { route_id: route.id, status: RAN_ON_STEPS }, transaction, silent: true },
  )
  return moved
}

export async function createRoute(orgId: string, userId: string, { name, description, steps }: { name: string; description: string | null; steps: unknown }) {
  return sequelize.transaction(async (transaction) => {
    await lockOrganization(orgId, transaction)
    const rows = await readSteps(orgId, steps, transaction)
    await assertNameFree(orgId, name, null, transaction)

    const route = await OrganizationRoute.create({ org_id: orgId, name, description, is_active: true, created_by: userId }, { transaction })
    await RouteStep.bulkCreate(rows.map((s) => ({ ...s, route_id: route.id })), { transaction })
    await syncFinalCheckpoints(orgId, transaction)
    return (await getRouteWithSteps(route.id, transaction))!
  })
}

/**
 * Edit an active route in place. Documents that already ran on its old steps move to a
 * snapshot first (see preserveStepsForDocuments); drafts and returned documents follow the
 * new steps when they are (re)submitted.
 */
export async function updateRoute(orgId: string, routeId: string, input: RouteInput) {
  return sequelize.transaction(async (transaction) => {
    await lockOrganization(orgId, transaction)
    // Exclusive lock: documents entering this route wait for the edit (see getLiveRoute).
    const route = await OrganizationRoute.findOne({ where: { id: routeId, org_id: orgId, is_active: true }, transaction, lock: transaction.LOCK.UPDATE })
    if (!route) throw notFound('Route')
    const before = await RouteStep.findAll({ where: { route_id: route.id }, order: [['step_number', 'ASC']], transaction })

    if (input.name !== undefined && input.name !== route.name) await assertNameFree(orgId, input.name, route.id, transaction)

    let stepsChanged = false
    let movedDocuments = 0
    if (input.steps !== undefined) {
      const next = await readSteps(orgId, input.steps, transaction)
      if (!sameSteps(before, next)) {
        stepsChanged = true
        movedDocuments = await preserveStepsForDocuments(route, before, transaction)
        await RouteStep.destroy({ where: { route_id: route.id }, transaction })
        await RouteStep.bulkCreate(next.map((s) => ({ ...s, route_id: route.id })), { transaction })
      }
    }

    if (input.name !== undefined) route.name = input.name
    if (input.description !== undefined) route.description = input.description
    if (stepsChanged) route.changed('updated_at', true)
    await route.save({ transaction })
    await syncFinalCheckpoints(orgId, transaction)

    return { route: (await getRouteWithSteps(route.id, transaction))!, before, stepsChanged, movedDocuments }
  })
}

/**
 * Take a route off the list. A route no document has used is deleted; otherwise it is retired
 * (is_active = 0) so its documents keep their history and those in flight finish normally.
 */
export async function removeRoute(orgId: string, routeId: string) {
  return sequelize.transaction(async (transaction) => {
    await lockOrganization(orgId, transaction)
    const route = await OrganizationRoute.findOne({ where: { id: routeId, org_id: orgId, is_active: true }, transaction, lock: transaction.LOCK.UPDATE })
    if (!route) throw notFound('Route')

    const used = await Document.count({ where: { route_id: route.id }, transaction })
    if (used) {
      await route.update({ is_active: false }, { transaction })
    } else {
      await RouteStep.destroy({ where: { route_id: route.id }, transaction })
      await route.destroy({ transaction })
    }
    await syncFinalCheckpoints(orgId, transaction)
    return { route, deleted: !used }
  })
}
