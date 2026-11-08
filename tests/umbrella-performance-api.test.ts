/**
 * Umbrella office performance (GET /api/dashboard/umbrella-performance[/:officeId]) end to end, against a
 * running app on a THROWAWAY database with the demo seed (FlowVision's .env database is the shared Hostinger
 * one, local development included — never run this there):
 *
 *   (start the app with DB_* pointing at the throwaway database)
 *   node tests/umbrella-performance-api.test.ts --base=http://localhost:3010 [--db]
 *
 * Who may see which offices, and that the numbers follow the documents' actual handling: a hand-off to an
 * umbrella office and back, an internal route through two units, a send-back and its second pass, a final
 * approval, a document still pending — each counted once in the department totals, forwarding never
 * counted as completion. With --db (and FV_THROWAWAY_DB=1, DB_* set to the same throwaway database) one
 * pending document is made overdue to check the overdue counts.
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
const records = await login('records@bago.gov.ph') // managing Department Head of Records
const hs = await login('hr.staff@bago.gov.ph')
const hrOffice = hr.user.office
const recordsOffice = records.user.office

async function account(by: Session, body: Record<string, unknown>) {
  const r = await by.call('POST', '/users', { first_name: 'P', ...body })
  if (r.status !== 201) throw new Error(`could not create ${body.email}: ${why(r)}`)
  return { id: r.body.user.id as string, session: await login(body.email as string, r.body.temporary_password) }
}
async function umbrella(by: Session, name: string, head?: string) {
  const r = await by.call('POST', '/offices/umbrellas', { name: `${name} ${stamp}`, ...(head && { head: { mode: 'new', first_name: 'U', last_name: 'Head', email: head, permissions: ['RECEIVE_DOCUMENTS', 'PASS_DOCUMENTS', 'UMBRELLA_HANDOFF'] } }) })
  if (r.status !== 201) throw new Error(`could not add umbrella ${name}: ${why(r)}`)
  return { office: r.body.office, headSession: head ? await login(head, r.body.temporary_password) : null }
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
const detail = async (s: Session, id: string) => (await s.call('GET', `/documents/${id}`)).body
const qrOf = async (s: Session, id: string) => (await detail(s, id)).document.qr_code as string
const scan = (s: Session, payload: string, action?: string) => s.call('POST', '/qr/scan', { payload, ...(action && { action }) })
const route = async (name: string, offices: any[]) => {
  const r = await admin.call('POST', '/routes', { name: `Perf ${name} ${stamp}`, steps: offices.map((o) => ({ office_id: o.id, action_label: 'Review' })) })
  if (r.status !== 201) throw new Error(`could not add route ${name}: ${why(r)}`)
  return r.body.route.id as string
}
const perf = (s: Session, q = '') => s.call('GET', `/dashboard/umbrella-performance${q}`)
const officeIn = (body: any, id: string) => (body?.offices ?? []).find((o: any) => o.office.id === id)
const step = async (label: string, r: Res) => {
  check(ok(r), label, why(r))
  return r
}

// ── Setup ────────────────────────────────────────────────────────────────────────────────────────────
const before = (await perf(hr)).body
const u1 = await umbrella(hr, 'Perf Unit One', `perf.u1head.${stamp}@test.local`)
const u2 = await umbrella(hr, 'Perf Unit Two')
const r1 = await umbrella(records, 'Perf Records Unit', `perf.r1head.${stamp}@test.local`)
const U1 = u1.office
const U2 = u2.office
const R1 = r1.office
const u1s = await account(hr, { account_type: 'STAFF', office_id: U1.id, last_name: 'UnitOne', email: `perf.u1s.${stamp}@test.local` })
const u2s = await account(hr, { account_type: 'STAFF', office_id: U2.id, last_name: 'UnitTwo', email: `perf.u2s.${stamp}@test.local` })
const hm = await account(hr, { account_type: 'LIAISON', office_id: hrOffice.id, last_name: 'Messenger', email: `perf.hm.${stamp}@test.local` })
await hm.session.call('PATCH', '/liaisons/me', { availability: 'AVAILABLE' })
const narrow = await account(hr, { account_type: 'DEPARTMENT_HEAD', last_name: 'Narrow', email: `perf.narrow.${stamp}@test.local`, permissions: ['RECEIVE_DOCUMENTS'] })
const wide = await account(hr, { account_type: 'DEPARTMENT_HEAD', last_name: 'Wide', email: `perf.wide.${stamp}@test.local`, permissions: ['RECEIVE_DOCUMENTS', 'MANAGE_UMBRELLAS'] })
const hrThenRecords = await route('HR then Records', [hrOffice, recordsOffice])
const hrOnly = await route('HR only', [hrOffice])
const ir = await hr.call('POST', '/internal-routes', { name: `Perf path ${stamp}`, steps: [{ office_id: U1.id }, { office_id: U2.id }] })
if (ir.status !== 201) throw new Error(`could not add internal route: ${why(ir)}`)

// ════════════════════════════════════════════════════════════════════════════════════════════════════
console.log('\n1. Who sees which offices')
let r = await perf(hr)
check(r.status === 200 && r.body.main_office?.id === hrOffice.id, 'the managing head of HR gets HR’s department', why(r))
const ids = (b: any) => (b?.offices ?? []).map((o: any) => o.office.id)
check(ids(r.body)[0] === hrOffice.id && ids(r.body).includes(U1.id) && ids(r.body).includes(U2.id), 'HR first, then its umbrella offices', ids(r.body))
check(!ids(r.body).includes(R1.id) && !ids(r.body).includes(recordsOffice.id), 'not Records or Records’ umbrella office', ids(r.body))
r = await perf(hr, `?office_id=${recordsOffice.id}&main_office_id=${recordsOffice.id}&parent_office_id=${recordsOffice.id}`)
check(r.status === 200 && r.body.main_office?.id === hrOffice.id && !ids(r.body).includes(R1.id), 'office ids in the request are ignored', ids(r.body))
r = await hr.call('GET', `/dashboard/umbrella-performance/${U1.id}`)
check(r.status === 200 && r.body.summary?.office?.id === U1.id, 'HR’s head opens its umbrella office in detail', why(r))
r = await hr.call('GET', `/dashboard/umbrella-performance/${hrOffice.id}`)
check(r.status === 200 && r.body.summary?.office?.id === hrOffice.id, '…and HR itself', why(r))
for (const [label, id] of [['Records’ umbrella office', R1.id], ['Records', recordsOffice.id], ['an office that doesn’t exist', crypto.randomUUID()]] as const) {
  r = await hr.call('GET', `/dashboard/umbrella-performance/${id}`)
  check(r.status === 404, `HR’s head cannot open ${label}`, why(r))
}
r = await perf(records)
check(r.status === 200 && ids(r.body)[0] === recordsOffice.id && ids(r.body).includes(R1.id) && !ids(r.body).includes(U1.id), 'Records’ head gets Records and its own umbrella office only', ids(r.body))
r = await records.call('GET', `/dashboard/umbrella-performance/${U1.id}`)
check(r.status === 404, 'Records’ head cannot open HR’s umbrella office', why(r))

r = await perf(u1.headSession!)
check(r.status === 200 && ids(r.body).length === 1 && ids(r.body)[0] === U1.id && r.body.main_office === null, 'an umbrella office’s head sees only its own office', ids(r.body))
for (const [label, id] of [['a sibling umbrella office', U2.id], ['its parent office', hrOffice.id]] as const) {
  r = await u1.headSession!.call('GET', `/dashboard/umbrella-performance/${id}`)
  check(r.status === 404, `…not ${label}`, why(r))
}
r = await u1.headSession!.call('GET', `/dashboard/umbrella-performance/${U1.id}`)
check(r.status === 200, '…and opens its own office in detail', why(r))

r = await perf(narrow.session)
check(r.status === 200 && ids(r.body).length === 1 && ids(r.body)[0] === hrOffice.id, 'a delegated head of HR without “Manage umbrella offices” sees HR only', ids(r.body))
r = await narrow.session.call('GET', `/dashboard/umbrella-performance/${U1.id}`)
check(r.status === 404, '…and cannot open an umbrella office', why(r))
r = await perf(wide.session)
check(r.status === 200 && ids(r.body).includes(U1.id), 'a delegated head with “Manage umbrella offices” sees the umbrella offices', ids(r.body))

for (const [label, s] of [['Staff', hs], ['an Admin', admin]] as const) {
  r = await perf(s)
  check(r.status === 403, `${label} cannot use it`, why(r))
  r = await s.call('GET', `/dashboard/umbrella-performance/${U1.id}`)
  check(r.status === 403, `${label} cannot open an office in detail`, why(r))
}
r = await perf(hm.session)
check(r.status === 403, 'a messenger cannot use it', why(r))
const anon = await fetch(`${BASE}/api/dashboard/umbrella-performance`)
check(anon.status === 401, 'without a session → 401', anon.status)

// ════════════════════════════════════════════════════════════════════════════════════════════════════
console.log('\n2. Documents handled across the department')
// A: HR receives it (its staff uploads it on a route that starts at HR), hands it to Unit One and gets it back,
//    releases it to Records; Records sends it back; HR receives and releases it again.
const A = await upload(hs, 'Perf hand-off', hrThenRecords)
const qrA = await qrOf(hs, A.id)
await step('A: handed to Unit One', await hs.call('POST', `/documents/${A.id}/umbrella-handoff`, { umbrella_id: U1.id }))
await step('A: Unit One receives it', await scan(u1s.session, qrA, 'RECEIVE'))
await step('A: Unit One returns it', await u1s.session.call('POST', `/documents/${A.id}/umbrella-return`, {}))
await step('A: HR receives it again', await scan(hs, qrA, 'RECEIVE'))
await step('A: HR releases it to a messenger', await hs.call('POST', `/documents/${A.id}/pickup-request`, { liaison_user_id: hm.id }))
await step('A: picked up', await scan(hm.session, qrA, 'PICKUP'))
await step('A: on the way', await hm.session.call('POST', `/documents/${A.id}/transit`, {}))
await step('A: Records receives it', await scan(records, qrA, 'RECEIVE'))
await step('A: Records sends it back', await records.call('POST', `/documents/${A.id}/send-back`, { title: 'Perf missing page', category: 'MISSING_DOCUMENT', severity: 'LOW' }))
await step('A: HR’s messenger claims the return', await hm.session.call('POST', `/documents/${A.id}/return-claim`))
await step('A: picked up for the return', await scan(hm.session, qrA, 'PICKUP'))
await step('A: HR receives it back', await scan(hs, qrA, 'RECEIVE'))
await step('A: HR releases it again', await hs.call('POST', `/documents/${A.id}/pickup-request`, { liaison_user_id: hm.id }))
await step('A: picked up again', await scan(hm.session, qrA, 'PICKUP'))

// B: final approval at HR.
const B = await upload(hs, 'Perf approval', hrOnly)
const approvalId = (await detail(hs, B.id)).pending_approval?.id
// The approval belongs to HR's approver (in the demo seed its staff member, as in document-origin-api.test.ts).
await step('B: approved at HR', await hs.call('PATCH', `/approvals/${approvalId}`, { decision: 'APPROVED', remarks: 'OK' }))

// C: an internal route through Unit One and Unit Two, back to HR, still at HR (not released).
const C = await upload(hs, 'Perf internal route', hrThenRecords)
const qrC = await qrOf(hs, C.id)
await step('C: internal route started', await hs.call('POST', `/documents/${C.id}/internal-start`, { route_id: ir.body.route.id }))
await step('C: Unit One receives it', await scan(u1s.session, qrC, 'RECEIVE'))
await step('C: moved on to Unit Two', await u1s.session.call('POST', `/documents/${C.id}/internal-advance`, {}))
await step('C: Unit Two receives it', await scan(u2s.session, qrC, 'RECEIVE'))
await step('C: back to HR', await u2s.session.call('POST', `/documents/${C.id}/internal-advance`, {}))

// D: handed to Unit Two and left there, not received yet.
const D = await upload(hs, 'Perf pending at a unit', hrThenRecords)
await step('D: handed to Unit Two (still pending there)', await hs.call('POST', `/documents/${D.id}/umbrella-handoff`, { umbrella_id: U2.id }))

r = await perf(hr)
const after = r.body
const delta = (k: string) => (after.department?.[k] ?? 0) - (before.department?.[k] ?? 0)
const hrNow = officeIn(after, hrOffice.id)
const hrThen = officeIn(before, hrOffice.id)
const hrDelta = (k: string) => (hrNow?.[k] ?? 0) - (hrThen?.[k] ?? 0)
const one = officeIn(after, U1.id)
const two = officeIn(after, U2.id)

check(hrDelta('received') === 4, 'HR received A, B, C, D — A once, although it was received three times (send-back included)', { now: hrNow?.received, then: hrThen?.received })
check(hrDelta('completed') === 1, 'HR completed only B: forwarding A is not completion', { now: hrNow?.completed, then: hrThen?.completed })
check(hrDelta('forwarded') === 1 && hrDelta('sent_back') === 0, 'HR forwarded A (once, as a document)', { forwarded: hrDelta('forwarded'), sent_back: hrDelta('sent_back') })
check(hrNow?.decides === true && hrNow?.avg_processing_minutes !== null && hrNow?.processing_measured > 0, 'HR decides and has a processing time', hrNow)
check(one?.received === 2 && one?.forwarded === 2 && one?.completed === 0 && one?.decides === false, 'Unit One received A and C and passed both on; completed none', one)
check(two?.received === 1 && two?.forwarded === 1 && two?.pending === 1 && two?.completed === 0, 'Unit Two received C (passed back to HR), and D is pending there', two)
check(one?.pending === 0 && hrDelta('pending') === 1, 'pending: C at HR, D at Unit Two — never in two places', { hr: hrDelta('pending'), one: one?.pending })
check(delta('received') === 4, 'department: 4 distinct documents received, although HR and both units handled them', { now: after.department?.received, then: before.department?.received })
check(delta('completed') === 1 && delta('forwarded_out') === 1, 'department: B completed, A sent on out of the department', after.department)
check(delta('pending') === 2, 'department pending = HR + Unit One + Unit Two', after.department)
check(after.trend.length === 30 && after.trend.some((t: any) => t.received > 0), 'a 30-day daily trend', after.trend?.length)
r = await perf(u1.headSession!)
const ownRow = officeIn(r.body, U1.id)
check(
  r.body.department?.processing_measured === ownRow?.processing_measured && ownRow?.processing_measured > 0 && r.body.department?.avg_processing_minutes === ownRow?.avg_processing_minutes,
  'an umbrella office’s head: the total processing time is its own office’s (not “nothing measured”)',
  { total: [r.body.department?.avg_processing_minutes, r.body.department?.processing_measured], own: [ownRow?.avg_processing_minutes, ownRow?.processing_measured] },
)
r = await perf(hr, '?days=7')
check(r.status === 200 && r.body.range.days === 7 && r.body.trend.length === 7, 'the period can be 7 days', r.body?.range)

r = await perf(records)
const rec = officeIn(r.body, R1.id)
check(rec && rec.received === 0 && rec.pending === 0 && rec.forwarded === 0 && rec.clearance_rate === null && rec.avg_processing_minutes === null, 'an umbrella office with no activity: zeros and nulls', rec)

console.log('\n3. One office in detail')
r = await hr.call('GET', `/dashboard/umbrella-performance/${U1.id}`)
const u1Staff = (r.body?.staff ?? []).find((s: any) => s.id === u1s.id)
check(u1Staff?.received === 2 && u1Staff?.cleared === 2 && u1Staff?.holding === 0, 'Unit One’s staff: received 2, passed on 2, nothing on the desk', u1Staff)
check((r.body?.recent_activity ?? []).some((a: any) => a.kind === 'RETURNED_TO_OFFICE' && a.document?.id === A.id), 'recent activity shows A returned to HR', r.body?.recent_activity?.slice(0, 4))
check((r.body?.completed_documents ?? []).length === 0, 'nothing completed at a unit', r.body?.completed_documents)
r = await hr.call('GET', `/dashboard/umbrella-performance/${U2.id}`)
check((r.body?.pending_documents ?? []).some((d: any) => d.id === D.id) && !('qr_code' in (r.body?.pending_documents?.[0] ?? {})), 'Unit Two’s pending list has D, without its QR code', r.body?.pending_documents)
r = await hr.call('GET', `/dashboard/umbrella-performance/${hrOffice.id}`)
check((r.body?.completed_documents ?? []).some((c: any) => c.document?.id === B.id), 'HR’s completed list has B', r.body?.completed_documents)
const u2Head = await u1.headSession!.call('GET', `/dashboard/umbrella-performance/${U1.id}`)
check(u2Head.status === 200 && u2Head.body.summary.received === 2, 'Unit One’s own head sees the same numbers for its office', u2Head.body?.summary)

if (argv.db) {
  console.log('\n4. Overdue (--db)')
  const host = process.env.DB_HOST ?? ''
  if (process.env.FV_THROWAWAY_DB !== '1' || !['localhost', '127.0.0.1'].includes(host)) throw new Error('--db needs FV_THROWAWAY_DB=1 and DB_* of the local throwaway database the app runs on')
  const mysql = await import('mysql2/promise')
  const db = await mysql.createConnection({ host, port: Number(process.env.DB_PORT), user: process.env.DB_USER, password: process.env.DB_PASS ?? '', database: process.env.DB_NAME })
  await db.query('UPDATE documents SET target_completion_date = ? WHERE id = ?', [new Date(Date.now() - 86_400_000), D.id])
  await db.end()
  r = await perf(hr)
  check(officeIn(r.body, U2.id)?.overdue === 1 && r.body.department.overdue - (before.department?.overdue ?? 0) >= 1, 'D past its target: overdue at Unit Two and in the department', officeIn(r.body, U2.id))
} else {
  console.log('\n(skipped: overdue — add --db with FV_THROWAWAY_DB=1 and the throwaway DB_*)')
}

console.log('\n5. Existing dashboards are unchanged')
for (const [label, s] of [['HR’s head', hr], ['Unit One’s head', u1.headSession!], ['Staff', hs], ['the Admin', admin]] as const) {
  r = await s.call('GET', '/dashboard')
  check(r.status === 200, `GET /dashboard still works for ${label}`, why(r))
}

console.log(`\n${passed} passed, ${failed} failed`)
process.exitCode = failed ? 1 : 0
