/**
 * A document's origin office and the organization route, end to end, against a running app:
 * uploads from main offices and umbrella offices, the first-office rule, hand-offs, internal routes,
 * send-backs, resubmission, messengers, QR receipt, the timeline and notifications.
 *
 *   npm run dev                              (another terminal; LOCAL database with the demo seed, migrated)
 *   npm run test:document-origin-api         (or: node tests/document-origin-api.test.ts --base=http://localhost:3000)
 *
 * With --db it also blanks one document's origin in the database, to act as a document from before the
 * migration (shown as "Origin not recorded", its send-back to step 0 refused until an administrator records
 * the origin by hand), and adds an office of another organization for the cross-organization check. It reads DB_HOST, DB_PORT, DB_USER, DB_PASS and DB_NAME from the environment, never from .env,
 * and refuses a host that isn't local.
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
  return { id: r.body.user.id as string, session: await login(body.email as string, r.body.temporary_password) }
}
async function umbrella(by: Session, name: string, suffix: string) {
  const r = await by.call('POST', '/offices/umbrellas', { name: `${name} ${stamp}`, code: `${by.user.office.code}-${suffix}${stamp}` })
  if (r.status !== 201) throw new Error(`could not add umbrella ${name}: ${why(r)}`)
  return r.body.office
}
const png = () => new Blob([Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64')], { type: 'image/png' })
async function post(by: Session, title: string, routeId: string, extra: Record<string, string> = {}) {
  const fd = new FormData()
  fd.append('title', `${title} ${stamp}`)
  fd.append('route_id', routeId)
  fd.append('submit', 'true')
  fd.append('file', png(), 'page.png')
  for (const [k, v] of Object.entries(extra)) fd.set(k, v)
  return by.call('POST', '/documents', fd)
}
async function upload(by: Session, title: string, routeId: string, extra: Record<string, string> = {}) {
  const r = await post(by, title, routeId, extra)
  if (r.status !== 201) throw new Error(`upload failed: ${why(r)}`)
  return r.body.document
}
const scan = (s: Session, payload: string, action?: string) => s.call('POST', '/qr/scan', { payload, ...(action && { action }) })
const detail = async (s: Session, id: string) => (await s.call('GET', `/documents/${id}`)).body
const qrOf = async (s: Session, id: string) => (await detail(s, id)).document.qr_code as string
const eventsOf = async (s: Session, id: string) => {
  return ((await s.call('GET', `/documents/${id}/timeline`)).body?.data ?? []) as any[]
}
const countOf = (events: any[], type: string) => events.filter((e) => e.event_type === type).length

// ── Setup: two units under HR, one under Records, people, and routes ─────────────────────
const U1 = await umbrella(hr, 'Sanitation Unit', 'SU')
const U2 = await umbrella(hr, 'Environment Unit', 'EU')
const U3 = await umbrella(hr, 'Closing Unit', 'CU')
const hs = await account(hr, { account_type: 'STAFF', office_id: hrOffice.id, last_name: 'HrStaff', email: `dor.hs.${stamp}@test.local` })
const us = await account(hr, { account_type: 'STAFF', office_id: U1.id, last_name: 'UnitStaff', email: `dor.us.${stamp}@test.local` })
const us2 = await account(hr, { account_type: 'STAFF', office_id: U2.id, last_name: 'UnitTwo', email: `dor.us2.${stamp}@test.local` })
const mover = await account(hr, { account_type: 'STAFF', office_id: U1.id, last_name: 'Mover', email: `dor.mover.${stamp}@test.local` })
const closing = await account(hr, { account_type: 'STAFF', office_id: U3.id, last_name: 'Closing', email: `dor.closing.${stamp}@test.local` })
const rs = await account(records, { account_type: 'STAFF', office_id: recordsOffice.id, last_name: 'RecStaff', email: `dor.rs.${stamp}@test.local` })
const hm = await account(hr, { account_type: 'LIAISON', office_id: hrOffice.id, last_name: 'Messenger', email: `dor.hm.${stamp}@test.local` })
const um = await account(hr, { account_type: 'LIAISON', office_id: U1.id, last_name: 'UnitMessenger', email: `dor.um.${stamp}@test.local` })
await hm.session.call('PATCH', '/liaisons/me', { availability: 'AVAILABLE' })
await um.session.call('PATCH', '/liaisons/me', { availability: 'AVAILABLE' })
const route = async (name: string, offices: any[]) => {
  const r = await admin.call('POST', '/routes', { name: `Origin ${name} ${stamp}`, steps: offices.map((o) => ({ office_id: o.id, action_label: 'Review' })) })
  if (r.status !== 201) throw new Error(`could not add route ${name}: ${why(r)}`)
  return r.body.route.id as string
}
const hrFirst = await route('HR first', [hrOffice, recordsOffice])
const recordsFirst = await route('Records first', [recordsOffice, hrOffice])
const hrOnly = await route('HR only', [hrOffice])

// ════════════════════════════════════════════════════════════════════════════════════
console.log('\n1. Main-office uploader')
let doc = await upload(hs.session, 'Main, other first office', recordsFirst)
let d = await detail(hs.session, doc.id)
check(d.document.current_step_number === 0 && d.document.current_office_id === hrOffice.id, 'starts at its origin, step 0, at the office', d.document)
check(d.document.origin?.office_id === hrOffice.id && d.document.origin.recorded === true && d.document.origin.main_office === null, 'origin: the office, no unit', d.document.origin)
doc = await upload(hs.session, 'Main, first office', hrFirst)
d = await detail(hs.session, doc.id)
check(d.document.current_step_number === 1 && Boolean(d.document.received_by), 'the first-office shortcut still applies: step 1, already received', d.document)
check(d.routing.length === 1, 'one visit, not two', d.routing)
check(d.document.origin?.office_id === hrOffice.id && d.document.origin.main_office === null, 'origin recorded on the shortcut too', d.document.origin)

// ════════════════════════════════════════════════════════════════════════════════════
console.log('\n2 + 4. Umbrella uploader, route begins with the parent office')
const fromUnit = await upload(us.session, 'From the unit', hrFirst)
d = await detail(us.session, fromUnit.id)
check(d.document.origin?.office_id === U1.id && d.document.origin.main_office?.id === hrOffice.id && d.document.origin.recorded === true, 'origin: the unit, with its parent as the main office', d.document.origin)
check(d.document.submitted_by === us.id, 'the uploader is kept', d.document.submitted_by)
check(d.document.current_step_number === 0 && d.document.current_office_id === U1.id, 'the shortcut does not apply: the unit holds it at step 0', d.document)
check(!d.document.received_by || d.document.received_by.id === us.id, 'not marked received by the parent office', d.document.received_by)
check(d.route.steps.length === 2 && !d.route.steps.some((s: any) => s.office_id === U1.id), 'the unit is not a route step', d.route.steps)
check(d.document.next_office_name === hrOffice.name, 'the next office is the first step of the route', d.document.next_office_name)
check(d.routing.length === 1, 'one visit so far', d.routing)
const fromUnitQr = await qrOf(us.session, fromUnit.id)
let r = await scan(us2.session, fromUnitQr)
check(r.status === 403, 'a sibling unit cannot receive it', why(r))
r = await scan(hs.session, fromUnitQr, 'RECEIVE')
d = await detail(hs.session, fromUnit.id)
check(ok(r) && d.document.current_step_number === 1 && d.document.current_office_id === hrOffice.id, 'the parent office scans it in, brought by hand: step 1, not step 2', why(r))
check(d.routing.length === 2, 'two visits: origin and first office', d.routing)
check(d.document.origin?.office_id === U1.id, 'the origin is still the unit', d.document.origin)
r = await scan(hs.session, fromUnitQr)
check(!ok(r), 'scanning again does not receive it twice', why(r))

// ════════════════════════════════════════════════════════════════════════════════════
console.log('\n9. Umbrella hand-off and return (another unit than the origin)')
r = await hs.session.call('POST', `/documents/${fromUnit.id}/umbrella-handoff`, { umbrella_id: U2.id })
d = await detail(us2.session, fromUnit.id)
check(ok(r) && d.document.current_office_id === U2.id && d.document.current_step_number === 1, 'handed off: at the other unit, the step does not change', why(r))
check(d.document.origin?.office_id === U1.id, 'the origin stays the original unit', d.document.origin)
r = await scan(us2.session, fromUnitQr, 'RECEIVE')
check(ok(r), 'the unit scans it in', why(r))
r = await us2.session.call('POST', `/documents/${fromUnit.id}/umbrella-return`, {})
d = await detail(hs.session, fromUnit.id)
check(ok(r) && d.document.current_office_id === hrOffice.id && d.document.current_step_number === 1, 'returned to the office, same step', why(r))
check(d.document.origin?.office_id === U1.id, 'the origin survives the return', d.document.origin)
r = await scan(hs.session, fromUnitQr, 'RECEIVE')
check(ok(r), 'the office scans it in again', why(r))

// ════════════════════════════════════════════════════════════════════════════════════
console.log('\n10. Internal route through two units')
r = await hr.call('POST', '/internal-routes', { name: `Origin path ${stamp}`, steps: [{ office_id: U2.id }, { office_id: U1.id }] })
const internalId = r.body?.route?.id
check(r.status === 201, 'internal route created', why(r))
r = await hs.session.call('POST', `/documents/${fromUnit.id}/internal-start`, { route_id: internalId })
d = await detail(us2.session, fromUnit.id)
check(ok(r) && d.document.current_office_id === U2.id && d.document.current_step_number === 1, 'started: at the first unit, same step', why(r))
await scan(us2.session, fromUnitQr, 'RECEIVE')
r = await us2.session.call('POST', `/documents/${fromUnit.id}/internal-advance`, {})
check(ok(r), 'moved to the next unit', why(r))
await scan(us.session, fromUnitQr, 'RECEIVE')
r = await us.session.call('POST', `/documents/${fromUnit.id}/internal-advance`, {})
d = await detail(hs.session, fromUnit.id)
check(ok(r) && d.document.current_office_id === hrOffice.id && d.document.current_step_number === 1, 'finished: back at the parent office, same step', why(r))
check(d.document.origin?.office_id === U1.id && d.document.origin.main_office?.id === hrOffice.id, 'the origin is unchanged', d.document.origin)
r = await scan(hs.session, fromUnitQr, 'RECEIVE')
check(ok(r), 'the office scans it in', why(r))

// ════════════════════════════════════════════════════════════════════════════════════
console.log('\n11. Send-back goes to the recorded origin, even after the uploader moved')
r = await hr.call('PATCH', `/users/${us.id}`, { office_id: U2.id })
check(ok(r), 'the uploader moves to another unit', why(r))
d = await detail(hs.session, fromUnit.id)
check(d.document.origin?.office_id === U1.id, 'moving the uploader does not change the origin', d.document.origin)
r = await hs.session.call('POST', `/documents/${fromUnit.id}/send-back`, { title: 'Missing page', category: 'MISSING_DOCUMENT', severity: 'LOW' })
d = await detail(hs.session, fromUnit.id)
check(ok(r) && d.document.sent_back?.office_id === U1.id, 'the send-back targets the origin unit, not the uploader’s new unit', d.document.sent_back ?? why(r))
r = await hm.session.call('POST', `/documents/${fromUnit.id}/return-claim`)
check(r.status === 403, 'the parent office’s messenger cannot claim it (existing rule)', why(r))
r = await um.session.call('POST', `/documents/${fromUnit.id}/return-claim`)
check(ok(r), 'a messenger of the origin unit claims it', why(r))
r = await scan(um.session, fromUnitQr, 'PICKUP')
check(ok(r), 'and picks it up', why(r))
const unitPerson = await account(hr, { account_type: 'STAFF', office_id: U1.id, last_name: 'UnitThree', email: `dor.us3.${stamp}@test.local` })
r = await scan(unitPerson.session, fromUnitQr, 'RECEIVE')
d = await detail(unitPerson.session, fromUnit.id)
check(ok(r) && d.document.current_step_number === 0 && d.document.current_office_id === U1.id, 'the origin unit receives it, step 0', why(r))
check(d.document.origin?.office_id === U1.id, 'the origin survives the send-back', d.document.origin)
await hr.call('PATCH', `/users/${us.id}`, { office_id: U1.id })

console.log('\n11b. Returned and resubmitted after the uploader moved')
const returned = await upload(mover.session, 'Returned', hrOnly)
const returnedQr = await qrOf(mover.session, returned.id)
r = await scan(hs.session, returnedQr, 'RECEIVE')
d = await detail(hs.session, returned.id)
const approvalId = d.pending_approval?.id
check(ok(r) && Boolean(approvalId), 'received at the last office, approval requested', d.pending_approval ?? why(r))
r = await hs.session.call('PATCH', `/approvals/${approvalId}`, { decision: 'RETURNED', remarks: 'Fix the date' })
check(ok(r), 'returned to the uploader', why(r))
r = await hr.call('PATCH', `/users/${mover.id}`, { office_id: U2.id })
check(ok(r), 'the uploader moves to another unit', why(r))
r = await mover.session.call('POST', `/documents/${returned.id}/submit`, { route_id: recordsFirst })
d = await detail(mover.session, returned.id)
check(ok(r) && d.document.status === 'START' && d.document.current_office_id === U2.id, 'resubmitted: it starts where the uploader is now', why(r))
check(d.document.origin?.office_id === U1.id && d.document.origin.recorded, 'the recorded origin stays the first unit', d.document.origin)
check(d.document.route_id === recordsFirst || d.route?.id === recordsFirst, 'the new route was taken, as before', d.route?.id)

// ════════════════════════════════════════════════════════════════════════════════════
console.log('\n3 + 14. Route begins with another office; messenger and QR')
const other = await upload(us.session, 'Other first office', recordsFirst)
d = await detail(us.session, other.id)
check(d.document.current_step_number === 0 && d.document.current_office_id === U1.id, 'starts at the unit, step 0', d.document)
check(d.document.next_office_name === recordsOffice.name && d.route.steps[0].office_id === recordsOffice.id, 'the route is not rewritten to start at the parent', d.route.steps)
const otherQr = await qrOf(us.session, other.id)
r = await scan(hs.session, otherQr)
check(r.status === 403, 'the parent office cannot receive it: it is not on this step', why(r))
r = await us.session.call('POST', `/documents/${other.id}/pickup-request`, { liaison_user_id: hm.id })
check(ok(r), 'the unit may use its parent office’s messenger', why(r))
r = await scan(rs.session, otherQr)
check(r.status === 403, 'the next office cannot take it from under the messenger', why(r))
r = await scan(hm.session, otherQr, 'PICKUP')
check(ok(r), 'the messenger picks it up', why(r))
r = await hm.session.call('POST', `/documents/${other.id}/transit`, {})
check(ok(r), 'and is on the way', why(r))
r = await scan(rs.session, otherQr, 'RECEIVE')
d = await detail(rs.session, other.id)
check(ok(r) && d.document.current_step_number === 1 && d.document.current_office_id === recordsOffice.id, 'Records receives it from the messenger: step 1', why(r))
check(d.document.origin?.office_id === U1.id && d.document.origin.main_office?.id === hrOffice.id, 'the origin stays the unit while the document is elsewhere', d.document.origin)
r = await hr.call('GET', `/qr/${other.id}`)
check(r.status === 403 || r.status === 404, 'the origin’s parent office does not get the QR of a document it doesn’t hold', why(r))

// ════════════════════════════════════════════════════════════════════════════════════
console.log('\n5. Administrator upload')
const byAdmin = await upload(admin, 'By the admin', hrFirst)
d = await detail(admin, byAdmin.id)
check(d.document.origin?.kind === 'ORGANIZATION' && d.document.origin.office_id === null && d.document.origin.recorded === true, 'no origin office is invented: the organization, known from its submission', d.document.origin)
check(d.document.current_office_id === null && d.document.current_step_number === 0, 'starts at the organization itself', d.document)
const byAdminQr = await qrOf(admin, byAdmin.id)
await scan(hs.session, byAdminQr, 'RECEIVE')
r = await hs.session.call('POST', `/documents/${byAdmin.id}/send-back`, { title: 'Admin send-back', category: 'MISSING_DOCUMENT', severity: 'LOW' })
check(r.status === 409 && r.body?.data?.code === 'NO_PREVIOUS_OFFICE', 'a send-back from the first office is refused: there is no office before it (as before)', r.body)

// ════════════════════════════════════════════════════════════════════════════════════
console.log('\n6. The admin submits someone else’s draft')
const draft = await upload(us.session, 'Draft', hrFirst, { submit: 'false' })
d = await detail(us.session, draft.id)
check(d.document.status === 'CREATED' && d.document.origin?.recorded === false && d.document.origin.kind === 'NOT_RECORDED' && d.document.origin.office_id === null, 'a draft has no recorded origin yet (not the uploader’s office)', d.document.origin)
r = await admin.call('POST', `/documents/${draft.id}/origin`, { office_id: U1.id, reason: 'test' })
check(r.status === 409 && r.body?.data?.code === 'ORIGIN_DRAFT', 'a draft’s origin cannot be recorded by hand: it is set on submission', r.body)
r = await admin.call('POST', `/documents/${draft.id}/submit`, {})
d = await detail(admin, draft.id)
check(ok(r) && d.document.origin?.office_id === U1.id && d.document.origin.recorded, 'the origin comes from the uploader, not from the admin who submitted it', d.document.origin ?? why(r))
check(d.document.submitted_by === us.id, 'the uploader stays', d.document.submitted_by)

// ════════════════════════════════════════════════════════════════════════════════════
console.log('\n7. A client cannot choose the origin')
const forged = { origin_office_id: recordsOffice.id, origin_umbrella_office_id: U2.id, office_id: recordsOffice.id, current_office_id: recordsOffice.id }
const spoofed = await upload(us.session, 'Forged', hrFirst, forged)
d = await detail(us.session, spoofed.id)
check(d.document.origin?.office_id === U1.id && d.document.current_office_id === U1.id, 'origin fields on an upload are ignored', d.document)
const draft2 = await upload(us.session, 'Forged draft', hrFirst, { submit: 'false' })
r = await us.session.call('POST', `/documents/${draft2.id}/submit`, forged)
d = await detail(us.session, draft2.id)
check(ok(r) && d.document.origin?.office_id === U1.id, 'origin fields on a submit are ignored', d.document.origin ?? why(r))
const draft3 = await upload(us.session, 'Not yours', hrFirst, { submit: 'false' })
r = await us2.session.call('POST', `/documents/${draft3.id}/submit`, {})
check(r.status === 403, 'another person cannot submit someone’s draft', why(r))

// ════════════════════════════════════════════════════════════════════════════════════
console.log('\n12. Inactive umbrella office')
r = await hr.call('PATCH', `/offices/umbrellas/${U3.id}`, { is_active: false })
check(ok(r), 'a unit is deactivated', why(r))
r = await post(closing.session, 'From inactive', hrFirst)
check(r.status === 409 && r.body?.data?.code === 'ORIGIN_OFFICE_INACTIVE', 'its staff cannot submit from it', r.body)
const handed = await upload(hs.session, 'For the inactive unit', hrFirst)
r = await hs.session.call('POST', `/documents/${handed.id}/umbrella-handoff`, { umbrella_id: U3.id })
check(r.status === 400, 'it cannot receive a hand-off (existing rule)', why(r))
r = await hr.call('PATCH', `/offices/umbrellas/${U3.id}`, { is_active: true })
r = await post(closing.session, 'From active again', hrFirst)
check(r.status === 201, 'reactivated: submitting works again', why(r))

// ════════════════════════════════════════════════════════════════════════════════════
console.log('\n16a. Recording an origin by hand is refused where one is known')
r = await admin.call('POST', `/documents/${fromUnit.id}/origin`, { office_id: U2.id, reason: 'Overwrite' })
check(r.status === 409 && r.body?.data?.code === 'ORIGIN_ALREADY_RECORDED', 'a recorded origin cannot be overwritten', r.body)
r = await admin.call('POST', `/documents/${byAdmin.id}/origin`, { office_id: U1.id, reason: 'Pretend' })
check(r.status === 409 && r.body?.data?.code === 'ORIGIN_IS_ORGANIZATION', 'an admin upload gets no origin office', r.body)
r = await hr.call('POST', `/documents/${fromUnit.id}/origin`, { office_id: U2.id, reason: 'Overwrite' })
check(r.status === 403, 'a Department Head cannot use it at all', why(r))

// ════════════════════════════════════════════════════════════════════════════════════
console.log('\n13. A document from before the migration')
if (argv.db) {
  const host = process.env.DB_HOST ?? ''
  if (!['localhost', '127.0.0.1'].includes(host)) throw new Error(`--db refuses DB_HOST "${host}": only a local database`)
  const mysql = await import('mysql2/promise')
  const db = await mysql.createConnection({ host, port: Number(process.env.DB_PORT), user: process.env.DB_USER, password: process.env.DB_PASS ?? '', database: process.env.DB_NAME })
  const old = await upload(us.session, 'Older document', hrFirst)
  await db.query('UPDATE documents SET origin_office_id = NULL WHERE id = ?', [old.id])
  // An office of another organization, for the cross-organization check.
  const [otherOrg, otherOffice] = [crypto.randomUUID(), crypto.randomUUID()]
  await db.query('INSERT INTO organizations (id, name) VALUES (?, ?)', [otherOrg, `Other org ${stamp}`])
  await db.query('INSERT INTO offices (id, org_id, name, code) VALUES (?, ?, ?, ?)', [otherOffice, otherOrg, `Other org office ${stamp}`, `OOO-${stamp}`])
  // The uploader has moved since: their office now must not be taken for the origin.
  r = await hr.call('PATCH', `/users/${us.id}`, { office_id: U2.id })
  check(ok(r), 'the uploader moves to another unit', why(r))
  d = await detail(us.session, old.id)
  check(d.document.origin?.kind === 'NOT_RECORDED' && d.document.origin.recorded === false && d.document.origin.office_id === null, 'shown as not recorded, not as the uploader’s office', d.document.origin)
  check(d.document.origin?.name === 'Origin not recorded', 'displayed as “Origin not recorded”', d.document.origin?.name)
  check(d.document.current_office_id === U1.id && d.document.current_step_number === 0, 'where it is now is unchanged (routing state is separate)', d.document)
  const oldQr = await qrOf(us.session, old.id)
  r = await scan(hs.session, oldQr, 'RECEIVE')
  check(ok(r), 'still routable: the first office receives it', why(r))
  r = await hs.session.call('POST', `/documents/${old.id}/send-back`, { title: 'Older send-back', category: 'MISSING_DOCUMENT', severity: 'LOW' })
  check(r.status === 409 && r.body?.data?.code === 'ORIGIN_NOT_RECORDED' && /administrator/.test(r.body?.message ?? ''), 'a send-back to step 0 is refused with what to do, not sent to the uploader’s office', r.body)
  d = await detail(hs.session, old.id)
  check(!d.document.sent_back && d.document.current_office_id === hrOffice.id && d.document.current_step_number === 1, 'nothing moved', d.document)
  const [leftIssues] = (await db.query('SELECT COUNT(*) AS n FROM issues WHERE document_id = ? AND title = ?', [old.id, 'Older send-back'])) as any
  check(Number(leftIssues[0].n) === 0, 'the issue flagged for the refused send-back is not left behind', leftIssues)

  console.log('\n16. Recording an origin by hand')
  for (const [label, s] of [['Department Head', hr], ['Staff', hs.session], ['Messenger', hm.session], ['the uploader', us.session]] as const) {
    r = await s.call('POST', `/documents/${old.id}/origin`, { office_id: U1.id, reason: 'I know' })
    check(r.status === 403, `refused to ${label}`, why(r))
  }
  r = await admin.call('POST', `/documents/${old.id}/origin`, { office_id: otherOffice, reason: 'Wrong org' })
  check(r.status === 400 && r.body?.data?.details?.field === 'office_id', 'an office of another organization is refused', r.body)
  r = await admin.call('POST', `/documents/${old.id}/origin`, { office_id: crypto.randomUUID(), reason: 'No such office' })
  check(r.status === 400, 'an unknown office is refused', why(r))
  r = await admin.call('POST', `/documents/${old.id}/origin`, { office_id: U1.id })
  check(r.status === 400, 'a reason is required', why(r))
  d = await detail(admin, old.id)
  check(d.document.origin?.kind === 'NOT_RECORDED', 'none of those recorded anything', d.document.origin)
  r = await admin.call('POST', `/documents/${old.id}/origin`, { office_id: U1.id, reason: 'Routing slip shows the Sanitation Unit' })
  d = await detail(admin, old.id)
  check(ok(r) && d.document.origin?.kind === 'OFFICE' && d.document.origin.office_id === U1.id && d.document.origin.main_office?.id === hrOffice.id, 'an administrator records the unit; its main office follows', d.document.origin ?? why(r))
  check(d.document.current_office_id === hrOffice.id && d.document.current_step_number === 1 && !d.document.sent_back, 'where it is and its step are unchanged', d.document)
  const db2 = await mysql.createConnection({ host, port: Number(process.env.DB_PORT), user: process.env.DB_USER, password: process.env.DB_PASS ?? '', database: process.env.DB_NAME })
  const [audits] = (await db2.query("SELECT new_values FROM audit_logs WHERE action = 'DOCUMENT_ORIGIN_RECORD' AND entity_id = ?", [old.id])) as any
  check(audits.length === 1 && JSON.stringify(audits[0].new_values).includes(U1.id), 'it is in the audit log, with the reason', audits)
  r = await admin.call('POST', `/documents/${old.id}/origin`, { office_id: U2.id, reason: 'Change it' })
  check(r.status === 409 && r.body?.data?.code === 'ORIGIN_ALREADY_RECORDED', 'once recorded it cannot be changed', r.body)
  r = await hs.session.call('POST', `/documents/${old.id}/send-back`, { title: 'Older send-back again', category: 'MISSING_DOCUMENT', severity: 'LOW' })
  d = await detail(hs.session, old.id)
  check(ok(r) && d.document.sent_back?.office_id === U1.id, 'now the send-back goes to the recorded origin, not the uploader’s new unit', d.document.sent_back ?? why(r))
  await db2.query('DELETE FROM offices WHERE id = ?', [otherOffice])
  await db2.query('DELETE FROM organizations WHERE id = ?', [otherOrg])
  await db2.end()
  await db.end()
  await hr.call('PATCH', `/users/${us.id}`, { office_id: U1.id })
} else {
  console.log('  skipped: run with --db and DB_* set to a local test database')
}

// ════════════════════════════════════════════════════════════════════════════════════
console.log('\n15. Timeline and notifications')
const fresh = await upload(us.session, 'Timeline', hrFirst)
const freshQr = await qrOf(us.session, fresh.id)
let events = await eventsOf(us.session, fresh.id)
check(countOf(events, 'SUBMITTED') === 1, 'one submission event', events.map((e) => e.event_type))
check(countOf(events, 'RECEIVED') === 0, 'not received on submission', events.map((e) => e.event_type))
await scan(hs.session, freshQr, 'RECEIVE')
events = await eventsOf(us.session, fresh.id)
check(countOf(events, 'SUBMITTED') === 1 && countOf(events, 'RECEIVED') === 1 && countOf(events, 'ARRIVED') === 1, 'one arrival and one receipt, no duplicates', events.map((e) => e.event_type))
const titleOf = `New document: Timeline ${stamp}`
const incoming = async (s: Session) => ((await s.call('GET', '/notifications?limit=100')).body?.data ?? []).filter((n: any) => n.title === titleOf)
check((await incoming(hs.session)).length === 1, 'the first office is told once', await incoming(hs.session))
check((await incoming(us.session)).length === 0 && (await incoming(us2.session)).length === 0, 'the unit is not told as if it were the destination', await incoming(us2.session))
d = await detail(us.session, fresh.id)
check(d.routing.filter((v: any) => v.office_id === U1.id || v.office?.id === U1.id).every((v: any) => (v.step_number ?? 0) === 0), 'in the office-by-office view the unit only appears as the origin, at step 0', d.routing)

console.log(`\n${passed} passed, ${failed} failed`)
process.exitCode = failed ? 1 : 0
