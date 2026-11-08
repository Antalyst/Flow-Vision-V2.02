/**
 * The ADMIN's organization-wide office performance (GET /api/dashboard/office-performance[/:officeId]) end to
 * end, against a running app on a THROWAWAY database with the demo seed (FlowVision's .env database is the shared
 * Hostinger one, local development included — never run this there):
 *
 *   node tests/organization-performance-api.test.ts --base=http://localhost:3010 [--db]
 *
 * Every main office and umbrella office of the ADMIN's organization, grouped main → its units; the filters; the
 * same per-office numbers as the Department Head's view; organization totals that count a document once; one
 * office in detail; and nobody else (Department Heads, Staff) using it. With --db (FV_THROWAWAY_DB=1 and DB_* of
 * that throwaway database) an office of another organization is added to check it stays out of reach.
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
const hr = await login('hr@bago.gov.ph')
const records = await login('records@bago.gov.ph')
const hs = await login('hr.staff@bago.gov.ph')
const hrOffice = hr.user.office
const recordsOffice = records.user.office

async function account(by: Session, body: Record<string, unknown>) {
  const r = await by.call('POST', '/users', { first_name: 'O', ...body })
  if (r.status !== 201) throw new Error(`could not create ${body.email}: ${why(r)}`)
  return { id: r.body.user.id as string, session: await login(body.email as string, r.body.temporary_password) }
}
async function umbrella(by: Session, name: string) {
  const r = await by.call('POST', '/offices/umbrellas', { name: `${name} ${stamp}` })
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
const qrOf = async (s: Session, id: string) => (await s.call('GET', `/documents/${id}`)).body.document.qr_code as string
const scan = (s: Session, payload: string, action?: string) => s.call('POST', '/qr/scan', { payload, ...(action && { action }) })
const perf = (q = '') => admin.call('GET', `/dashboard/office-performance${q}`)
const ids = (b: any) => (b?.offices ?? []).map((o: any) => o.office.id as string)
const row = (b: any, id: string) => (b?.offices ?? []).find((o: any) => o.office.id === id)
const step = async (label: string, r: Res) => check(ok(r), label, why(r))

// ── Setup: a unit under HR and one under Records; one document handed to HR's unit ────────────────────
const before = (await perf()).body
const HU = await umbrella(hr, 'Org Perf HR Unit')
const RU = await umbrella(records, 'Org Perf Records Unit')
const hus = await account(hr, { account_type: 'STAFF', office_id: HU.id, last_name: 'HrUnit', email: `orgp.hus.${stamp}@test.local` })
const r1 = await admin.call('POST', '/routes', { name: `Org perf ${stamp}`, steps: [{ office_id: hrOffice.id, action_label: 'Review' }, { office_id: recordsOffice.id, action_label: 'Review' }] })
const routeId = r1.body?.route?.id as string
const doc = await upload(hs, 'Org perf hand-off', routeId)
const qr = await qrOf(hs, doc.id)
await step('handed to HR’s unit', await hs.call('POST', `/documents/${doc.id}/umbrella-handoff`, { umbrella_id: HU.id }))
await step('the unit receives it', await scan(hus.session, qr, 'RECEIVE'))
await step('the unit returns it', await hus.session.call('POST', `/documents/${doc.id}/umbrella-return`, {}))

// ════════════════════════════════════════════════════════════════════════════════════════════════════
console.log('\n1. Every office of the organization, grouped')
let r = await perf()
check(r.status === 200, 'the ADMIN gets the organization view', why(r))
const all = r.body
const list = ids(all)
check(list.includes(hrOffice.id) && list.includes(recordsOffice.id) && list.includes(HU.id) && list.includes(RU.id), 'main offices and umbrella offices are all there', list.length)
check(list.indexOf(HU.id) > list.indexOf(hrOffice.id) && list.indexOf(RU.id) > list.indexOf(recordsOffice.id), 'each umbrella office comes after its main office', { hr: list.indexOf(hrOffice.id), hu: list.indexOf(HU.id) })
const grouped = all.offices.every((o: any, i: number) => {
  if (o.office.kind === 'MAIN') return true
  // Walk back to the nearest main office: it must be this unit's parent.
  for (let j = i - 1; j >= 0; j--) if (all.offices[j].office.kind === 'MAIN') return all.offices[j].office.id === o.office.parent_office_id
  return false
})
check(grouped, 'every umbrella office sits under its own main office', null)
check(row(all, HU.id)?.office.parent_office_id === hrOffice.id && row(all, HU.id)?.office.kind === 'UMBRELLA', 'umbrella rows name their main office', row(all, HU.id)?.office)
check(all.organization?.active_main_offices >= 2 && all.organization?.active_umbrella_offices >= 2, 'active main and umbrella offices are counted', all.organization)
check(all.choices?.some((c: any) => c.id === HU.id && c.parent_office_id === hrOffice.id), 'the filter choices list the offices with their main office', all.choices?.length)

console.log('\n2. The same numbers as the Department Head sees, and distinct totals')
const dh = (await hr.call('GET', '/dashboard/umbrella-performance')).body
for (const id of [hrOffice.id, HU.id]) {
  const a = row(all, id)
  const d = (dh.offices ?? []).find((o: any) => o.office.id === id)
  const keys = ['received', 'completed', 'forwarded', 'pending', 'overdue', 'clearance_rate', 'completion_rate', 'avg_processing_minutes']
  check(a && d && keys.every((k) => a[k] === d[k]), `${id === hrOffice.id ? 'HR' : 'HR’s unit'}: the ADMIN and HR’s head see the same numbers`, { admin: a && keys.map((k) => a[k]), head: d && keys.map((k) => d[k]) })
}
check(row(all, HU.id)?.received === 1 && row(all, HU.id)?.forwarded === 1 && row(all, HU.id)?.completed === 0, 'the unit’s own work: received 1, passed back 1, completed none', row(all, HU.id))
const orgDelta = all.organization.received - (before.organization?.received ?? 0)
check(orgDelta === 1, 'the organization counts the document once, although HR and its unit both received it', { now: all.organization.received, then: before.organization?.received })
const sumOffices = all.offices.reduce((n: number, o: any) => n + o.received, 0)
check(all.organization.received <= sumOffices, 'organization received ≤ the sum of the offices’ received (distinct documents)', { org: all.organization.received, sum: sumOffices })
check(all.organization.pending === all.offices.reduce((n: number, o: any) => n + o.pending, 0), 'organization pending = the sum of the offices’ (a document is in one place)', all.organization.pending)
check(all.organization.completion_rate === null || (all.organization.completion_rate >= 0 && all.organization.completion_rate <= 1), 'the completion rate is a share', all.organization.completion_rate)

console.log('\n3. Filters')
r = await perf('?kind=main')
check(r.status === 200 && r.body.offices.length > 0 && r.body.offices.every((o: any) => o.office.kind === 'MAIN'), 'main offices only', ids(r.body).length)
r = await perf('?kind=umbrella')
check(r.status === 200 && r.body.offices.length > 0 && r.body.offices.every((o: any) => o.office.kind === 'UMBRELLA'), 'umbrella offices only', ids(r.body).length)
r = await perf(`?main_office_id=${hrOffice.id}`)
check(r.status === 200 && ids(r.body)[0] === hrOffice.id && ids(r.body).includes(HU.id) && !ids(r.body).includes(RU.id) && !ids(r.body).includes(recordsOffice.id), 'one main office: it and its umbrella offices', ids(r.body).length)
r = await perf(`?office_id=${HU.id}`)
check(r.status === 200 && ids(r.body).length === 1 && ids(r.body)[0] === HU.id, 'one umbrella office', ids(r.body))
check(r.body.organization.received === 1, '…with its own distinct total', r.body.organization)
// Its time is measured even though its main office (whose step it is part of) isn't selected.
check(
  r.body.organization.processing_measured === r.body.offices[0].processing_measured && r.body.organization.processing_measured > 0 && r.body.organization.avg_processing_minutes === r.body.offices[0].avg_processing_minutes,
  '…and its own processing time (not “nothing measured”)',
  { org: [r.body.organization.avg_processing_minutes, r.body.organization.processing_measured], unit: [r.body.offices[0].avg_processing_minutes, r.body.offices[0].processing_measured] },
)
r = await perf('?kind=umbrella')
const unitSamples = r.body.offices.reduce((n: number, o: any) => n + o.processing_measured, 0)
check(r.body.organization.processing_measured === unitSamples, 'umbrella offices only: the total time is over every unit’s samples', { org: r.body.organization.processing_measured, units: unitSamples })
r = await perf(`?office_id=${recordsOffice.id}`)
check(r.status === 200 && ids(r.body).length === 1 && ids(r.body)[0] === recordsOffice.id, 'one main office on its own', ids(r.body))
r = await perf(`?main_office_id=${HU.id}`)
check(r.status === 404, 'an umbrella office is not a main office filter', why(r))
r = await perf(`?office_id=${crypto.randomUUID()}`)
check(r.status === 404, 'an office that doesn’t exist: 404', why(r))
for (const d of [7, 30, 90]) {
  r = await perf(`?days=${d}`)
  check(r.status === 200 && r.body.range.days === d && r.body.trend.length === d, `the ${d}-day period`, r.body?.range)
}

console.log('\n4. One office in detail')
r = await admin.call('GET', `/dashboard/office-performance/${HU.id}`)
check(r.status === 200 && r.body.summary?.office?.id === HU.id && r.body.summary.received === 1, 'the ADMIN opens an umbrella office', why(r))
check((r.body?.staff ?? []).some((s: any) => s.id === hus.id && s.received === 1), '…with its people', r.body?.staff)
check((r.body?.recent_activity ?? []).some((a: any) => a.kind === 'RETURNED_TO_OFFICE'), '…and its recent activity', r.body?.recent_activity?.slice(0, 3))
r = await admin.call('GET', `/dashboard/office-performance/${hrOffice.id}`)
check(r.status === 200 && r.body.summary?.office?.id === hrOffice.id, 'and a main office', why(r))
r = await admin.call('GET', `/dashboard/office-performance/${crypto.randomUUID()}`)
check(r.status === 404, 'an unknown office: 404', why(r))

console.log('\n5. Nobody else, and nothing else changed')
for (const [label, s] of [['a Department Head', hr], ['Staff', hs]] as const) {
  r = await s.call('GET', '/dashboard/office-performance')
  check(r.status === 403, `${label} cannot use the organization view`, why(r))
  r = await s.call('GET', `/dashboard/office-performance/${HU.id}`)
  check(r.status === 403, `${label} cannot open an office there`, why(r))
}
const anon = await fetch(`${BASE}/api/dashboard/office-performance`)
check(anon.status === 401, 'without a session → 401', anon.status)
r = await admin.call('GET', '/dashboard/umbrella-performance')
check(r.status === 403, 'the ADMIN still cannot use the Department Head’s view (unchanged)', why(r))
r = await admin.call('GET', '/dashboard')
check(r.status === 200 && r.body.account_type === 'ADMIN', 'the ADMIN dashboard still works', why(r))
r = await admin.call('GET', `/dashboard/cards?office_id=${hrOffice.id}`)
check(r.status === 200, 'the ADMIN dashboard cards still work', why(r))

if (argv.db) {
  console.log('\n6. Another organization (--db)')
  const host = process.env.DB_HOST ?? ''
  if (process.env.FV_THROWAWAY_DB !== '1' || !['localhost', '127.0.0.1'].includes(host)) throw new Error('--db needs FV_THROWAWAY_DB=1 and DB_* of the local throwaway database the app runs on')
  const mysql = await import('mysql2/promise')
  const db = await mysql.createConnection({ host, port: Number(process.env.DB_PORT), user: process.env.DB_USER, password: process.env.DB_PASS ?? '', database: process.env.DB_NAME })
  const [org2, main2, unit2] = [crypto.randomUUID(), crypto.randomUUID(), crypto.randomUUID()]
  await db.query('INSERT INTO organizations (id, name) VALUES (?, ?)', [org2, `Other org ${stamp}`])
  await db.query('INSERT INTO offices (id, org_id, name, code, parent_office_id) VALUES (?, ?, ?, ?, NULL), (?, ?, ?, ?, ?)', [main2, org2, `Other main ${stamp}`, `OM-${stamp}`, unit2, org2, `Other unit ${stamp}`, `OU-${stamp}`, main2])
  r = await perf()
  check(!ids(r.body).includes(main2) && !ids(r.body).includes(unit2) && !(r.body.choices ?? []).some((c: any) => c.id === main2), 'another organization’s offices are not listed', ids(r.body).length)
  for (const q of [`?office_id=${unit2}`, `?main_office_id=${main2}`]) {
    r = await perf(q)
    check(r.status === 404, `filtering on another organization’s office: 404 (${q.split('=')[0]})`, why(r))
  }
  r = await admin.call('GET', `/dashboard/office-performance/${unit2}`)
  check(r.status === 404, 'another organization’s office in detail: 404', why(r))
  await db.query('DELETE FROM offices WHERE id = ?', [unit2]) // the unit first: it points at its main office
  await db.query('DELETE FROM offices WHERE id = ?', [main2])
  await db.query('DELETE FROM organizations WHERE id = ?', [org2])
  await db.end()
} else {
  console.log('\n(skipped: another organization — add --db with FV_THROWAWAY_DB=1 and the throwaway DB_*)')
}

console.log(`\n${passed} passed, ${failed} failed`)
process.exitCode = failed ? 1 : 0
