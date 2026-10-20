/**
 * Office workflow end to end, against a running app (direct API calls — no UI):
 *   1. the staff workload forecast leaves Department Heads out (office totals still count their documents);
 *   2. a document on its way to an office hides its QR label from that office, and receipt still needs a
 *      valid state, the destination office and the "Receive documents" permission;
 *   3. internal routes: an office's own path through its umbrella offices, inside one route step.
 *
 *   npm run dev                              (another terminal; LOCAL database with the demo seed, migrated)
 *   npm run test:office-workflow-api         (or: node tests/office-workflow-api.test.ts --base=http://localhost:3000)
 *
 * It writes to the database it runs against and refuses a non-local --base unless --remote.
 */
const argv: Record<string, string> = Object.fromEntries(
  process.argv.slice(2).map((a) => {
    const m = /^--([^=]+)(?:=(.*))?$/.exec(a)
    return m ? [m[1]!, m[2] ?? 'true'] : [a, 'true']
  }),
)
const BASE = (argv.base ?? process.env.FV_BASE_URL ?? 'http://localhost:3000').replace(/\/$/, '')
const PASSWORD = argv.password ?? process.env.FV_DEMO_PASSWORD ?? 'Demo@1234'
if (!/^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(BASE) && !argv.remote) {
  console.error(`Refusing to run against ${BASE}: this test creates accounts and documents. Use a local app, or add --remote.`)
  process.exit(1)
}

let passed = 0
let failed = 0
function check(ok: unknown, label: string, detail: unknown = '') {
  if (ok) passed++
  else failed++
  console.log(`${ok ? '\x1b[32m✔\x1b[0m' : '\x1b[31m✘\x1b[0m'} ${label}${ok ? '' : `  → ${typeof detail === 'string' ? detail : JSON.stringify(detail)?.slice(0, 600)}`}`)
}

type Res = { status: number; body: any }
type Call = (method: string, path: string, body?: unknown) => Promise<Res>
interface Session {
  call: Call
  user: any
}
async function login(email: string, password = PASSWORD): Promise<Session> {
  const res = await fetch(`${BASE}/api/auth/login`, { method: 'POST', headers: { 'content-type': 'application/json', origin: BASE }, body: JSON.stringify({ email, password }) })
  if (!res.ok) throw new Error(`could not sign in as ${email} (${res.status})`)
  const cookie = (res.headers.get('set-cookie') ?? '').split(';')[0]!
  const user = (await res.json()).user
  const call: Call = async (method, path, body) => {
    const form = body instanceof FormData
    const r = await fetch(`${BASE}/api${path}`, {
      method,
      headers: { cookie, origin: BASE, ...(!form && body !== undefined && { 'content-type': 'application/json' }) },
      body: form ? body : body !== undefined ? JSON.stringify(body) : undefined,
    })
    return { status: r.status, body: await r.json().catch(() => null) }
  }
  return { call, user }
}

const health = await fetch(`${BASE}/api/health`).catch(() => null)
if (!health?.ok) {
  console.error(`The app is not reachable at ${BASE} (start it with npm run dev).`)
  process.exit(1)
}

const stamp = Date.now().toString().slice(-6)
const ok = (r: Res) => r.status === 200 || r.status === 201
const why = (r: Res) => `${r.status} ${r.body?.message ?? ''}`
const admin = await login('client@bago.gov.ph')
const hr = await login('hr@bago.gov.ph') // managing Department Head of the HR office
const records = await login('records@bago.gov.ph') // managing Department Head of the Records office
const hrOffice = hr.user.office
const recordsOffice = records.user.office

async function account(by: Session, body: Record<string, unknown>) {
  const r = await by.call('POST', '/users', { first_name: 'T', ...body })
  if (r.status !== 201) throw new Error(`could not create ${body.email}: ${why(r)}`)
  return { id: r.body.user.id as string, password: r.body.temporary_password as string, session: await login(body.email as string, r.body.temporary_password) }
}
async function umbrella(by: Session, name: string, suffix: string) {
  const r = await by.call('POST', '/offices/umbrellas', { name: `${name} ${stamp}`, code: `${by.user.office.code}-${suffix}${stamp}` })
  if (r.status !== 201) throw new Error(`could not add umbrella ${name}: ${why(r)}`)
  return r.body.office
}
const png = () => new Blob([Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64')], { type: 'image/png' })
async function upload(by: Session, title: string, routeId: string) {
  const fd = new FormData()
  fd.append('title', `${title} ${stamp}`)
  fd.append('route_id', routeId)
  fd.append('submit', 'true')
  fd.append('file', png(), 'page.png')
  const r = await by.call('POST', '/documents', fd)
  if (r.status !== 201) throw new Error(`upload failed: ${why(r)}`)
  return r.body.document
}
const scan = (s: Session, payload: string, action?: string) => s.call('POST', '/qr/scan', { payload, ...(action && { action }) })
const detail = async (s: Session, id: string) => (await s.call('GET', `/documents/${id}`)).body

// ── Setup: umbrella offices, people, an organization route HR → Records ─────────────────
const U1 = await umbrella(hr, 'Records Unit', 'RU')
const U2 = await umbrella(hr, 'Payroll Unit', 'PU')
const U3 = await umbrella(hr, 'Audit Unit', 'AU')
const U5 = await umbrella(hr, 'Empty Unit', 'EU')
const RU = await umbrella(records, 'Archive Unit', 'AR')
const hs1 = await account(hr, { account_type: 'STAFF', office_id: hrOffice.id, last_name: 'HrOne', email: `ow.hs1.${stamp}@test.local` })
const hs2 = await account(hr, { account_type: 'STAFF', office_id: hrOffice.id, last_name: 'HrTwo', email: `ow.hs2.${stamp}@test.local` })
const u1s = await account(hr, { account_type: 'STAFF', office_id: U1.id, last_name: 'UnitOne', email: `ow.u1s.${stamp}@test.local` })
const u2s = await account(hr, { account_type: 'STAFF', office_id: U2.id, last_name: 'UnitTwo', email: `ow.u2s.${stamp}@test.local` })
const u3s = await account(hr, { account_type: 'STAFF', office_id: U3.id, last_name: 'UnitThree', email: `ow.u3s.${stamp}@test.local` })
const u1h = await account(hr, { account_type: 'DEPARTMENT_HEAD', office_id: U1.id, last_name: 'UnitHead', email: `ow.u1h.${stamp}@test.local`, permissions: ['RECEIVE_DOCUMENTS'] })
const u5h = await account(hr, { account_type: 'DEPARTMENT_HEAD', office_id: U5.id, last_name: 'EmptyHead', email: `ow.u5h.${stamp}@test.local` })
const dNo = await account(hr, { account_type: 'DEPARTMENT_HEAD', office_id: hrOffice.id, last_name: 'NoRoutes', email: `ow.dno.${stamp}@test.local`, permissions: ['RECEIVE_DOCUMENTS', 'UMBRELLA_HANDOFF'] })
const dYes = await account(hr, { account_type: 'DEPARTMENT_HEAD', office_id: hrOffice.id, last_name: 'Routes', email: `ow.dyes.${stamp}@test.local`, permissions: ['MANAGE_INTERNAL_ROUTES', 'UMBRELLA_HANDOFF'] })
const rs = await account(records, { account_type: 'STAFF', office_id: recordsOffice.id, last_name: 'RecStaff', email: `ow.rs.${stamp}@test.local` })
const recNoReceive = await account(records, { account_type: 'DEPARTMENT_HEAD', office_id: recordsOffice.id, last_name: 'NoReceive', email: `ow.rnr.${stamp}@test.local`, permissions: [] })
const hm = await account(hr, { account_type: 'LIAISON', office_id: hrOffice.id, last_name: 'Messenger', email: `ow.hm.${stamp}@test.local` })
await hm.session.call('PATCH', '/liaisons/me', { availability: 'AVAILABLE' })
let r = await admin.call('POST', '/routes', { name: `Office workflow ${stamp}`, steps: [{ office_id: hrOffice.id, action_label: 'Review' }, { office_id: recordsOffice.id, action_label: 'File' }] })
const orgRouteId = r.body?.route?.id
check(r.status === 201, 'setup: organization route HR → Records', why(r))

// ════════════════════════════════════════════════════════════════════════════════════
console.log('\n1. Staff workload forecast leaves Department Heads out')
let fc = (await hr.call('GET', '/forecast/office')).body
const staffIds = (fc?.staff ?? []).map((s: any) => s.id)
check(fc?.staff?.every((s: any) => s.account_type === 'STAFF'), 'every workload card is a STAFF account', fc?.staff?.map((s: any) => s.account_type))
check(!staffIds.includes(hr.user.id), 'the managing Department Head is not a workload card')
check(!staffIds.includes(dNo.id) && !staffIds.includes(dYes.id), 'delegated Department Heads are not workload cards')
check(staffIds.includes(hs1.id) && staffIds.includes(hs2.id), 'ordinary staff are still included')
const backlogBefore = fc?.backlog?.now ?? -1
const held = await upload(hr, 'Held by the head', orgRouteId)
fc = (await hr.call('GET', '/forecast/office')).body
check(fc?.backlog?.now === backlogBefore + 1, 'a document held by the Department Head still counts in the office backlog', `${backlogBefore} → ${fc?.backlog?.now}`)
check(!fc?.staff?.some((s: any) => s.id === hr.user.id), 'and the head still gets no workload card for it')
if (fc?.suggestion) {
  const firstNames = new Set(fc.staff.map((s: any) => s.first_name))
  const named = [...String(fc.suggestion).matchAll(/(?:^|Route new arrivals to )(\S+) /g)].map((m) => m[1])
  check(named.every((n) => firstNames.has(n)), 'the balancing suggestion only names staff on the cards', fc.suggestion)
} else check(true, 'no balancing suggestion right now (nothing to balance)')
r = await hr.call('PATCH', `/users/${hs2.id}`, { status: 'SUSPENDED' })
fc = (await hr.call('GET', '/forecast/office')).body
check(ok(r) && !fc?.staff?.some((s: any) => s.id === hs2.id), 'suspended staff are left out, as before', why(r))
await hr.call('PATCH', `/users/${hs2.id}`, { status: 'ACTIVE' })
// Suspension ended its sessions: sign in again.
hs2.session = await login(`ow.hs2.${stamp}@test.local`, hs2.password)
const unitFc = (await u1h.session.call('GET', '/forecast/office')).body
check(unitFc?.office?.id === U1.id && unitFc.staff.some((s: any) => s.id === u1s.id) && !unitFc.staff.some((s: any) => s.id === u1h.id), 'umbrella office: its head is left out, its staff included', unitFc?.staff)
const emptyFc = (await u5h.session.call('GET', '/forecast/office')).body
check(emptyFc?.staff?.length === 0 && emptyFc.suggestion === null, 'an office with only a head: no cards and no suggestion (empty state)', emptyFc)
r = await hs1.session.call('GET', '/forecast/office')
check(r.status === 403, 'STAFF still cannot open the office forecast', r.status)

// ════════════════════════════════════════════════════════════════════════════════════
console.log('\n3a. Internal routes: configuration and authorization')
const route3 = { name: `Payroll check ${stamp}`, description: 'Records, payroll, audit', steps: [{ office_id: U1.id, action_label: 'Pull the records' }, { office_id: U2.id, action_label: 'Compute' }, { office_id: U3.id }] }
r = await hr.call('POST', '/internal-routes', route3)
const IR = r.body?.route
check(r.status === 201 && IR?.office_id === hrOffice.id && IR.steps.map((s: any) => s.office_id).join() === [U1.id, U2.id, U3.id].join(), 'the managing head creates an internal route through three units', why(r))
r = await dNo.session.call('POST', '/internal-routes', { ...route3, name: `No ${stamp}` })
check(r.status === 403 && /Manage internal routes/.test(r.body?.message), 'a delegate without "Manage internal routes" is refused', why(r))
r = await dYes.session.call('POST', '/internal-routes', { name: `Short ${stamp}`, steps: [{ office_id: U2.id }, { office_id: U1.id }] })
const IR2 = r.body?.route
check(r.status === 201, 'a delegate with "Manage internal routes" creates one', why(r))
r = await hr.call('POST', '/internal-routes', { name: `One ${stamp}`, steps: [{ office_id: U1.id }] })
check(r.status === 400, 'one step only is refused (use a hand-off)', why(r))
r = await hr.call('POST', '/internal-routes', { name: `Twice ${stamp}`, steps: [{ office_id: U1.id }, { office_id: U2.id }, { office_id: U1.id }] })
check(r.status === 400, 'the same unit twice (a loop) is refused', why(r))
r = await hr.call('POST', '/internal-routes', { name: `Outside ${stamp}`, steps: [{ office_id: U1.id }, { office_id: recordsOffice.id }] })
check(r.status === 400, 'an office that is not one of its umbrella offices is refused', why(r))
r = await hr.call('POST', '/internal-routes', { name: `Other unit ${stamp}`, steps: [{ office_id: U1.id }, { office_id: RU.id }] })
check(r.status === 400, "another office's umbrella office is refused", why(r))
await hr.call('PATCH', `/offices/umbrellas/${U5.id}`, { is_active: false })
r = await hr.call('POST', '/internal-routes', { name: `Inactive ${stamp}`, steps: [{ office_id: U1.id }, { office_id: U5.id }] })
check(r.status === 400, 'a deactivated unit is refused', why(r))
await hr.call('PATCH', `/offices/umbrellas/${U5.id}`, { is_active: true })
r = await hr.call('POST', '/internal-routes', { ...route3 })
check(r.status === 409, 'the same name twice in one office is refused', why(r))
r = await records.call('GET', '/internal-routes')
check(ok(r) && !r.body.data.some((x: any) => x.id === IR.id), "another office's head doesn't see the route")
r = await records.call('GET', `/internal-routes/${IR.id}`)
check(r.status === 404, "…nor read it by id", r.status)
r = await records.call('PATCH', `/internal-routes/${IR.id}`, { name: 'Taken over' })
check(r.status === 404, '…nor edit it by id', r.status)
r = await records.call('POST', '/internal-routes', { name: `Steal ${stamp}`, steps: [{ office_id: U1.id }, { office_id: U2.id }] })
check(r.status === 400, "…nor build a route out of HR's units", why(r))
r = await u1h.session.call('GET', '/internal-routes')
check(ok(r) && r.body.data.some((x: any) => x.id === IR.id), "an umbrella office's head can read its parent office's routes")
r = await u1h.session.call('POST', '/internal-routes', { name: `Unit ${stamp}`, steps: [{ office_id: U1.id }, { office_id: U2.id }] })
check(r.status === 403, '…but not create one', why(r))
r = await admin.call('GET', `/internal-routes?office_id=${hrOffice.id}`)
check(ok(r) && r.body.data.some((x: any) => x.id === IR.id), 'the ADMIN can read them')
r = await admin.call('POST', '/internal-routes', route3)
check(r.status === 403, 'but organization routes stay the ADMIN’s job: no internal-route editing', r.status)
r = await hs1.session.call('GET', '/internal-routes')
check(r.status === 403, 'staff cannot open the route list', r.status)
r = await hr.call('PATCH', `/internal-routes/${IR2.id}`, { is_active: false })
check(ok(r) && r.body.route.is_active === false, 'deactivate a route', why(r))
r = await hr.call('PATCH', `/internal-routes/${IR2.id}`, { name: `Short renamed ${stamp}`, steps: [{ office_id: U3.id }, { office_id: U1.id }], is_active: true })
check(ok(r) && r.body.route.name === `Short renamed ${stamp}` && r.body.route.steps[0].office_id === U3.id && r.body.route.is_active, 'edit name, steps and reactivate', why(r))
r = await admin.call('POST', '/routes', { name: `Internal is not org ${stamp}`, steps: [{ office_id: U1.id }, { office_id: U2.id }] })
check(r.status === 400, 'umbrella offices still cannot be steps of an organization route', why(r))

// ════════════════════════════════════════════════════════════════════════════════════
console.log('\n3b. Internal route: a whole transaction')
const doc = await upload(hs1.session, 'Internal route doc', orgRouteId)
let d = await detail(hs1.session, doc.id)
check(d?.document?.current_step_number === 1 && d.document.status === 'START' && d.permissions.canStartInternalRoute && d.internal_route_options.some((o: any) => o.id === IR.id), 'received at HR: the receiver may start the internal route', d?.permissions)
r = await hs2.session.call('POST', `/documents/${doc.id}/internal-start`, { route_id: IR.id })
check(r.status === 403 && /received/.test(r.body?.message), 'only the person who received it starts it', why(r))
r = await dNo.session.call('POST', `/documents/${doc.id}/internal-start`, { route_id: IR.id })
check(r.status === 403, 'not even a delegate with the hand-off permission who did not receive it', why(r))
r = await records.call('POST', `/documents/${doc.id}/internal-start`, { route_id: IR.id })
check(r.status === 403 || r.status === 404, "another office can't start it", why(r))
const recRoute = await records.call('POST', '/internal-routes', { name: `Rec ${stamp}`, steps: [{ office_id: RU.id }, { office_id: (await umbrella(records, 'Scan Unit', 'SC')).id }] })
r = await hs1.session.call('POST', `/documents/${doc.id}/internal-start`, { route_id: recRoute.body?.route?.id })
check(r.status === 400, "another office's internal route can't be used here", why(r))
// Two starts at the same moment: one wins, the other is refused (the document row is locked).
const [a1, a2] = await Promise.all([hs1.session.call('POST', `/documents/${doc.id}/internal-start`, { route_id: IR.id, remarks: 'Please check' }), hs1.session.call('POST', `/documents/${doc.id}/internal-start`, { route_id: IR.id })])
check([a1, a2].filter(ok).length === 1 && [a1, a2].some((x) => x.status === 409 || x.status === 403), 'two simultaneous starts: exactly one succeeds, the other is refused', [why(a1), why(a2)])
d = await detail(hs1.session, doc.id)
check(d?.document?.current_step_number === 1 && d.document.status === 'START' && d.document.current_office_id === U1.id, 'it is now at the first unit; route step and status unchanged', d?.document)
check(d?.internal_routes?.length === 1 && d.internal_routes[0].status === 'ACTIVE' && d.internal_routes[0].current_index === 0, 'one active internal transaction, at step 1', d?.internal_routes)
const tripBefore = d.routing.filter((v: any) => v.step_number === 1).length
r = await u1s.session.call('POST', `/documents/${doc.id}/internal-advance`, {})
check(r.status === 409 && /Scan/.test(r.body?.message), 'the unit has to scan it in first', why(r))
r = await u2s.session.call('POST', `/documents/${doc.id}/internal-advance`, {})
check(r.status === 403, 'the next unit cannot move it before it gets it', why(r))
r = await scan(u2s.session, doc.qr_code, 'RECEIVE')
check(r.status === 403, 'the next unit cannot receive it early either', why(r))
r = await scan(u1s.session, doc.qr_code, 'RECEIVE')
check(r.status === 200, 'unit 1 scans it in', why(r))
d = await detail(u1s.session, doc.id)
check(d?.permissions?.canAdvanceInternalRoute && !d.permissions.canRequestPickup && !d.permissions.canSendBack && !d.permissions.canHandToUmbrella && !d.permissions.canStartInternalRoute, 'at the unit: pass on, but no release, send-back, hand-off or second route', d?.permissions)
r = await u1s.session.call('POST', `/documents/${doc.id}/pickup-request`, { liaison_user_id: hm.id })
check(r.status === 409, 'release to a messenger is refused by the server at a unit', why(r))
r = await u1s.session.call('POST', `/documents/${doc.id}/umbrella-handoff`, { umbrella_id: U3.id })
check(r.status === 409, 'a plain hand-off is refused while the internal route runs', why(r))
r = await u1s.session.call('POST', `/documents/${doc.id}/internal-advance`, { remarks: 'Records attached' })
check(r.status === 200 && r.body.completed === false && r.body.document.current_office_id === U2.id, 'unit 1 passes it to unit 2', why(r))
r = await u1s.session.call('POST', `/documents/${doc.id}/internal-advance`, {})
check(r.status === 403 || r.status === 404, 'unit 1 cannot move it again', why(r))
r = await scan(u2s.session, doc.qr_code, 'RECEIVE')
check(r.status === 200, 'unit 2 scans it in', why(r))
r = await u2s.session.call('POST', `/documents/${doc.id}/internal-advance`, {})
check(r.status === 200 && r.body.document.current_office_id === U3.id, 'unit 2 passes it to unit 3', why(r))
r = await scan(u3s.session, doc.qr_code, 'RECEIVE')
r = await u3s.session.call('POST', `/documents/${doc.id}/internal-advance`, {})
check(r.status === 200 && r.body.completed === true && r.body.document.current_office_id === hrOffice.id, 'the last unit finishes it: back to HR', why(r))
d = await detail(hs1.session, doc.id)
const types = d.tracking.map((e: any) => e.event_type)
check(d.document.current_step_number === 1 && d.document.status === 'START' && d.document.route_id === orgRouteId, 'organization route untouched: still step 1 of the same route', d.document)
check(d.internal_routes[0].status === 'COMPLETED' && d.internal_routes[0].steps.every((s: any) => s.state === 'DONE'), 'transaction completed; every step done', d.internal_routes[0])
check(types.filter((t: string) => t === 'INTERNAL_ROUTE_STARTED').length === 1 && types.filter((t: string) => t === 'INTERNAL_ROUTE_MOVED').length === 2 && types.includes('INTERNAL_ROUTE_COMPLETED'), 'history: started, moved twice, completed', types)
check(d.routing.filter((v: any) => v.step_number === 1).length === tripBefore && d.routing.length === 1 + (d.routing[0].step_number === 0 ? 1 : 0), 'no extra route visit was created (no checkpoint completed)', d.routing.map((v: any) => v.step_number))
const moves = d.routing.at(-1).events.filter((e: any) => e.type.startsWith('INTERNAL_ROUTE_'))
check(moves.every((e: any) => e.actor && e.at && e.internal?.route_name === IR.name) && moves[1]?.internal?.to_office?.id === U2.id, 'each move records who, when, the route and where to', moves)
check(d.approvals.length === 0, 'no approval was triggered')
d = await detail(hs1.session, doc.id)
check(!d.permissions.canRequestPickup, 'back at HR it must be scanned in again before release')
r = await scan(hs1.session, doc.qr_code, 'RECEIVE')
check(r.status === 200, 'HR scans it in again', why(r))
r = await hs1.session.call('POST', `/documents/${doc.id}/pickup-request`, { liaison_user_id: hm.id })
check(r.status === 200 || r.status === 201, 'and releases it onward as usual', why(r))

// ════════════════════════════════════════════════════════════════════════════════════
console.log('\n2. Incoming QR label hidden from the destination; receipt rules')
r = await scan(rs.session, doc.qr_code, 'RECEIVE')
check(r.status === 403, 'released but not picked up: the destination cannot receive it', why(r))
r = await scan(hm.session, doc.qr_code, 'PICKUP')
check(r.status === 200, 'the messenger picks it up', why(r))
r = await hm.session.call('POST', `/documents/${doc.id}/transit`)
check(ok(r), 'and is on the way', why(r))
r = await records.call('GET', '/documents?scope=incoming&limit=100')
let inc = r.body?.data?.find((x: any) => x.id === doc.id)
check(inc && inc.qr_code === null && inc.qr_hidden === true, 'incoming list (Department Head): no QR code', inc)
d = await detail(records, doc.id)
check(d?.document?.qr_code === null && d.active_qr === null, 'document page (Department Head): no QR code and no QR image', { qr: d?.document?.qr_code, img: Boolean(d?.active_qr) })
r = await records.call('GET', `/documents?scope=incoming&q=${encodeURIComponent(doc.qr_code)}`)
check(ok(r) && !r.body.data.some((x: any) => x.id === doc.id), 'searching for its code finds nothing', r.body?.data?.length)
r = await records.call('GET', `/documents?scope=incoming&q=${encodeURIComponent(`Internal route doc ${stamp}`)}`)
inc = r.body?.data?.find((x: any) => x.id === doc.id)
check(inc && inc.qr_code === null, 'found by title, still without its code')
r = await recNoReceive.session.call('GET', '/documents?scope=incoming&limit=100')
inc = r.body?.data?.find((x: any) => x.id === doc.id)
check(!inc || inc.qr_code === null, 'delegated head of the destination: no QR code either')
r = await rs.session.call('GET', `/documents/${doc.id}`)
check(r.status === 404 || r.body?.document?.qr_code === null, 'destination staff: no QR code', r.status)
r = await records.call('GET', '/activity?scope=office&days=1&limit=200')
check(ok(r) && !(r.body?.data ?? []).some((x: any) => x.document?.id === doc.id && x.document.qr_code), 'activity log: no QR code for it', why(r))
d = await detail(hs1.session, doc.id)
check(d?.document?.qr_code === doc.qr_code, 'the sending office still sees its code')
d = await detail(hm.session, doc.id)
check(d?.document?.qr_code === doc.qr_code && d.active_qr, 'the messenger carrying it still sees the label')
r = await scan(hs1.session, doc.qr_code, 'RECEIVE')
check(r.status === 403, 'another office cannot receive it by direct API call', why(r))
r = await scan(u1s.session, doc.qr_code, 'RECEIVE')
check(r.status === 403, 'nor a unit of the sending office', why(r))
r = await scan(rs.session, doc.tracking_number, 'RECEIVE')
check(r.status === 400 || r.status === 404, 'the tracking number is not a QR code: it cannot receive it', why(r))
r = await scan(rs.session, `${doc.qr_code.slice(0, -1)}${doc.qr_code.endsWith('0') ? '1' : '0'}`, 'RECEIVE')
check(r.status === 404, 'a guessed code is not found', why(r))
r = await scan(recNoReceive.session, doc.qr_code, 'RECEIVE')
check(r.status === 403 && /Receive documents/.test(r.body?.message), 'destination delegate without "Receive documents" is refused', why(r))
r = await scan(rs.session, doc.qr_code, 'PICKUP')
check(r.status === 409 || r.status === 403, 'the wrong action is refused', why(r))
const [s1, s2] = await Promise.all([scan(rs.session, doc.qr_code, 'RECEIVE'), scan(records, doc.qr_code, 'RECEIVE')])
check([s1, s2].filter((x) => x.status === 200).length === 1, 'two receipts at the same moment: exactly one succeeds', [why(s1), why(s2)])
r = await scan(rs.session, doc.qr_code, 'RECEIVE')
check(r.status === 403, 'receiving again is refused', why(r))
d = await detail(records, doc.id)
check(d?.document?.qr_code === doc.qr_code && d.active_qr, 'once received, the destination sees the QR label', { qr: d?.document?.qr_code })
check(d.routing.filter((v: any) => v.step_number === 2).length === 1, 'exactly one visit at the destination (no duplicate)', d.routing.map((v: any) => v.step_number))

// ════════════════════════════════════════════════════════════════════════════════════
console.log('\n3c. Ending early, editing a route in use, and the plain hand-off')
const doc3 = await upload(hs1.session, 'Ends early', orgRouteId)
r = await hs1.session.call('POST', `/documents/${doc3.id}/internal-start`, { route_id: IR.id })
check(ok(r), 'start the route again on another document', why(r))
r = await hr.call('PATCH', `/internal-routes/${IR.id}`, { steps: [{ office_id: U3.id }, { office_id: U1.id }] })
check(ok(r), 'edit the route while a document is on it', why(r))
await scan(u1s.session, doc3.qr_code, 'RECEIVE')
r = await u1s.session.call('POST', `/documents/${doc3.id}/internal-advance`, {})
check(ok(r) && r.body.document.current_office_id === U2.id, 'the document keeps the steps it started with (goes to unit 2, not the edited path)', why(r))
await scan(u2s.session, doc3.qr_code, 'RECEIVE')
r = await u2s.session.call('POST', `/documents/${doc3.id}/umbrella-return`, { remarks: 'Not needed' })
check(ok(r) && r.body.document.current_office_id === hrOffice.id, 'the unit returns it to its office early', why(r))
d = await detail(hs1.session, doc3.id)
check(d.internal_routes[0].status === 'CANCELLED' && d.internal_routes[0].steps.map((s: any) => s.state).join() === 'DONE,ENDED,SKIPPED' && d.tracking.some((e: any) => e.event_type === 'INTERNAL_ROUTE_ENDED'), 'recorded as ended early; the remaining unit skipped', d.internal_routes[0])
await scan(hs1.session, doc3.qr_code, 'RECEIVE')
r = await hs1.session.call('POST', `/documents/${doc3.id}/umbrella-handoff`, { umbrella_id: U1.id })
check(ok(r), 'the plain umbrella hand-off still works afterwards', why(r))
r = await hs1.session.call('POST', `/documents/${doc3.id}/internal-start`, { route_id: IR.id })
check(r.status === 403 || r.status === 409, 'and an internal route cannot start while a hand-off is out', why(r))
await scan(u1s.session, doc3.qr_code, 'RECEIVE')
r = await u1s.session.call('POST', `/documents/${doc3.id}/internal-advance`, {})
check(r.status === 409, 'a hand-off is not an internal route (nothing to advance)', why(r))
r = await u1s.session.call('POST', `/documents/${doc3.id}/umbrella-return`, {})
check(ok(r), '…and returns the usual way', why(r))
r = await hr.call('PATCH', `/internal-routes/${IR.id}`, { is_active: false })
await scan(hs1.session, doc3.qr_code, 'RECEIVE')
r = await hs1.session.call('POST', `/documents/${doc3.id}/internal-start`, { route_id: IR.id })
check(r.status === 400, 'a deactivated route cannot be started', why(r))

console.log(`\n${passed} passed, ${failed} failed`)
process.exit(failed ? 1 : 0)
