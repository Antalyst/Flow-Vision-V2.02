/**
 * Team pages end to end, against a running app (direct API calls): the users browser by office
 * (ADMIN and Department Head scope), generated office codes, umbrella offices with their Department
 * Head, and staff creating messenger accounts.
 *
 *   npm run dev                              (another terminal; LOCAL database with the demo seed)
 *   npm run test:team-offices-api            (or: node tests/team-offices-api.test.ts --base=http://localhost:3000)
 *
 * It writes to the database it runs against (offices "TO Test …", accounts to.*@flowvision.test) and
 * refuses a non-local --base unless --remote. Cross-organization checks need an ADMIN of a second
 * organization: --other-admin=<email> --other-password=<password>; without them they are skipped.
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
  console.error(`Refusing to run against ${BASE}: this test creates offices and accounts. Use a local app, or add --remote.`)
  process.exit(1)
}

let failed = 0
let passed = 0
function check(ok: unknown, label: string, detail: unknown = '') {
  if (ok) passed++
  else failed++
  console.log(`${ok ? '\x1b[32m✔\x1b[0m' : '\x1b[31m✘\x1b[0m'} ${label}${ok ? '' : `  → ${typeof detail === 'string' ? detail : JSON.stringify(detail)?.slice(0, 300)}`}`)
}

type Res = { status: number; body: any }
type Call = (method: string, path: string, json?: unknown) => Promise<Res>
async function login(email: string, password = PASSWORD) {
  const res = await fetch(`${BASE}/api/auth/login`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email, password }) })
  const cookie = (res.headers.get('set-cookie') ?? '').split(';')[0]!
  const body = (await res.json().catch(() => ({}))) as { user?: any }
  const call: Call = async (method, path, json) => {
    const r = await fetch(`${BASE}/api${path}`, { method, headers: { cookie, ...(json !== undefined && { 'content-type': 'application/json' }) }, body: json !== undefined ? JSON.stringify(json) : undefined })
    return { status: r.status, body: await r.json().catch(() => null) }
  }
  return { status: res.status, user: body.user, call }
}
const qs = (o: Record<string, unknown>) => new URLSearchParams(Object.entries(o).filter(([, v]) => v !== undefined && v !== '').map(([k, v]) => [k, String(v)])).toString()

const health = await fetch(`${BASE}/api/health`).catch(() => null)
if (!health?.ok) {
  console.error(`The app is not reachable at ${BASE} (start it with npm run dev).`)
  process.exit(1)
}

const stamp = Date.now().toString().slice(-6)
const admin = await login(argv.admin ?? 'client@bago.gov.ph')
const hr = await login(argv.head ?? 'hr@bago.gov.ph') // managing Department Head of HRMSO
const records = await login('records@bago.gov.ph') // managing Department Head of another office
const staff = await login(argv.staff ?? 'hr.staff@bago.gov.ph')
const liaison = await login('liaison.adm@bago.gov.ph')
for (const [name, s] of Object.entries({ admin, hr, records, staff, liaison })) {
  if (s.status !== 200) {
    console.error(`Could not sign in as the demo ${name} account (${s.status}). Seed a local database (npm run db:reset).`)
    process.exit(1)
  }
}
const hrOffice = hr.user.office as { id: string; name: string; code: string }
let r: Res

// ════════════════════════════════════════════════════════════════════════════════════
console.log('\n1. Generated office codes (ADMIN offices)')
const name = `TO Test Human Resources ${stamp}`
r = await admin.call('POST', '/offices', { name, location: 'City Hall, 2nd floor' })
check(r.status === 201 && /^[A-Z0-9]{2,4}$/.test(r.body?.office?.code), 'an office created without a code gets a 2–4 character uppercase code', r.body)
const first = r.body?.office
check(first?.location === 'City Hall, 2nd floor', 'an office still keeps its address', first?.location)
r = await admin.call('POST', '/offices', { name })
check(r.status === 201 && r.body.office.code !== first?.code && /^[A-Z0-9]{2,4}$/.test(r.body.office.code), 'the same name again gets a different code', [first?.code, r.body?.office?.code])
const raceName = `TO Race Office ${stamp}`
const race = await Promise.all(Array.from({ length: 6 }, () => admin.call('POST', '/offices', { name: raceName })))
const raceCodes = race.map((x) => x.body?.office?.code)
check(race.every((x) => x.status === 201) && new Set(raceCodes).size === 6, 'six simultaneous creations with one name get six different codes', raceCodes)
r = await admin.call('PATCH', `/offices/${first.id}`, { name: `${name} renamed`, location: 'Annex' })
check(r.status === 200 && r.body.office.code === first.code, 'renaming keeps the code', r.body?.office?.code)
r = await admin.call('PATCH', `/offices/${first.id}`, { name: `TO Test Budget Office ${stamp}`, regenerate_code: true })
check(r.status === 200 && r.body.office.code !== first.code && /^[A-Z0-9]{2,4}$/.test(r.body.office.code), 'regenerate_code gives a new code from the new name', r.body?.office?.code)
r = await admin.call('POST', '/offices', { name: `TO Explicit ${stamp}`, code: `TOX-${stamp}` })
check(r.status === 201 && r.body.office.code === `TOX-${stamp}`, 'an explicit code is still accepted (scripts, API)', r.body)
r = await admin.call('POST', '/offices', { name: '!!! ---' })
check(r.status === 400, 'a name without letters or digits is refused', r.status)
r = await hr.call('POST', '/offices', { name: `TO Not Allowed ${stamp}` })
check(r.status === 403, 'a Department Head cannot create offices', r.status)

// ════════════════════════════════════════════════════════════════════════════════════
console.log('\n2. Umbrella offices: no address, generated code, Department Head')
r = await hr.call('POST', '/offices/umbrellas', { name: `TO Sanitation Unit ${stamp}` })
check(r.status === 201 && new RegExp(`^${hrOffice.code}-[A-Z0-9]{2,4}$`).test(r.body?.office?.code), 'created with a name only: code = office code + generated suffix', r.body)
const plain = r.body?.office
check(plain?.location == null, 'no address is needed', plain?.location)

const headEmail = `to.head.${stamp}@flowvision.test`
r = await hr.call('POST', '/offices/umbrellas', { name: `TO Payroll Unit ${stamp}`, head: { mode: 'new', first_name: 'Una', last_name: 'Head', email: headEmail, permissions: ['RECEIVE_DOCUMENTS', 'PASS_DOCUMENTS', 'MANAGE_UMBRELLAS'] } })
check(r.status === 400 && /main office/.test(r.body?.message ?? ''), 'a head of an umbrella office cannot get main-office-only permissions', r.body?.message)
r = await hr.call('GET', `/users/directory?${qs({ office_id: hrOffice.id, q: headEmail })}`)
check(r.body?.meta?.total === 0, '…and nothing was created (office and head are one transaction)', r.body?.meta)
r = await hr.call('POST', '/offices/umbrellas', { name: `TO Payroll Unit ${stamp}`, head: { mode: 'new', first_name: 'Una', last_name: 'Head', email: headEmail, permissions: ['RECEIVE_DOCUMENTS', 'PASS_DOCUMENTS'] } })
check(r.status === 201 && r.body.head?.account_type === 'DEPARTMENT_HEAD' && r.body.head.office?.id === r.body.office.id && r.body.temporary_password, 'created with a new Department Head account in it (temporary password once)', r.body)
const payroll = r.body?.office
const newHead = await login(headEmail, r.body?.temporary_password)
check(newHead.status === 200 && newHead.user?.delegated === true && newHead.user.office?.id === payroll?.id && JSON.stringify(newHead.user.permissions) === JSON.stringify(['RECEIVE_DOCUMENTS', 'PASS_DOCUMENTS']), 'the new head signs in as a delegated head of that umbrella office with the granted permissions', newHead.user)
r = await hr.call('POST', '/offices/umbrellas', { name: `TO Dup ${stamp}`, head: { mode: 'new', first_name: 'D', last_name: 'Up', email: headEmail } })
check(r.status === 409, 'a duplicate email is refused', r.status)

// An existing delegate of the main office is moved to an umbrella office.
const delegateEmail = `to.delegate.${stamp}@flowvision.test`
r = await hr.call('POST', '/users', { account_type: 'DEPARTMENT_HEAD', first_name: 'Dee', last_name: 'Legate', email: delegateEmail, permissions: ['RECEIVE_DOCUMENTS', 'MANAGE_UMBRELLAS'] })
check(r.status === 201, 'a delegated head of the main office exists', r.status)
const delegate = r.body?.user
r = await hr.call('GET', '/offices/umbrellas')
check(r.status === 200 && r.body.can_assign_heads === true && r.body.eligible_heads.some((h: any) => h.id === delegate?.id), 'it is offered as an eligible head', r.body?.eligible_heads?.length)
r = await hr.call('PATCH', `/offices/umbrellas/${plain.id}`, { head: { mode: 'existing', user_id: delegate.id } })
check(r.status === 200 && r.body.head?.id === delegate.id, 'an existing umbrella office is given that head', r.body)
r = await hr.call('GET', `/users/directory?${qs({ office_id: hrOffice.id, umbrella_id: plain.id })}`)
const moved = r.body?.data?.find((m: any) => m.id === delegate.id)
check(moved?.office?.id === plain.id && !moved.permissions.includes('MANAGE_UMBRELLAS'), 'the head now belongs to the umbrella office, without main-office-only permissions', moved)
const hist = await hr.call('GET', `/users/${delegate.id}/assignments`)
check((hist.body?.data ?? []).some((h: any) => h.office_id === plain.id || h.office?.id === plain.id), 'the move is in the assignment history', hist.body?.data?.[0])
r = await hr.call('PATCH', `/offices/umbrellas/${plain.id}`, { head: { mode: 'existing', user_id: hr.user.id } })
check(r.status === 400, 'the managing head of the office is not an eligible head', r.status)
r = await hr.call('PATCH', `/offices/umbrellas/${plain.id}`, { head: { mode: 'existing', user_id: staff.user.id } })
check(r.status === 400, 'a staff member is not an eligible head', r.status)
r = await hr.call('PATCH', `/offices/umbrellas/${plain.id}`, { head: { mode: 'existing', user_id: records.user.id } })
check(r.status === 400, "another office's head is not an eligible head", r.status)
r = await hr.call('PATCH', `/offices/umbrellas/${plain.id}`, { name: `TO Sanitation renamed ${stamp}` })
check(r.status === 200 && r.body.office.code === plain.code, 'renaming an umbrella office keeps its code', r.body?.office?.code)
r = await newHead.call('POST', '/offices/umbrellas', { name: 'TO Nested' })
check(r.status === 403, "an umbrella office's head cannot add umbrella offices", r.status)
r = await records.call('PATCH', `/offices/umbrellas/${plain.id}`, { name: 'Hijack' })
check(r.status === 404, "another office's head cannot edit this umbrella office", r.status)

// ════════════════════════════════════════════════════════════════════════════════════
console.log('\n3. Users by office: ADMIN')
r = await admin.call('GET', '/users/directory/offices')
const cards = r.body?.offices ?? []
check(r.status === 200 && cards.some((o: any) => o.id === hrOffice.id) && r.body.unassigned?.by_role?.ADMIN >= 1, 'the ADMIN gets every office card and the accounts without an office', r.status)
const hrCard = cards.find((o: any) => o.id === hrOffice.id)
check(hrCard?.umbrellas.some((u: any) => u.id === payroll?.id), "the office card lists its umbrella offices", hrCard?.umbrellas?.length)
check(cards.every((o: any) => !o.is_umbrella), 'umbrella offices are not separate cards (they belong to their office)', cards.length)
r = await admin.call('GET', `/users/directory?${qs({ office_id: hrOffice.id, limit: 100 })}`)
const family = r.body?.data ?? []
check(r.status === 200 && family.length && family.every((m: any) => m.office?.id === hrOffice.id || m.office?.parent?.id === hrOffice.id), 'the modal lists the accounts of the office and its umbrella offices only', family.map((m: any) => m.office?.name).slice(0, 5))
check(r.body.meta.total === hrCard?.counts?.total, 'the total matches the card', [r.body?.meta?.total, hrCard?.counts?.total])
r = await admin.call('GET', `/users/directory?${qs({ office_id: hrOffice.id, umbrella_id: payroll.id })}`)
check(r.status === 200 && r.body.data.length >= 1 && r.body.data.every((m: any) => m.office?.id === payroll.id), 'umbrella filter: only that umbrella office', r.body?.data?.length)
r = await admin.call('GET', `/users/directory?${qs({ office_id: hrOffice.id, umbrella_id: 'main' })}`)
check(r.status === 200 && r.body.data.every((m: any) => m.office?.id === hrOffice.id), "'main': the office without its umbrella offices", r.body?.data?.length)
r = await admin.call('GET', `/users/directory?${qs({ office_id: hrOffice.id, account_type: 'STAFF', limit: 100 })}`)
check(r.status === 200 && r.body.data.length && r.body.data.every((m: any) => m.account_type === 'STAFF'), 'role filter', r.body?.data?.length)
r = await admin.call('GET', `/users/directory?${qs({ office_id: hrOffice.id, umbrella_id: payroll.id, account_type: 'DEPARTMENT_HEAD' })}`)
check(r.status === 200 && r.body.data.length === 1 && r.body.data[0].email === headEmail, 'umbrella + role together', r.body?.data?.map((m: any) => m.email))
r = await admin.call('GET', `/users/directory?${qs({ office_id: hrOffice.id, umbrella_id: payroll.id, account_type: 'LIAISON' })}`)
check(r.status === 200 && r.body.data.length === 0 && r.body.meta.total === 0, 'a combination that matches nobody returns an empty page, not an error', r.body?.meta)
r = await admin.call('GET', `/users/directory?${qs({ office_id: hrOffice.id, q: 'una head' })}`)
check(r.status === 200 && r.body.data.some((m: any) => m.email === headEmail), 'search', r.body?.data?.length)
r = await admin.call('GET', `/users/directory?${qs({ office_id: hrOffice.id, limit: 2, page: 1 })}`)
const p1 = r.body
r = await admin.call('GET', `/users/directory?${qs({ office_id: hrOffice.id, limit: 2, page: 2 })}`)
check(p1?.data?.length === 2 && r.body?.data?.length >= 1 && r.body.data[0].id !== p1.data[0].id && p1.meta.pages >= 2, 'pages do not repeat accounts', [p1?.meta, r.body?.meta])
r = await admin.call('GET', `/users/directory?${qs({ office_id: 'none' })}`)
check(r.status === 200 && r.body.data.every((m: any) => !m.office_id), "'none': accounts without an office", r.body?.data?.length)
r = await admin.call('GET', `/users/directory?${qs({ office_id: hrOffice.id, umbrella_id: first.id })}`)
check(r.status === 400, 'an umbrella id from another office is refused', r.status)
r = await admin.call('GET', `/users/directory?${qs({ office_id: hrOffice.id, account_type: 'SUPERADMIN' })}`)
check(r.status === 400, 'an unknown role is refused', r.status)
r = await admin.call('GET', '/users/directory')
check(r.status === 400, 'office_id is required', r.status)

// ════════════════════════════════════════════════════════════════════════════════════
console.log('\n4. Users by office: Department Head scope')
r = await hr.call('GET', '/users/directory/offices')
check(r.status === 200 && r.body.offices.length === 1 && r.body.offices[0].id === hrOffice.id && r.body.unassigned === null, 'a Department Head gets only its own office card (with its umbrella offices)', r.body?.offices?.map((o: any) => o.name))
r = await hr.call('GET', `/users/directory?${qs({ office_id: hrOffice.id, limit: 100 })}`)
check(r.status === 200 && r.body.data.some((m: any) => m.account_type === 'DEPARTMENT_HEAD' && !m.delegated), 'it sees everyone of its office family, its own managing head included', r.body?.data?.length)
check(r.body.data.find((m: any) => m.id === hr.user.id)?.can_manage === false, 'it cannot manage itself (its own row is listed, not editable)', r.body.data.find((m: any) => m.id === hr.user.id))
r = await hr.call('GET', `/users/directory?${qs({ office_id: records.user.office.id })}`)
check(r.status === 404, "another office's users: 404", r.status)
r = await hr.call('GET', `/users/directory?${qs({ office_id: 'none' })}`)
check(r.status === 404, 'accounts without an office (administrators): 404', r.status)
r = await records.call('GET', `/users/directory?${qs({ office_id: records.user.office.id, umbrella_id: payroll.id })}`)
check(r.status === 400, "another office's umbrella office cannot be slipped into the filter", r.status)
r = await newHead.call('GET', '/users/directory/offices')
check(r.status === 200 && r.body.offices.length === 1 && r.body.offices[0].id === payroll.id && r.body.offices[0].umbrellas.length === 0, "an umbrella office's head sees only that umbrella office", r.body?.offices?.map((o: any) => o.name))
r = await newHead.call('GET', `/users/directory?${qs({ office_id: hrOffice.id })}`)
check(r.status === 404, "…and not the main office above it", r.status)
for (const [label, s] of [['STAFF', staff], ['LIAISON', liaison]] as const) {
  r = await s.call('GET', '/users/directory/offices')
  const r2 = await s.call('GET', `/users/directory?${qs({ office_id: hrOffice.id })}`)
  check(r.status === 403 && r2.status === 403, `${label} cannot browse accounts by office`, [r.status, r2.status])
}
r = await fetch(`${BASE}/api/users/directory?${qs({ office_id: hrOffice.id })}`).then((x) => x.status)
check(r === 401, 'no session: 401', r)

// ════════════════════════════════════════════════════════════════════════════════════
console.log('\n5. Staff create messenger accounts')
const liaisonEmail = `to.liaison.${stamp}@flowvision.test`
r = await staff.call('POST', '/users', { account_type: 'LIAISON', first_name: 'Lia', last_name: 'Son', email: liaisonEmail })
check(r.status === 201 && r.body.user.account_type === 'LIAISON' && r.body.user.office_id === staff.user.office.id && r.body.temporary_password, 'a staff member creates a messenger in its own office', r.body)
const made = await login(liaisonEmail, r.body?.temporary_password)
check(made.status === 200 && made.user?.account_type === 'LIAISON' && made.user.must_change_password === true, 'the messenger signs in with the temporary password and must change it', made.user?.account_type)
r = await staff.call('POST', '/users', { account_type: 'LIAISON', first_name: 'L', last_name: 'X', email: `to.liaison.b.${stamp}@flowvision.test`, office_id: records.user.office.id })
check(r.status === 403, 'not in another office', r.status)
for (const role of ['ADMIN', 'DEPARTMENT_HEAD', 'STAFF']) {
  r = await staff.call('POST', '/users', { account_type: role, first_name: 'E', last_name: 'Sc', email: `to.esc.${role.toLowerCase()}.${stamp}@flowvision.test` })
  check(r.status === 400, `not a ${role} account`, r.status)
}
r = await staff.call('POST', '/users', { account_type: 'LIAISON', first_name: 'L', last_name: 'Y', email: liaisonEmail })
check(r.status === 409, 'a duplicate email is refused', r.status)
r = await staff.call('POST', '/users', { account_type: 'LIAISON', first_name: '', last_name: 'Y', email: 'not-an-email' })
check(r.status === 400, 'invalid input is refused', r.status)
r = await staff.call('GET', '/users?managed=1')
check(r.status === 200 && r.body.data.some((m: any) => m.email === liaisonEmail) && r.body.data.every((m: any) => m.account_type === 'LIAISON'), "the staff member's list shows the new messenger (and only messengers)", r.body?.data?.length)
r = await staff.call('PATCH', `/users/${made.user.id}`, { account_type: 'ADMIN' })
check(r.status === 400 || r.status === 403, 'the role cannot be raised afterwards', r.status)

// ════════════════════════════════════════════════════════════════════════════════════
if (argv['other-admin']) {
  console.log('\n6. Cross-organization')
  const other = await login(argv['other-admin'], argv['other-password'] ?? PASSWORD)
  r = await other.call('GET', `/users/directory?${qs({ office_id: hrOffice.id })}`)
  check(r.status === 404, "another organization's ADMIN cannot list this organization's office", r.status)
  r = await other.call('GET', '/users/directory/offices')
  check(r.status === 200 && !(r.body.offices ?? []).some((o: any) => o.id === hrOffice.id), "…nor see it among its office cards", r.body?.offices?.length)
} else {
  console.log('- cross-organization checks skipped: pass --other-admin=<email> --other-password=<password>')
}

console.log(`\n${passed} passed, ${failed} failed`)
process.exitCode = failed ? 1 : 0
