/**
 * Global Routing vs. Internal Process at upload, end to end, against a running app on a THROWAWAY database with
 * the demo seed and the 2026-11-06-internal-process schema (FlowVision's .env database is the shared Hostinger
 * one, local development included — never run this there):
 *
 *   (start the app with DB_* pointing at the throwaway database)
 *   node tests/internal-process-api.test.ts --base=http://localhost:3010
 *
 * Which internal routes an account may choose (its own main office's only — never another office's, a sibling
 * unit's, a deactivated one, or for an umbrella office or the ADMIN); the routing-mode checks on upload, draft
 * edit and submission; an internal process going through two units, coming back and being decided by its office
 * without ever visiting, notifying or counting for another office; returning and resubmitting it (also as a
 * global route); drafts keeping their choice; and staff a Department Head makes responsible for internal routes.
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
  console.error(`Refusing to run against ${BASE}: this test creates accounts and documents. Use a local app on a throwaway database, or add --remote.`)
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
  console.error(`The app is not reachable at ${BASE}.`)
  process.exit(1)
}

const stamp = Date.now().toString().slice(-6)
const ok = (r: Res) => r.status === 200 || r.status === 201
const why = (r: Res) => `${r.status} ${r.body?.message ?? ''}`
const admin = await login('client@bago.gov.ph')
const hr = await login('hr@bago.gov.ph') // managing Department Head of HR (a main office)
const records = await login('records@bago.gov.ph') // managing Department Head of Records (another main office)
const hs = await login('hr.staff@bago.gov.ph') // STAFF of HR, its approver in the demo seed
const liaison = await login('liaison.hr@bago.gov.ph')
const hrOffice = hr.user.office
const recordsOffice = records.user.office

async function account(by: Session, body: Record<string, unknown>) {
  const r = await by.call('POST', '/users', { first_name: 'I', ...body })
  if (r.status !== 201) throw new Error(`could not create ${body.email}: ${why(r)}`)
  return { id: r.body.user.id as string, session: await login(body.email as string, r.body.temporary_password) }
}
async function umbrella(by: Session, name: string, head?: string) {
  const r = await by.call('POST', '/offices/umbrellas', { name: `${name} ${stamp}`, ...(head && { head: { mode: 'new', first_name: 'U', last_name: 'Head', email: head, permissions: ['RECEIVE_DOCUMENTS', 'PASS_DOCUMENTS', 'UMBRELLA_HANDOFF', 'UPLOAD_DOCUMENTS'] } }) })
  if (r.status !== 201) throw new Error(`could not add umbrella ${name}: ${why(r)}`)
  return { office: r.body.office, headSession: head ? await login(head, r.body.temporary_password) : null }
}
async function internalRoute(by: Session, name: string, units: any[]) {
  const r = await by.call('POST', '/internal-routes', { name: `${name} ${stamp}`, description: `${name} (test)`, steps: units.map((u) => ({ office_id: u.id, action_label: `Check at ${u.name}` })) })
  if (r.status !== 201) throw new Error(`could not add internal route ${name}: ${why(r)}`)
  return r.body.route
}
const png = () => new Blob([Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64')], { type: 'image/png' })
function form(title: string, fields: Record<string, string>, submit = true) {
  const fd = new FormData()
  fd.append('title', `${title} ${stamp}`)
  for (const [k, v] of Object.entries(fields)) fd.append(k, v)
  fd.append('submit', String(submit))
  fd.append('file', png(), 'page.png')
  return fd
}
const upload = (by: Session, title: string, fields: Record<string, string>, submit = true) => by.call('POST', '/documents', form(title, fields, submit))
const detail = async (s: Session, id: string) => (await s.call('GET', `/documents/${id}`)).body
const qrOf = async (s: Session, id: string) => (await detail(admin, id)).document.qr_code as string
const scan = (s: Session, payload: string, action?: string) => s.call('POST', '/qr/scan', { payload, ...(action && { action }) })
const step = async (label: string, r: Res) => {
  check(ok(r), label, why(r))
  return r
}
// Errors are { statusCode, message, data: { code, details } }; a 400 names its field in details.
const refused = (r: Res, status: number, label: string, field?: string) =>
  check(r.status === status && (!field || r.body?.data?.details?.field === field), label, { status: r.status, message: r.body?.message, field: r.body?.data?.details?.field })
const perf = async (s: Session) => (await s.call('GET', '/dashboard/umbrella-performance')).body
const officeIn = (body: any, id: string) => (body?.offices ?? []).find((o: any) => o.office.id === id)

// ── Setup ────────────────────────────────────────────────────────────────────────────────────────────
const u1 = await umbrella(hr, 'IP Unit One', `ip.u1head.${stamp}@test.local`)
const u2 = await umbrella(hr, 'IP Unit Two')
const r1 = await umbrella(records, 'IP Records One')
const r2 = await umbrella(records, 'IP Records Two')
const U1 = u1.office
const U2 = u2.office
const u1s = await account(hr, { account_type: 'STAFF', office_id: U1.id, last_name: 'UnitOne', email: `ip.u1s.${stamp}@test.local` })
const u2s = await account(hr, { account_type: 'STAFF', office_id: U2.id, last_name: 'UnitTwo', email: `ip.u2s.${stamp}@test.local` })
const hs2 = await account(hr, { account_type: 'STAFF', office_id: hrOffice.id, last_name: 'Second', email: `ip.hs2.${stamp}@test.local` })
const narrow = await account(hr, { account_type: 'DEPARTMENT_HEAD', last_name: 'Narrow', email: `ip.narrow.${stamp}@test.local`, permissions: ['RECEIVE_DOCUMENTS', 'UPLOAD_DOCUMENTS'] })
const IR = await internalRoute(hr, 'IP path', [U1, U2])
const IR2 = await internalRoute(hr, 'IP second path', [U2, U1])
const IRoff = await internalRoute(hr, 'IP retired path', [U1, U2])
await hr.call('PATCH', `/internal-routes/${IRoff.id}`, { is_active: false })
const RR = await internalRoute(records, 'IP records path', [r1.office, r2.office])
const gr = await admin.call('POST', '/routes', { name: `IP HR then Records ${stamp}`, steps: [hrOffice, recordsOffice].map((o) => ({ office_id: o.id, action_label: 'Review' })) })
if (gr.status !== 201) throw new Error(`could not add route: ${why(gr)}`)
const GR = gr.body.route.id as string

// ── 1. Which internal routes an account may choose ──────────────────────────────────────────────────
console.log('\n1. Internal routes offered at upload')
let r = await hs.call('GET', '/documents/internal-process-routes')
const offered = (r.body?.data ?? []).map((x: any) => x.id)
check(r.status === 200 && r.body.available && r.body.office?.id === hrOffice.id, 'HR staff: Internal Process is offered, for HR', r.body)
check(offered.includes(IR.id) && offered.includes(IR2.id), '…with HR’s active internal routes', offered)
check(!offered.includes(IRoff.id), '…not a deactivated one', offered)
check(!offered.includes(RR.id), '…never another office’s', offered)
check((r.body.data ?? []).find((x: any) => x.id === IR.id)?.steps?.map((s: any) => s.office_id).join() === [U1.id, U2.id].join(), '…with each route’s steps in order', r.body.data?.[0]?.steps)
r = await hr.call('GET', '/documents/internal-process-routes')
check(r.status === 200 && r.body.available && r.body.data.some((x: any) => x.id === IR.id), 'HR’s Department Head: the same', why(r))
r = await records.call('GET', '/documents/internal-process-routes')
check(r.status === 200 && r.body.data.some((x: any) => x.id === RR.id) && !r.body.data.some((x: any) => x.id === IR.id), 'Records: only Records’ routes', r.body?.data?.map((x: any) => x.name))
for (const [label, s] of [['an umbrella office’s Department Head', u1.headSession!], ['an umbrella office’s staff', u1s.session], ['the ADMIN', admin]] as const) {
  r = await s.call('GET', '/documents/internal-process-routes')
  check(r.status === 200 && !r.body.available && !r.body.data.length && r.body.reason, `${label}: none offered (never its parent’s or a sibling’s)`, r.body)
}
r = await narrow.session.call('GET', '/documents/internal-process-routes')
check(r.status === 200 && !r.body.available, 'a delegated head without “Hand to umbrella offices”: none offered', r.body)
r = await liaison.call('GET', '/documents/internal-process-routes')
check(r.status === 403, 'a messenger: 403', why(r))
const anon = await fetch(`${BASE}/api/documents/internal-process-routes`)
check(anon.status === 401, 'without a session: 401', anon.status)

// ── 2. Routing mode checks on upload ─────────────────────────────────────────────────────────────────
console.log('\n2. Routing mode checks')
refused(await upload(hs, 'IP bad mode', { routing_mode: 'LOCAL', route_id: GR }), 400, 'an invalid routing mode is refused', 'routing_mode')
refused(await upload(hs, 'IP no mode', { internal_route_id: IR.id }), 400, 'an internal route without a routing mode is refused', 'routing_mode')
refused(await upload(hs, 'IP global+internal', { routing_mode: 'GLOBAL', route_id: GR, internal_route_id: IR.id }), 400, 'Global Routing with an internal route is refused', 'internal_route_id')
refused(await upload(hs, 'IP internal+global', { routing_mode: 'INTERNAL', route_id: GR }), 400, 'Internal Process with a Document Route is refused', 'route_id')
refused(await upload(hs, 'IP internal missing', { routing_mode: 'INTERNAL' }), 400, 'Internal Process without an internal route is refused', 'internal_route_id')
refused(await upload(hs, 'IP bad id', { routing_mode: 'INTERNAL', internal_route_id: 'payroll' }), 400, 'an invalid route id is refused', 'internal_route_id')
refused(await upload(hs, 'IP unknown id', { routing_mode: 'INTERNAL', internal_route_id: crypto.randomUUID() }), 400, 'an internal route that doesn’t exist is refused', 'internal_route_id')
refused(await upload(hs, 'IP other office', { routing_mode: 'INTERNAL', internal_route_id: RR.id }), 400, 'another office’s internal route is refused', 'internal_route_id')
refused(await upload(hs, 'IP retired', { routing_mode: 'INTERNAL', internal_route_id: IRoff.id }), 400, 'a deactivated internal route is refused', 'internal_route_id')
refused(await upload(hs, 'IP global as internal', { routing_mode: 'INTERNAL', internal_route_id: GR }), 400, 'a Document Route id sent as an internal route is refused', 'internal_route_id')
refused(await upload(u1.headSession!, 'IP unit head', { routing_mode: 'INTERNAL', internal_route_id: IR.id }), 403, 'an umbrella office’s head cannot use its parent’s internal route')
refused(await upload(admin, 'IP admin', { routing_mode: 'INTERNAL', internal_route_id: IR.id }), 403, 'the ADMIN (no office) cannot start an internal process')
r = await liaison.call('POST', '/documents', form('IP liaison', { routing_mode: 'INTERNAL', internal_route_id: IR.id }))
check(r.status === 403, 'a messenger cannot upload at all', why(r))

// Global Routing is unchanged, with or without the mode.
r = await upload(hs, 'IP global', { routing_mode: 'GLOBAL', route_id: GR })
check(r.status === 201 && r.body.document.routing_mode === 'GLOBAL' && r.body.document.route_id === GR && !r.body.document.internal_process_route_id, 'Global Routing: on its Document Route', r.body?.document ?? why(r))
check(r.body?.document?.current_step_number === 1 && r.body.document.qr_code, '…starting at HR, step 1, with its QR label', r.body?.document)
r = await upload(hs, 'IP legacy', { route_id: GR })
check(r.status === 201 && r.body.document.routing_mode === 'GLOBAL' && r.body.document.route_id === GR, 'an upload without a routing mode (older clients) is still Global Routing', why(r))

// ── 3. An internal process, through its units and back, decided by HR ───────────────────────────────
console.log('\n3. An internal process')
const perfBefore = { hr: await perf(hr), records: await perf(records) }
const recordsNotesBefore = new Set(((await records.call('GET', '/notifications?limit=100')).body.data as any[]).map((n) => n.id))
r = await upload(hs, 'IP internal', { routing_mode: 'INTERNAL', internal_route_id: IR.id })
check(r.status === 201, 'HR staff submit an internal process', why(r))
const A = r.body.document
check(A.routing_mode === 'INTERNAL' && A.route_id === null && A.internal_process_route_id === IR.id && A.internal_process_name === IR.name, '…with no Document Route, only its internal route', A)
check(A.status === 'START' && A.current_step_number === 1 && A.current_office_id === U1.id, '…sent at once to the first unit (step 1 of its office, never advanced)', { status: A.status, step: A.current_step_number, at: A.current_office_id })
check(Boolean(A.qr_code), '…with its QR label', A.qr_code)
let d = await detail(hs, A.id)
check(d.route === null && d.internal_process?.id === IR.id && d.internal_process?.office_id === hrOffice.id, 'the document page: its internal process in place of a route', { route: d.route, ip: d.internal_process?.id })
check(d.internal_routes?.[0]?.status === 'ACTIVE' && d.internal_routes[0].route_id === IR.id && d.internal_routes[0].parent_office_id === hrOffice.id, '…following it with the existing internal-route engine', d.internal_routes?.[0])
const qrA = await qrOf(admin, A.id)
await step('Unit One receives it', await scan(u1s.session, qrA, 'RECEIVE'))
r = await u1s.session.call('POST', `/documents/${A.id}/pickup-request`, { liaison_user_id: liaison.user.id })
check(r.status === 409, 'a unit cannot release it to a messenger', why(r))
await step('Unit One passes it on to Unit Two', await u1s.session.call('POST', `/documents/${A.id}/internal-advance`, {}))
await step('Unit Two receives it', await scan(u2s.session, qrA, 'RECEIVE'))
d = await detail(hs, A.id)
check(!d.pending_approval && !d.permissions.canApprove, 'no decision while a unit has it', d.pending_approval)
await step('Unit Two sends it back to HR (internal route complete)', await u2s.session.call('POST', `/documents/${A.id}/internal-advance`, {}))
d = await detail(admin, A.id)
check(d.document.current_office_id === hrOffice.id && d.document.current_step_number === 1 && d.document.route_id === null, 'back at HR, still step 1, still no Document Route', d.document)
check(d.internal_routes?.[0]?.status === 'COMPLETED', '…its internal route completed', d.internal_routes?.[0]?.status)
d = await detail(hs, A.id)
check(!d.pending_approval, 'no decision before HR scans it in', d.pending_approval)
await step('HR scans it back in', await scan(hs, qrA, 'RECEIVE'))
d = await detail(hs, A.id)
check(Boolean(d.pending_approval) && d.permissions.canApprove, 'then HR is asked to decide (its office is its only checkpoint)', { pending: d.pending_approval, canApprove: d.permissions?.canApprove })
check(!d.permissions.canRequestPickup && !d.permissions.canSendBack, '…and cannot release it to a messenger or send it back', d.permissions)
check(d.routing_slip?.first_destination === hrOffice.name && d.routing_slip?.final_destination === hrOffice.name, 'the routing slip: HR is where it goes and where it ends', d.routing_slip)
r = await hs.call('POST', `/documents/${A.id}/pickup-request`, { liaison_user_id: liaison.user.id })
check(r.status === 409 && r.body?.data?.code === 'INTERNAL_PROCESS', 'releasing it to a messenger is refused', { status: r.status, body: r.body })
r = await hs.call('POST', `/documents/${A.id}/send-back`, { title: `IP missing page ${stamp}`, category: 'MISSING_DOCUMENT' })
check(r.status === 409 && r.body?.data?.code === 'INTERNAL_PROCESS', 'sending it back is refused (no previous office)', { status: r.status, body: r.body })
const visitsA = (d.routing ?? []) as any[]
check(visitsA.length === 1 && visitsA[0].office?.id === hrOffice.id && visitsA[0].step_number === 1, 'one tracking visit only, at HR: no visit for any other office', visitsA.map((v) => [v.step_number, v.office?.name]))
await step('HR approves it', await hs.call('PATCH', `/approvals/${d.pending_approval.id}`, { decision: 'APPROVED', remarks: 'Done internally' }))
d = await detail(admin, A.id)
check(d.document.status === 'COMPLETED' && d.document.current_step_number === 1 && d.document.route_id === null, 'completed at HR, as an internal process', d.document)
const recordsNew = ((await records.call('GET', '/notifications?limit=100')).body.data as any[]).filter((n) => !recordsNotesBefore.has(n.id) && n.document_id === A.id)
check(recordsNew.length === 0, 'Records (another main office) was never notified about it', recordsNew.map((n) => n.title))
const perfAfter = { hr: await perf(hr), records: await perf(records) }
const delta = (a: any, b: any, id: string, k: string) => (officeIn(a, id)?.[k] ?? 0) - (officeIn(b, id)?.[k] ?? 0)
check(delta(perfAfter.records, perfBefore.records, recordsOffice.id, 'received') === 0, 'Records’ office performance is unchanged (no work counted there)', officeIn(perfAfter.records, recordsOffice.id))
check(delta(perfAfter.hr, perfBefore.hr, hrOffice.id, 'completed') === 1, 'HR completed it once', { before: officeIn(perfBefore.hr, hrOffice.id)?.completed, after: officeIn(perfAfter.hr, hrOffice.id)?.completed })
check(delta(perfAfter.hr, perfBefore.hr, U1.id, 'received') === 1 && delta(perfAfter.hr, perfBefore.hr, U2.id, 'received') === 1, 'each unit received it once', { u1: officeIn(perfAfter.hr, U1.id)?.received, u2: officeIn(perfAfter.hr, U2.id)?.received })

// ── 4. Returned, then resubmitted: as an internal process again, then on a global route ─────────────
console.log('\n4. Return and resubmit')
r = await upload(hs, 'IP returned', { routing_mode: 'INTERNAL', internal_route_id: IR.id })
const B = r.body.document
const qrB = await qrOf(admin, B.id)
await scan(u1s.session, qrB, 'RECEIVE')
await u1s.session.call('POST', `/documents/${B.id}/internal-advance`, {})
await scan(u2s.session, qrB, 'RECEIVE')
await u2s.session.call('POST', `/documents/${B.id}/internal-advance`, {})
await scan(hs, qrB, 'RECEIVE')
d = await detail(hs, B.id)
await step('HR returns it to the uploader', await hs.call('PATCH', `/approvals/${d.pending_approval?.id}`, { decision: 'RETURNED', remarks: 'Fix the page count' }))
r = await hs.call('POST', `/documents/${B.id}/submit`, { routing_mode: 'INTERNAL', internal_route_id: RR.id })
check(r.status === 400, 'resubmitting with another office’s internal route is refused', why(r))
r = await hs.call('POST', `/documents/${B.id}/submit`, { routing_mode: 'INTERNAL', internal_route_id: IR2.id })
check(r.status === 200 && r.body.document.status === 'START' && r.body.document.internal_process_route_id === IR2.id && r.body.document.current_office_id === U2.id, 'resubmitted as an internal process on another of HR’s routes', r.body?.document ?? why(r))
d = await detail(hs, B.id)
check(!d.pending_approval, 'no decision is asked while it is on its way again', d.pending_approval)
// Ended early, back at HR, decided again (returned) — then resubmitted on a global route.
await scan(u2s.session, qrB, 'RECEIVE')
await step('the unit ends the internal route early', await u2s.session.call('POST', `/documents/${B.id}/umbrella-return`, {}))
await scan(hs, qrB, 'RECEIVE')
d = await detail(hs, B.id)
check(Boolean(d.pending_approval), 'ended early and back: HR decides', d.pending_approval)
r = await hs.call('POST', `/documents/${B.id}/internal-start`, { route_id: IR.id })
check(r.status === 400, 'it can’t start a different internal route than its own', why(r))
await hs.call('PATCH', `/approvals/${d.pending_approval?.id}`, { decision: 'RETURNED', remarks: 'Send it through the offices' })
r = await hs.call('POST', `/documents/${B.id}/submit`, { routing_mode: 'GLOBAL', route_id: GR })
check(
  r.status === 200 && r.body.document.routing_mode === 'GLOBAL' && r.body.document.route_id === GR && !r.body.document.internal_process_route_id && r.body.document.current_step_number === 1,
  'resubmitted on a global route instead: it leaves its internal route',
  r.body?.document ?? why(r),
)

// ── 5. Drafts keep the choice; it is checked again on submission ────────────────────────────────────
console.log('\n5. Drafts')
r = await upload(hs, 'IP draft', { routing_mode: 'INTERNAL', internal_route_id: IR2.id }, false)
const C = r.body?.document
check(r.status === 201 && C.status === 'CREATED' && C.routing_mode === 'INTERNAL' && C.internal_process_route_id === IR2.id, 'a draft saved as an internal process', C ?? why(r))
d = await detail(hs, C.id)
check(d.document.internal_process_route_id === IR2.id && d.internal_process?.id === IR2.id, 'reopened, it still has its internal route', d.internal_process?.id)
const patch = (fields: Record<string, string>) => {
  const fd = new FormData()
  for (const [k, v] of Object.entries(fields)) fd.append(k, v)
  return hs.call('PATCH', `/documents/${C.id}`, fd)
}
r = await patch({ routing_mode: 'GLOBAL', route_id: GR })
check(r.status === 200 && r.body.document.routing_mode === 'GLOBAL' && r.body.document.route_id === GR && !r.body.document.internal_process_route_id, 'switching the draft to Global Routing clears its internal route', r.body?.document ?? why(r))
r = await patch({ routing_mode: 'INTERNAL', internal_route_id: IR2.id })
check(r.status === 200 && r.body.document.routing_mode === 'INTERNAL' && r.body.document.route_id === null, '…and back to Internal Process clears its Document Route', r.body?.document ?? why(r))
r = await patch({ routing_mode: 'INTERNAL', internal_route_id: RR.id })
check(r.status === 400, 'a draft can’t take another office’s internal route', why(r))
r = await patch({ routing_mode: 'INTERNAL', route_id: GR })
check(r.status === 400, 'a draft can’t mix the modes', why(r))
await hr.call('PATCH', `/internal-routes/${IR2.id}`, { is_active: false })
r = await hs.call('POST', `/documents/${C.id}/submit`)
check(r.status === 400, 'its internal route was deactivated since: submitting it is refused (checked again)', why(r))
await hr.call('PATCH', `/internal-routes/${IR2.id}`, { is_active: true })
r = await hs.call('POST', `/documents/${C.id}/submit`, { routing_mode: 'GLOBAL', internal_route_id: IR.id })
check(r.status === 400, 'submitting with a mismatched combination is refused', why(r))
r = await hs.call('POST', `/documents/${C.id}/submit`)
check(r.status === 200 && r.body.document.status === 'START' && r.body.document.internal_process_route_id === IR2.id && r.body.document.current_office_id === U2.id, 'submitted on the internal route it was saved with', r.body?.document ?? why(r))
r = await upload(hs2.session, 'IP not mine', { routing_mode: 'GLOBAL', route_id: GR }, false)
const D = r.body.document
r = await hr.call('POST', `/documents/${D.id}/submit`, { routing_mode: 'INTERNAL', internal_route_id: IR.id })
check(r.status === 403, 'nobody else can submit someone’s draft into an internal process', why(r))

// ── 6. Staff responsible for internal routes ─────────────────────────────────────────────────────────
console.log('\n6. Staff and internal routes')
r = await hs2.session.call('GET', '/internal-routes')
check(r.status === 200 && r.body.can_manage === false && r.body.data.some((x: any) => x.id === IR.id), 'HR staff can view HR’s internal routes, read-only', { status: r.status, can_manage: r.body?.can_manage })
r = await hs2.session.call('POST', '/internal-routes', { name: `IP staff path ${stamp}`, steps: [{ office_id: U1.id }, { office_id: U2.id }] })
check(r.status === 403, '…and cannot create one', why(r))
r = await u1s.session.call('GET', '/internal-routes')
check(r.status === 200 && r.body.can_manage === false && r.body.data.some((x: any) => x.id === IR.id), 'an umbrella office’s staff view their office’s routes, read-only', { status: r.status, n: r.body?.data?.length })
r = await hr.call('PATCH', `/users/${hs2.id}`, { manages_internal_routes: true })
check(r.status === 200 && r.body.user.manages_internal_routes === true, 'HR’s head makes a staff member responsible for internal routes', r.body?.user ?? why(r))
r = await hs2.session.call('GET', '/internal-routes')
check(r.body?.can_manage === true, '…who can now manage them', r.body?.can_manage)
r = await hs2.session.call('POST', '/internal-routes', { name: `IP staff path ${stamp}`, steps: [{ office_id: U2.id }, { office_id: U1.id }] })
check(r.status === 201 && r.body.route.office_id === hrOffice.id, '…creates one for HR', why(r))
const staffRoute = r.body?.route
if (staffRoute) {
  r = await hs2.session.call('PATCH', `/internal-routes/${staffRoute.id}`, { description: 'Edited by staff' })
  check(r.status === 200 && r.body.route.description === 'Edited by staff', '…and edits it', why(r))
  r = await hr.call('GET', '/internal-routes')
  check(r.body.data.some((x: any) => x.id === staffRoute.id) && r.body.can_manage === true, 'the head sees it and still manages them too', r.body?.can_manage)
}
r = await hs.call('POST', '/internal-routes', { name: `IP other staff ${stamp}`, steps: [{ office_id: U1.id }, { office_id: U2.id }] })
check(r.status === 403, 'other staff still cannot', why(r))
r = await hr.call('PATCH', `/users/${u1s.id}`, { manages_internal_routes: true })
check(r.status === 400, 'an umbrella office’s staff cannot be made responsible (its routes are the main office’s)', why(r))
r = await records.call('PATCH', `/users/${hs2.id}`, { manages_internal_routes: false })
check(r.status === 404, 'another office’s head cannot change it', why(r))
r = await narrow.session.call('PATCH', `/users/${hs2.id}`, { manages_internal_routes: false })
check(r.status === 403 || r.status === 404, 'a delegated head without “Manage internal routes” cannot change it', why(r))
r = await hr.call('PATCH', `/users/${hs2.id}`, { manages_internal_routes: 'yes' })
check(r.status === 400, 'the grant must be true or false', why(r))
r = await hr.call('PATCH', `/users/${hs2.id}`, { office_id: U1.id })
check(r.status === 200 && r.body.user.manages_internal_routes === false, 'moving them to an umbrella office takes the grant away', r.body?.user ?? why(r))
await hr.call('PATCH', `/users/${hs2.id}`, { office_id: hrOffice.id })
r = await hs2.session.call('POST', '/internal-routes', { name: `IP after move ${stamp}`, steps: [{ office_id: U1.id }, { office_id: U2.id }] })
check(r.status === 403, '…and it doesn’t come back by itself', why(r))

console.log(`\n${passed} passed, ${failed} failed`)
process.exitCode = failed ? 1 : 0
