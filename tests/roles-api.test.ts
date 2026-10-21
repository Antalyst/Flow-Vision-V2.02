/**
 * Roles end to end: login, session validation and role-based authorization against a running app.
 *
 *   npm run dev                       (in another terminal, on a LOCAL database with the demo seed)
 *   npm run test:roles-api            (or: node tests/roles-api.test.ts --base=http://localhost:3000)
 *
 * Signs in as the seeded demo accounts (one per role) and checks what each may and may not do,
 * plus session handling and that there is no public registration. It writes to the database it
 * runs against: accounts rt.*@flowvision.test. It refuses a non-local --base unless --remote.
 * Cross-organization checks need an ADMIN of a second organization (there is no public sign-up to
 * make one): --other-admin=<email> --other-password=<password>; without them they are skipped.
 */
const argv: Record<string, string> = Object.fromEntries(
  process.argv.slice(2).map((a) => {
    const m = /^--([^=]+)(?:=(.*))?$/.exec(a)
    return m ? [m[1]!, m[2] ?? 'true'] : [a, 'true']
  }),
)
const BASE = (argv.base ?? process.env.FV_BASE_URL ?? 'http://localhost:3000').replace(/\/$/, '')
const PASSWORD = argv.password ?? process.env.FV_DEMO_PASSWORD ?? 'Demo@1234'
const ACCOUNTS = {
  ADMIN: argv.admin ?? 'client@bago.gov.ph',
  DEPARTMENT_HEAD: argv.head ?? 'records@bago.gov.ph',
  STAFF: argv.staff ?? 'hr.staff@bago.gov.ph',
  LIAISON: argv.liaison ?? 'liaison.adm@bago.gov.ph',
}
if (!/^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(BASE) && !argv.remote) {
  console.error(`Refusing to run against ${BASE}: this test creates accounts. Use a local app, or add --remote.`)
  process.exit(1)
}

let failed = 0
let passed = 0
function check(ok: unknown, label: string, detail = '') {
  if (ok) passed++
  else failed++
  console.log(`${ok ? '\x1b[32m✔\x1b[0m' : '\x1b[31m✘\x1b[0m'} ${label}${ok ? '' : `  → ${detail}`}`)
}

type Call = (method: string, path: string, json?: unknown) => Promise<{ status: number; body: any }>
const request = async (cookie: string, method: string, path: string, json?: unknown) => {
  const r = await fetch(`${BASE}/api${path}`, {
    method,
    headers: { ...(cookie && { cookie }), ...(json !== undefined && { 'content-type': 'application/json' }) },
    body: json !== undefined ? JSON.stringify(json) : undefined,
  })
  return { status: r.status, body: await r.json().catch(() => null) }
}

async function login(email: string, password = PASSWORD) {
  const res = await fetch(`${BASE}/api/auth/login`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email, password }) })
  const cookie = (res.headers.get('set-cookie') ?? '').split(';')[0]!
  const body = (await res.json().catch(() => ({}))) as { user?: any }
  const call: Call = (method, path, json) => request(cookie, method, path, json)
  return { status: res.status, user: body.user, cookie, call }
}

const health = await fetch(`${BASE}/api/health`).catch(() => null)
if (!health?.ok) {
  console.error(`The app is not reachable at ${BASE} (start it with npm run dev).`)
  process.exit(1)
}

// ── Login ──────────────────────────────────────────────────────────────────────
const s = {} as Record<keyof typeof ACCOUNTS, Awaited<ReturnType<typeof login>>>
for (const [role, email] of Object.entries(ACCOUNTS) as Array<[keyof typeof ACCOUNTS, string]>) {
  s[role] = await login(email)
  check(s[role].status === 200 && s[role].user?.account_type === role, `${email} signs in as ${role}`, `${s[role].status} ${s[role].user?.account_type ?? JSON.stringify(s[role].user)}`)
}
if (failed) {
  console.error('\nThe demo accounts could not sign in with their roles — stopping. Seed a local database (npm run db:reset) or pass --admin= --head= --staff= --liaison= --password=.')
  process.exit(1)
}
const wrong = await login(ACCOUNTS.ADMIN, `${PASSWORD}-wrong`)
check(wrong.status === 401 && !wrong.cookie.startsWith('fv_session='), 'A wrong password is refused and gets no session', `${wrong.status}`)

// ── Session validation ─────────────────────────────────────────────────────────
check((await request('', 'GET', '/auth/me')).status === 401, 'No session cookie → 401')
check((await request('fv_session=forged-token-value', 'GET', '/auth/me')).status === 401, 'A forged session cookie → 401')
const me = await s.STAFF.call('GET', '/auth/me')
check(me.status === 200 && me.body?.user?.account_type === 'STAFF', 'A valid session returns the role stored in the database')
const throwaway = await login(ACCOUNTS.LIAISON)
check((await throwaway.call('POST', '/auth/logout')).status === 200, 'Logout succeeds')
check((await throwaway.call('GET', '/auth/me')).status === 401, 'The logged-out session no longer works')
check((await s.LIAISON.call('GET', '/auth/me')).status === 200, "…while the same user's other session still does")

// The browser can't change its own role.
await s.STAFF.call('PATCH', '/auth/me', { account_type: 'ADMIN', first_name: s.STAFF.user.first_name })
check((await s.STAFF.call('GET', '/auth/me')).body?.user?.account_type === 'STAFF', 'PATCH /auth/me ignores an account_type sent by the browser')
check((await s.STAFF.call('GET', '/org/settings')).status === 403, '…and the account still has no admin access')

// ── ADMIN ──────────────────────────────────────────────────────────────────────
check((await s.ADMIN.call('GET', '/org/settings')).status === 200, 'ADMIN opens Organization Settings')
check((await s.ADMIN.call('GET', '/dashboard/cards')).status === 200, 'ADMIN gets the organization dashboard cards')
check((await s.ADMIN.call('GET', '/dashboard')).body?.account_type === 'ADMIN', 'ADMIN gets the organization dashboard')
check((await s.ADMIN.call('POST', '/qr/verify', { payload: 'BAG-ADM-RECORDS100726123456' })).status === 403, "ADMIN can't scan QR codes (follows along only)")
check((await s.ADMIN.call('GET', '/forecast/office')).status === 403, "ADMIN doesn't get the department head's office forecast")

// ── DEPARTMENT_HEAD ────────────────────────────────────────────────────────────
for (const [method, path, body] of [
  ['GET', '/org/settings'],
  ['GET', '/dashboard/cards'],
  ['POST', '/routes', { name: 'x', steps: [] }],
  ['POST', '/offices', { name: 'x', code: 'X-1', department: 'x' }],
  ['PATCH', '/org', { name: 'x' }],
] as Array<[string, string, unknown?]>) {
  check((await s.DEPARTMENT_HEAD.call(method, path, body)).status === 403, `DEPARTMENT_HEAD is refused ${method} ${path}`)
}
check((await s.DEPARTMENT_HEAD.call('GET', '/forecast/office')).status === 200, 'DEPARTMENT_HEAD gets its office forecast')
check((await s.DEPARTMENT_HEAD.call('GET', '/dashboard')).body?.account_type === 'DEPARTMENT_HEAD', 'DEPARTMENT_HEAD gets the office dashboard')
check((await s.DEPARTMENT_HEAD.call('GET', '/documents')).status === 200, 'DEPARTMENT_HEAD lists its office documents')

// ── STAFF ──────────────────────────────────────────────────────────────────────
check((await s.STAFF.call('GET', '/forecast/office')).status === 403, "STAFF doesn't get the office forecast")
check((await s.STAFF.call('POST', '/routes', { name: 'x', steps: [] })).status === 403, "STAFF can't create routes")
check((await s.STAFF.call('GET', '/approvals')).status === 200, 'STAFF reaches the approvals list')

// ── LIAISON (Messenger) ────────────────────────────────────────────────────────
check((await s.LIAISON.call('GET', '/liaisons/me')).status === 200, 'LIAISON gets its delivery profile')
check((await s.LIAISON.call('GET', '/ai/conversations')).status === 403, "LIAISON can't use the AI assistant")
check((await s.LIAISON.call('POST', '/users', { account_type: 'LIAISON', email: 'x@flowvision.test', first_name: 'x', last_name: 'y' })).status === 403, "LIAISON can't create accounts")
check((await s.LIAISON.call('GET', '/approvals')).status === 403, "LIAISON can't reach approvals")

// ── Account management ─────────────────────────────────────────────────────────
const stamp = Date.now()
const offices = ((await s.ADMIN.call('GET', '/offices')).body?.data ?? []) as Array<{ id: string; code: string; parent_office_id?: string | null }>
const headOffice = s.DEPARTMENT_HEAD.user.office?.id as string
// Another office: not the head's own, and not one of its umbrella offices (where it may place staff).
const otherOffice = offices.find((o) => o.id !== headOffice && o.parent_office_id !== headOffice)?.id
const made = await s.ADMIN.call('POST', '/users', { account_type: 'DEPARTMENT_HEAD', email: `rt.head.${stamp}@flowvision.test`, first_name: 'Role', last_name: 'Head', office_id: headOffice })
check(made.status === 201 && made.body?.user?.account_type === 'DEPARTMENT_HEAD', 'ADMIN creates a DEPARTMENT_HEAD (stored with the new value)', `${made.status}`)
for (const old of ['CLIENT', 'EMPLOYEE']) {
  const r = await s.ADMIN.call('POST', '/users', { account_type: old, email: `rt.old.${old}.${stamp}@flowvision.test`, first_name: 'Old', last_name: 'Value', office_id: headOffice })
  check(r.status === 400, `The old value ${old} is rejected`, `${r.status}`)
}
for (const [role, target] of [
  ['DEPARTMENT_HEAD', 'ADMIN'],
  ['STAFF', 'STAFF'],
] as Array<[keyof typeof ACCOUNTS, string]>) {
  const r = await s[role].call('POST', '/users', { account_type: target, email: `rt.${role}.${target}.${stamp}@flowvision.test`.toLowerCase(), first_name: 'X', last_name: 'Y' })
  check([400, 403].includes(r.status) && !r.body?.user, `${role} can't create an account of type ${target}`, `${r.status}`)
}
// A Department Head adds a Department Head only as a delegate: assigned by it, with no permissions unless granted.
const delegateMade = await s.DEPARTMENT_HEAD.call('POST', '/users', { account_type: 'DEPARTMENT_HEAD', email: `rt.dh.dh.${stamp}@flowvision.test`, first_name: 'X', last_name: 'Y' })
check(delegateMade.status === 201 && delegateMade.body?.user?.delegated === true && delegateMade.body.user.permissions?.length === 0, 'DEPARTMENT_HEAD adds a DEPARTMENT_HEAD only as a delegate with no permissions', `${delegateMade.status}`)
const otherOfficeStaff = await s.DEPARTMENT_HEAD.call('POST', '/users', { account_type: 'STAFF', email: `rt.staff.other.${stamp}@flowvision.test`, first_name: 'New', last_name: 'Staff', office_id: otherOffice })
check(otherOfficeStaff.status === 403, 'DEPARTMENT_HEAD cannot place STAFF in another office (refused, not ignored)', `${otherOfficeStaff.status}`)
const staffMade = await s.DEPARTMENT_HEAD.call('POST', '/users', { account_type: 'STAFF', email: `rt.staff.${stamp}@flowvision.test`, first_name: 'New', last_name: 'Staff' })
check(staffMade.status === 201 && staffMade.body?.user?.office?.id === headOffice, 'DEPARTMENT_HEAD creates STAFF in its own office', `${staffMade.status}`)

const roster = ((await s.ADMIN.call('GET', '/users')).body?.data ?? []) as Array<{ id: string; email: string; office: { id: string } | null; account_type: string }>
const outsider = roster.find((u) => u.office?.id && u.office.id !== headOffice && ['STAFF', 'LIAISON'].includes(u.account_type))
if (outsider) {
  check((await s.DEPARTMENT_HEAD.call('PATCH', `/users/${outsider.id}`, { first_name: 'Changed' })).status === 404, "DEPARTMENT_HEAD can't edit an account of another office")
}
check((await s.ADMIN.call('PATCH', `/users/${s.ADMIN.user.id}`, { account_type: 'STAFF', office_id: headOffice })).status === 403, "ADMIN can't demote its own account")
check((await s.DEPARTMENT_HEAD.call('PATCH', `/users/${s.DEPARTMENT_HEAD.user.id}`, { account_type: 'ADMIN' })).status === 404, "DEPARTMENT_HEAD can't promote itself to ADMIN")
check((await s.DEPARTMENT_HEAD.call('GET', '/auth/me')).body?.user?.account_type === 'DEPARTMENT_HEAD', '…its role is unchanged')

// ── No public registration ─────────────────────────────────────────────────────
// The initial ADMIN comes from `npm run admin:bootstrap` (command line only); nothing over HTTP
// creates an organization or an ADMIN without an ADMIN session.
const bagoOrg = s.ADMIN.user.organization?.id as string
const regEmail = `rt.reg.${stamp}@flowvision.test`
const regBody = { organization_name: `Role Test Org ${stamp}`, first_name: 'Reg', last_name: 'Test', email: regEmail, password: 'RoleTest#2026x', account_type: 'ADMIN', org_id: bagoOrg, organization_id: bagoOrg }
const reg = await request('', 'POST', '/auth/register', regBody)
check(reg.status === 404 || reg.status === 405, 'Public registration is gone: POST /api/auth/register is not found', `${reg.status}`)
for (const path of ['/auth/bootstrap', '/bootstrap', '/setup', '/org', '/organizations']) {
  const r = await request('', 'POST', path, regBody)
  check([401, 403, 404, 405].includes(r.status), `No unauthenticated organization or administrator creation at POST /api${path}`, `${r.status}`)
}
check((await request('', 'POST', '/users', { ...regBody, account_type: 'ADMIN' })).status === 401, 'Creating an account without a session → 401')
check((await login(regEmail, 'RoleTest#2026x')).status === 401, '…and none of those attempts created an account')
const regPage = await fetch(`${BASE}/register`, { redirect: 'manual' })
const regHtml = await regPage.text().catch(() => '')
check(regPage.status !== 200 && !/Create your organization/i.test(regHtml), 'The /register page is not served', `${regPage.status}`)
const loginHtml = await (await fetch(`${BASE}/login`)).text()
check(!/href="\/register"/.test(loginHtml) && !/Create an account/.test(loginHtml), 'The sign-in page has no sign-up link')
for (const role of ['DEPARTMENT_HEAD', 'STAFF', 'LIAISON'] as const) {
  const r = await s[role].call('POST', '/users', { account_type: 'ADMIN', email: `rt.esc.${role}.${stamp}@flowvision.test`.toLowerCase(), first_name: 'E', last_name: 'Sc' })
  check([400, 403].includes(r.status), `${role} can't create an ADMIN account`, `${r.status}`)
}
check((await s.STAFF.call('PATCH', '/auth/me', { account_type: 'ADMIN' })).body?.user?.account_type !== 'ADMIN' && (await s.STAFF.call('GET', '/auth/me')).body?.user?.account_type === 'STAFF', "STAFF can't make itself ADMIN through its profile")

// ── Cross-organization isolation (needs an ADMIN of a second organization) ─────────
if (argv['other-admin']) {
  const outsiderAdmin = await login(argv['other-admin'], argv['other-password'] ?? PASSWORD)
  check(outsiderAdmin.status === 200 && outsiderAdmin.user?.account_type === 'ADMIN' && outsiderAdmin.user?.organization?.id !== bagoOrg, 'The second organization\'s ADMIN signs in', `${outsiderAdmin.status}`)
  const bagoDocs = new Set((((await s.ADMIN.call('GET', '/documents')).body?.data ?? []) as Array<{ id: string }>).map((d) => d.id))
  const seen = ((await outsiderAdmin.call('GET', '/documents')).body?.data ?? []) as Array<{ id: string }>
  check(seen.every((d) => !bagoDocs.has(d.id)), "The other organization's ADMIN sees none of this organization's documents")
  check((await outsiderAdmin.call('PATCH', `/users/${s.STAFF.user.id}`, { first_name: 'Changed' })).status === 404, "…and can't edit its accounts")
  check((await outsiderAdmin.call('GET', `/messages/office`)).status === 403, '…and has no office channel (no office)')
} else {
  console.log('- cross-organization checks skipped: pass --other-admin=<email> --other-password=<password> (an ADMIN of a second organization)')
}

console.log(`\n${passed} passed, ${failed} failed`)
process.exit(failed ? 1 : 0)
