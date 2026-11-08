/**
 * How a document is routed, chosen at upload (and on a draft or a returned document before it is submitted):
 *
 *   GLOBAL     an organization Document Route (documents.route_id): office to office, carried by messengers.
 *   INTERNAL   an internal process (documents.internal_route_id, route_id NULL): one internal route of the
 *              uploader's own main office, through its umbrella units in order; then that office decides.
 *
 * The pure half: reading and cross-checking the request fields. Whether the route exists, is active and belongs to
 * the signed-in account's office is checked against the database (routes.ts routeForNewDocument,
 * internal-routes.ts findUsableInternalRoute). No database access here, so it is unit-tested directly
 * (tests/routing-mode.test.ts).
 */

export const ROUTING_MODES = ['GLOBAL', 'INTERNAL'] as const
export type RoutingMode = (typeof ROUTING_MODES)[number]

export interface RoutingSelection {
  mode: RoutingMode
  /** GLOBAL: the Document Route (null = the organization's only active route). Always null for INTERNAL. */
  routeId: string | null
  /** INTERNAL: the internal route. Always null for GLOBAL. */
  internalRouteId: string | null
}

export type RoutingRead = { ok: true; selection: RoutingSelection | null } | { ok: false; field: string; message: string }

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

function idOf(fields: Record<string, unknown>, name: string): { ok: true; id: string | null } | { ok: false; field: string; message: string } {
  const raw = fields[name]
  if (raw == null) return { ok: true, id: null }
  if (typeof raw !== 'string') return { ok: false, field: name, message: 'Must be a route id' }
  const value = raw.trim()
  if (!value) return { ok: true, id: null }
  if (!UUID.test(value)) return { ok: false, field: name, message: 'That is not a valid route id' }
  return { ok: true, id: value.toLowerCase() }
}

/**
 * The routing chosen in a request: `routing_mode` (GLOBAL | INTERNAL), `route_id`, `internal_route_id`.
 *
 *   nothing given                      selection null: the caller keeps what it has (a draft's current route), or —
 *                                      creating a document — GLOBAL on the only active route, as before this choice existed
 *   no mode, only route_id             GLOBAL (requests made before this choice existed keep working)
 *   no mode, but internal_route_id     refused: an internal process is always asked for explicitly
 *   GLOBAL with internal_route_id      refused
 *   INTERNAL with route_id             refused
 *   INTERNAL without internal_route_id refused
 *   anything else as the mode          refused
 */
export function readRoutingSelection(fields: Record<string, unknown>): RoutingRead {
  const route = idOf(fields, 'route_id')
  if (!route.ok) return route
  const internal = idOf(fields, 'internal_route_id')
  if (!internal.ok) return internal
  const rawMode = fields.routing_mode
  const mode = typeof rawMode === 'string' ? rawMode.trim() : rawMode == null ? '' : null

  if (mode === null || (mode && !(ROUTING_MODES as readonly string[]).includes(mode))) {
    return { ok: false, field: 'routing_mode', message: 'Routing mode must be GLOBAL (Global Routing) or INTERNAL (Internal Process)' }
  }
  if (!mode) {
    if (internal.id) return { ok: false, field: 'routing_mode', message: 'Choose the routing mode: an internal route is only used with Internal Process (routing_mode INTERNAL)' }
    return { ok: true, selection: route.id ? { mode: 'GLOBAL', routeId: route.id, internalRouteId: null } : null }
  }
  if (mode === 'GLOBAL') {
    if (internal.id) return { ok: false, field: 'internal_route_id', message: 'Global Routing follows a Document Route, not an internal route' }
    return { ok: true, selection: { mode: 'GLOBAL', routeId: route.id, internalRouteId: null } }
  }
  if (route.id) return { ok: false, field: 'route_id', message: 'Internal Process follows one of your office’s internal routes, not a Document Route' }
  if (!internal.id) return { ok: false, field: 'internal_route_id', message: 'Choose the internal route' }
  return { ok: true, selection: { mode: 'INTERNAL', routeId: null, internalRouteId: internal.id } }
}

/** The routing a stored document follows. */
export const routingModeOf = (doc: { route_id?: unknown } | Record<string, any>): RoutingMode => (doc.route_id ? 'GLOBAL' : 'INTERNAL')
