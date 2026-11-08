/**
 * GET /api/dashboard for every role, end to end, against a running app: main-office and umbrella-office
 * Department Heads, Staff, Admin and Liaison, an office with nothing in it, and that each account only
 * sees its own office's documents.
 *
 *   npm run dev                         (another terminal; LOCAL database with the demo seed, migrated)
 *   npm run test:dashboard-api          (or: node tests/dashboard-api.test.ts --base=http://localhost:3000)
 *
 * A 500 here with "Unknown column" means the database is behind the code: run npm run db:migrate on it.
 *
 * With --db it also clears one Department Head's office in the database, to act as an account whose office
 * relationship is missing. It reads DB_HOST, DB_PORT, DB_USER, DB_PASS and DB_NAME from the environment,
 * never from .env, and refuses a host that isn't local.
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
const why = (r: Res) => `${r.status} ${r.body?.message ?? ''}`
const admin = await login('client@bago.gov.ph')
const hr = await login('hr@bago.gov.ph') // managing Department Head of the HR office
const records = await login('records@bago.gov.ph') // managing Department Head of the Records office
const hrStaff = await login('hr.staff@bago.gov.ph')
const liaison = await login('liaison.adm@bago.gov.ph')
const hrOffice = hr.user.office
const recordsOffice = records.user.office

async function account(by: Session, body: Record<string, unknown>) {
  const r = await by.call('POST', '/users', { first_name: 'T', ...body })
  if (r.status !== 201) throw new Error(`could not create ${body.email}: ${why(r)}`)
  return { id: r.body.user.id as string, session: await login(body.email as string, r.body.temporary_password) }
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
const route = async (name: string, offices: any[]) => {
  const r = await admin.call('POST', '/routes', { name: `Dashboard ${name} ${stamp}`, steps: offices.map((o) => ({ office_id: o.id, action_label: 'Review' })) })
  if (r.status !== 201) throw new Error(`could not add route ${name}: ${why(r)}`)
  return r.body.route.id as string
}
/** GET /dashboard, reporting a schema mismatch plainly. */
async function dashboard(s: Session, query = '') {
  const r = await s.call('GET', `/dashboard${query}`)
  if (r.status === 500 && /Unknown column/i.test(r.body?.message ?? '')) console.log(`  ! ${r.body.message} — the database needs npm run db:migrate`)
  return r
}
const ids = (docs: any[] | undefined) => (docs ?? []).map((d) => d.id as string)
const COUNTS = ['awaiting_receipt', 'in_process', 'awaiting_pickup', 'outbound', 'incoming', 'received_today']

// ── Setup: an empty main office with its head, an umbrella office under HR with its head and staff ──
let r = await admin.call('POST', '/offices', { name: `Dashboard Empty Office ${stamp}` })
if (r.status !== 201) throw new Error(`could not add office: ${why(r)}`)
const emptyOffice = r.body.office
const emptyHead = await account(admin, { account_type: 'DEPARTMENT_HEAD', office_id: emptyOffice.id, last_name: 'EmptyHead', email: `dash.empty.${stamp}@test.local` })
const unitHeadEmail = `dash.unithead.${stamp}@test.local`
r = await hr.call('POST', '/offices/umbrellas', { name: `Dashboard Unit ${stamp}`, head: { mode: 'new', first_name: 'U', last_name: 'Head', email: unitHeadEmail, permissions: ['RECEIVE_DOCUMENTS', 'PASS_DOCUMENTS'] } })
if (r.status !== 201) throw new Error(`could not add umbrella office: ${why(r)}`)
const unit = r.body.office
const unitHead = await login(unitHeadEmail, r.body.temporary_password)
const unitStaff = await account(hr, { account_type: 'STAFF', office_id: unit.id, last_name: 'UnitStaff', email: `dash.us.${stamp}@test.local` })
const hrFirst = await route('HR first', [hrOffice, recordsOffice])
const recordsFirst = await route('Records first', [recordsOffice, hrOffice])

// ════════════════════════════════════════════════════════════════════════════════════
console.log('\n1. Nothing at the office yet')
r = await dashboard(emptyHead.session)
check(r.status === 200 && r.body.account_type === 'DEPARTMENT_HEAD' && r.body.office?.id === emptyOffice.id, 'a main-office head of an empty office gets its dashboard', why(r))
check(COUNTS.every((k) => r.body?.counts?.[k] === 0), 'every count is zero', r.body?.counts)
check(Array.isArray(r.body?.documents) && r.body.documents.length === 0 && Array.isArray(r.body?.staff_uploads) && r.body.staff_uploads.length === 0, 'no documents, no staff uploads', r.body)
r = await dashboard(unitHead)
check(r.status === 200 && r.body.office?.id === unit.id && r.body.office.parent?.id === hrOffice.id, 'an umbrella-office head of an empty unit gets its dashboard (its unit, under HR)', r.body?.office ?? why(r))
check(COUNTS.every((k) => r.body?.counts?.[k] === 0) && r.body?.documents?.length === 0 && r.body?.staff_uploads?.length === 0, '…with nothing in it', r.body)

// Documents: one at HR (HR staff, HR is the first office), one from the unit (stays with the unit at step 0),
// one at Records (its head's upload; Records is the first office).
const atHr = await upload(hrStaff, 'At HR', hrFirst)
const fromUnit = await upload(unitStaff.session, 'From the unit', recordsFirst)
const atRecords = await upload(records, 'At Records', recordsFirst)

console.log('\n2. Main-office Department Head')
r = await dashboard(hr)
check(r.status === 200 && r.body.account_type === 'DEPARTMENT_HEAD' && r.body.office?.id === hrOffice.id, 'HR head gets the HR dashboard', why(r))
check(COUNTS.every((k) => Number.isInteger(r.body?.counts?.[k])), 'all counts are numbers', r.body?.counts)
check(ids(r.body?.documents).includes(atHr.id), 'the document at HR is listed', ids(r.body?.documents))
check((r.body?.documents ?? []).every((d: any) => d.current_office_id === hrOffice.id), 'every listed document is at HR', r.body?.documents?.map((d: any) => d.current_office_id))
check(ids(r.body?.staff_uploads).includes(atHr.id), "HR staff's upload is in staff_uploads", ids(r.body?.staff_uploads))
check(!ids(r.body?.documents).includes(fromUnit.id) && !ids(r.body?.documents).includes(atRecords.id), "neither the unit's nor Records' document is listed", ids(r.body?.documents))

console.log('\n3. Umbrella-office Department Head')
r = await dashboard(unitHead)
check(r.status === 200 && r.body.office?.id === unit.id, 'the unit head gets the unit dashboard', why(r))
check(ids(r.body?.documents).includes(fromUnit.id), "the unit's own upload, still with the unit, is listed", ids(r.body?.documents))
check(ids(r.body?.staff_uploads).includes(fromUnit.id), "…and is in the unit's staff_uploads", ids(r.body?.staff_uploads))
check((r.body?.documents ?? []).every((d: any) => d.current_office_id === unit.id), 'every listed document is at the unit', r.body?.documents?.map((d: any) => d.current_office_id))
check(!ids(r.body?.documents).includes(atHr.id) && !ids(r.body?.staff_uploads).includes(atHr.id), "the parent office's document is not on the unit dashboard", r.body)

console.log("\n4. No other office's data")
r = await dashboard(records)
check(r.status === 200 && r.body.office?.id === recordsOffice.id, 'Records head gets the Records dashboard', why(r))
check(ids(r.body?.documents).includes(atRecords.id) && !ids(r.body?.documents).includes(atHr.id) && !ids(r.body?.staff_uploads).includes(atHr.id), "Records sees its document and not HR's", r.body)
r = await dashboard(records, `?office_id=${hrOffice.id}`)
check(r.status === 200 && r.body.office?.id === recordsOffice.id && !ids(r.body?.documents).includes(atHr.id), 'asking for another office is ignored: still the own office', r.body?.office)
for (const [label, s] of [['Department Head', records], ['Staff', hrStaff], ['Liaison', liaison]] as const) {
  r = await s.call('GET', `/dashboard/cards?office_id=${hrOffice.id}`)
  check(r.status === 403, `the organization dashboard cards are refused to a ${label}`, why(r))
}
const anon = await fetch(`${BASE}/api/dashboard`)
check(anon.status === 401, 'without a session → 401', anon.status)

console.log('\n5. Admin, Staff and Liaison')
r = await dashboard(admin)
check(r.status === 200 && r.body.account_type === 'ADMIN' && typeof r.body.totals?.active === 'number' && Array.isArray(r.body.recent), 'Admin gets the organization dashboard', why(r))
check(ids(r.body?.recent).includes(atRecords.id) || r.body?.recent?.length === 8, "the organization's recent documents are listed", ids(r.body?.recent))
r = await admin.call('GET', `/dashboard/cards?office_id=${hrOffice.id}`)
check(r.status === 200 && r.body.office?.id === hrOffice.id, 'Admin gets the cards for one office', why(r))
r = await dashboard(hrStaff)
check(r.status === 200 && r.body.account_type === 'STAFF' && r.body.office?.id === hrOffice.id && typeof r.body.has_approval_authority === 'boolean', 'Staff gets its office dashboard', why(r))
check(!('staff_uploads' in (r.body ?? {})), 'Staff gets no staff_uploads', Object.keys(r.body ?? {}))
check((r.body?.documents ?? []).every((d: any) => d.current_office_id === hrOffice.id), "Staff's listed documents are all at its office", r.body?.documents?.map((d: any) => d.current_office_id))
r = await dashboard(liaison)
check(r.status === 200 && r.body.account_type === 'LIAISON' && typeof r.body.counts?.available_pickups === 'number', 'Liaison gets its dashboard', why(r))

if (argv.db) {
  console.log('\n6. A Department Head without an office (--db)')
  const host = process.env.DB_HOST ?? ''
  if (!['localhost', '127.0.0.1'].includes(host)) throw new Error(`--db refuses DB_HOST "${host}": only a local database`)
  const mysql = await import('mysql2/promise')
  const db = await mysql.createConnection({ host, port: Number(process.env.DB_PORT), user: process.env.DB_USER, password: process.env.DB_PASS ?? '', database: process.env.DB_NAME })
  await db.query('UPDATE users SET office_id = NULL WHERE id = ?', [emptyHead.id])
  await db.end()
  r = await dashboard(emptyHead.session)
  check(r.status !== 500, 'no server error', why(r))
  check(r.status !== 200 || (r.body.office === null && !r.body.documents && !r.body.staff_uploads), 'no office: no office data at all', r.body)
} else {
  console.log('\n(skipped: a Department Head without an office — add --db with a local DB_* environment)')
}

console.log(`\n${passed} passed, ${failed} failed`)
process.exitCode = failed ? 1 : 0
