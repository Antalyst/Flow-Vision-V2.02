// The routing chosen at upload (server/lib/routing-mode.ts): Global Routing or an internal process, and the
// request fields that go with each. No database: run with `npm run test:routing-mode`.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readRoutingSelection, routingModeOf } from '../server/lib/routing-mode.ts'

const R = '3f1c2e4a-1111-4a2b-9c3d-000000000001'
const I = '3f1c2e4a-2222-4a2b-9c3d-000000000002'

const ok = (fields: Record<string, unknown>) => {
  const r = readRoutingSelection(fields)
  assert.ok(r.ok, `expected ok for ${JSON.stringify(fields)}: ${!r.ok ? r.message : ''}`)
  return r.selection
}
const refused = (fields: Record<string, unknown>, field: string) => {
  const r = readRoutingSelection(fields)
  assert.ok(!r.ok, `expected refusal for ${JSON.stringify(fields)}`)
  assert.equal(r.field, field)
}

test('Global Routing', () => {
  assert.deepEqual(ok({ routing_mode: 'GLOBAL', route_id: R }), { mode: 'GLOBAL', routeId: R, internalRouteId: null })
  // The organization's only route, chosen on the server.
  assert.deepEqual(ok({ routing_mode: 'GLOBAL' }), { mode: 'GLOBAL', routeId: null, internalRouteId: null })
})

test('Internal Process', () => {
  assert.deepEqual(ok({ routing_mode: 'INTERNAL', internal_route_id: I }), { mode: 'INTERNAL', routeId: null, internalRouteId: I })
  // Ids are compared in lower case.
  assert.equal(ok({ routing_mode: 'INTERNAL', internal_route_id: I.toUpperCase() })?.internalRouteId, I)
})

test('requests from before the choice existed keep working', () => {
  assert.deepEqual(ok({ route_id: R }), { mode: 'GLOBAL', routeId: R, internalRouteId: null })
  // Nothing chosen: the caller keeps the document's route (or the only route, for a new one).
  assert.equal(ok({}), null)
  assert.equal(ok({ route_id: '', internal_route_id: '' }), null)
})

test('a missing or invalid mode is refused', () => {
  refused({ internal_route_id: I }, 'routing_mode')
  refused({ routing_mode: 'LOCAL', route_id: R }, 'routing_mode')
  refused({ routing_mode: 'global', route_id: R }, 'routing_mode')
  refused({ routing_mode: 5, route_id: R }, 'routing_mode')
})

test('mismatched combinations are refused', () => {
  refused({ routing_mode: 'GLOBAL', internal_route_id: I }, 'internal_route_id')
  refused({ routing_mode: 'GLOBAL', route_id: R, internal_route_id: I }, 'internal_route_id')
  refused({ routing_mode: 'INTERNAL', route_id: R }, 'route_id')
  refused({ routing_mode: 'INTERNAL', route_id: R, internal_route_id: I }, 'route_id')
  refused({ routing_mode: 'INTERNAL' }, 'internal_route_id')
})

test('invalid route ids are refused', () => {
  refused({ routing_mode: 'GLOBAL', route_id: 'payroll' }, 'route_id')
  refused({ routing_mode: 'INTERNAL', internal_route_id: "1' OR '1'='1" }, 'internal_route_id')
  refused({ routing_mode: 'INTERNAL', internal_route_id: ['a'] }, 'internal_route_id')
})

test('a stored document’s mode', () => {
  assert.equal(routingModeOf({ route_id: R, internal_route_id: null }), 'GLOBAL')
  assert.equal(routingModeOf({ route_id: null, internal_route_id: I }), 'INTERNAL')
})
