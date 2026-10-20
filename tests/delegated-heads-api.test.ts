/**
 * Delegated Department Heads end to end, against a running app (direct API calls — no UI).
 *
 *   npm run dev                          (another terminal; LOCAL database with the demo seed)
 *   npm run test:delegated-heads-api     (or: node tests/delegated-heads-api.test.ts --base=http://localhost:3000)
 *
 * Creates an umbrella office under the HR office, several Department Heads with different
 * permissions, a staff member and one document routed through the umbrella, then checks that every
 * granted action works, every ungranted one is refused, and nothing crosses offices or
 * organizations. It writes to the database it runs against and refuses a non-local --base unless --remote.
 */
import { DH_PERMISSIONS } from '../shared/dh-permissions.ts'

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
  console.log(`${ok ? '\x1b[32m✔\x1b[0m' : '\x1b[31m✘\x1b[0m'} ${label}${ok ? '' : `  → ${typeof detail === 'string' ? detail : JSON.stringify(detail)}`}`)
}

type Call = (method: string, path: string, body?: unknown) => Promise<{ status: number; body: any }>
async function login(email: string, password = PASSWORD): Promise<{ call: Call; user: any }> {
  const res = await fetch(`${BASE}/api/auth/login`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email, password }) })
  if (!res.ok) throw new Error(`could not sign in as ${email} (${res.status})`)
  const cookie = (res.headers.get('set-cookie') ?? '').split(';')[0]!
  const user = (await res.json()).user
  const call: Call = async (method, path, body) => {
    const form = body instanceof FormData
    const r = await fetch(`${BASE}/api${path}`, {
      method,
      headers: { cookie, ...(!form && body !== undefined && { 'content-type': 'application/json' }) },
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
const admin = await login('client@bago.gov.ph')
const hr = await login('hr@bago.gov.ph') // managing Department Head of the HR office
const records = await login('records@bago.gov.ph') // managing Department Head of another office
const hrOffice = hr.user.office
check(!hr.user.delegated && hr.user.permissions?.length === DH_PERMISSIONS.length, 'an existing Department Head is a managing head with every permission', hr.user.permissions)

async function addAccount(by: { call: Call }, body: Record<string, unknown>) {
  const r = await by.call('POST', '/users', body)
  return r.status === 201 ? { ...r, login: () => login(body.email as string, r.body.temporary_password) } : { ...r, login: null }
}

console.log('\nUmbrella and multiple Department Heads')
let r = await hr.call('POST', '/offices/umbrellas', { name: `Delegation Unit ${stamp}`, code: `${hrOffice.code}-DLG${stamp}` })
check(r.status === 201, 'the managing head adds an umbrella office', r.status)
const umbrella = r.body.office

const a1 = await addAccount(hr, { account_type: 'DEPARTMENT_HEAD', office_id: umbrella.id, first_name: 'Ana', last_name: 'Receiver', email: `dh1.${stamp}@test.local`, permissions: ['RECEIVE_DOCUMENTS', 'PASS_DOCUMENTS'] })
check(a1.status === 201 && a1.body.user.delegated && a1.body.user.assigned_by === hr.user.id && a1.body.user.assigned_at, 'first delegated head: assigned by the managing head, with a time', a1.body?.user)
const a2 = await addAccount(hr, { account_type: 'DEPARTMENT_HEAD', office_id: umbrella.id, first_name: 'Ben', last_name: 'Viewer', email: `dh2.${stamp}@test.local` })
check(a2.status === 201 && a2.body.user.permissions.length === 0, 'second head on the same umbrella (no one-head limit), with no permissions by default', a2.body?.user)
const a3 = await addAccount(hr, { account_type: 'DEPARTMENT_HEAD', office_id: hrOffice.id, first_name: 'Cara', last_name: 'Deputy', email: `dh3.${stamp}@test.local`, permissions: ['ASSIGN_HEADS', 'MANAGE_TEAM', 'RECEIVE_DOCUMENTS'] })
check(a3.status === 201, 'a delegated head in the main office', a3.status)
r = await hr.call('POST', '/users', { account_type: 'DEPARTMENT_HEAD', office_id: umbrella.id, first_name: 'X', last_name: 'Y', email: `dhx.${stamp}@test.local`, permissions: ['MANAGE_UMBRELLAS'] })
check(r.status === 400, 'umbrella management cannot be granted inside an umbrella', r.status)
const staff = await addAccount(hr, { account_type: 'STAFF', office_id: umbrella.id, first_name: 'Sol', last_name: 'Staff', email: `st.${stamp}@test.local` })
check(staff.status === 201, 'staff added to the umbrella', staff.status)
r = await hr.call('GET', '/offices/umbrellas')
check(r.body.data.find((u: any) => u.id === umbrella.id)?.heads.length === 2, 'the umbrella lists both heads')

const d1 = await a1.login!()
const d2 = await a2.login!()
const d3 = await a3.login!()
const st = await staff.login!()
check(d1.user.delegated && JSON.stringify(d1.user.permissions) === JSON.stringify(['RECEIVE_DOCUMENTS', 'PASS_DOCUMENTS']), 'the delegate signs in with exactly its permissions', d1.user.permissions)

console.log('\nDelegates denied management by default (direct API calls)')
r = await d1.call('POST', '/offices/umbrellas', { name: 'Nope', code: `${hrOffice.code}-NOPE${stamp}` })
check(r.status === 403, 'delegate cannot add umbrella offices', r.status)
r = await d1.call('POST', '/users', { account_type: 'DEPARTMENT_HEAD', office_id: umbrella.id, first_name: 'X', last_name: 'Y', email: `dhy.${stamp}@test.local` })
check(r.status === 400 || r.status === 403, 'delegate cannot assign Department Heads', r.status)
r = await d1.call('POST', '/users', { account_type: 'STAFF', office_id: umbrella.id, first_name: 'X', last_name: 'Y', email: `sty.${stamp}@test.local` })
check(r.status === 400 || r.status === 403, 'delegate without "Manage staff" cannot add staff', r.status)
r = await d1.call('PATCH', `/users/${d1.user.id}`, { permissions: [...['RECEIVE_DOCUMENTS', 'PASS_DOCUMENTS', 'DECIDE_APPROVALS']] })
check(r.status === 403 || r.status === 404, 'delegate cannot change its own permissions', r.status)
r = await d1.call('PATCH', `/offices/umbrellas/${umbrella.id}`, { name: 'Renamed' })
check(r.status === 403, 'delegate cannot edit the umbrella office', r.status)

console.log('\nA delegate with "Assign Department Heads"')
const a4 = await addAccount(d3, { account_type: 'DEPARTMENT_HEAD', office_id: umbrella.id, first_name: 'Dan', last_name: 'Sub', email: `dh4.${stamp}@test.local`, permissions: ['RECEIVE_DOCUMENTS'] })
check(a4.status === 201 && a4.body.user.assigned_by === d3.user.id, 'assigns a head with a permission it holds', a4.body?.user ?? a4.status)
r = await d3.call('POST', '/users', { account_type: 'DEPARTMENT_HEAD', office_id: umbrella.id, first_name: 'E', last_name: 'F', email: `dh5.${stamp}@test.local`, permissions: ['DECIDE_APPROVALS'] })
check(r.status === 403, 'cannot grant a permission it does not hold', r.status)
r = await d3.call('PATCH', `/users/${d1.user.id}`, { permissions: [] })
check(r.status === 404, "cannot change a delegate it didn't assign", r.status)
r = await d3.call('PATCH', `/users/${hr.user.id}`, { status: 'SUSPENDED' })
check(r.status === 404, 'cannot touch the managing head', r.status)
r = await d3.call('POST', '/offices/umbrellas', { name: 'Nope', code: `${hrOffice.code}-NOPE2${stamp}` })
check(r.status === 403, 'still cannot add umbrellas (not granted)', r.status)

console.log('\nGrant, revoke and history')
r = await hr.call('PATCH', `/users/${a2.body.user.id}`, { permissions: ['RECEIVE_DOCUMENTS'] })
check(r.status === 200 && r.body.user.permissions.join() === 'RECEIVE_DOCUMENTS', 'managing head grants a permission', r.body?.user?.permissions ?? r.status)
r = await hr.call('PATCH', `/users/${a2.body.user.id}`, { permissions: [] })
check(r.status === 200 && r.body.user.permissions.length === 0, 'and revokes it', r.body?.user?.permissions ?? r.status)
r = await hr.call('PATCH', `/users/${a2.body.user.id}`, { status: 'SUSPENDED' })
r = await hr.call('PATCH', `/users/${a2.body.user.id}`, { status: 'ACTIVE' })
r = await hr.call('GET', `/users/${a2.body.user.id}/assignments`)
const actions = (r.body?.data ?? []).map((h: any) => h.action).reverse()
check(JSON.stringify(actions) === JSON.stringify(['ASSIGNED', 'UPDATED', 'UPDATED', 'REVOKED', 'REINSTATED']) && r.body.data.every((h: any) => h.changed_by?.id === hr.user.id), 'history: assigned, two changes, revoked, reinstated — each by whom', actions)
r = await records.call('GET', `/users/${a2.body.user.id}/assignments`)
check(r.status === 404, "another office's head can't read that history", r.status)
const d2b = await login(`dh2.${stamp}@test.local`, a2.body.temporary_password).catch(() => null)
check(d2b && d2b.user.permissions.length === 0, 'the revoked delegate has no permissions on its next sign-in')
r = await d2.call('GET', '/auth/me')
check(r.status === 401, 'suspending the delegate ended its open sessions', r.status)
// Signed in again after being reinstated.
const d2now = d2b ?? d2

console.log('\nUmbrella offices are units of their office, not route steps')
r = await admin.call('GET', '/offices')
const recordsOffice = r.body.data.find((o: any) => o.id === records.user.office.id)
r = await admin.call('POST', '/routes', { name: `Umbrella step ${stamp}`, steps: [{ office_id: umbrella.id, action_label: 'Unit review' }, { office_id: recordsOffice.id, action_label: 'Log' }] })
check(r.status === 400 && /umbrella/i.test(r.body?.message), 'a new route cannot use an umbrella office as a step', `${r.status} ${r.body?.message}`)
{
  // A route built before umbrellas became units keeps its umbrella step when edited, but gains no new one.
  const all = (await admin.call('GET', '/routes')).body?.data ?? []
  const legacy = all.find((rt: any) => rt.steps?.some((s: any) => s.office?.parent_office_id || s.office?.parent?.id))
  if (legacy) {
    const steps = legacy.steps.map((s: any) => ({ office_id: s.office_id, action_label: `${s.action_label}` }))
    r = await admin.call('PATCH', `/routes/${legacy.id}`, { steps })
    check(r.status === 200, 'an existing route keeps its umbrella step when edited', `${r.status} ${r.body?.message}`)
    const i = steps.findIndex((s: any) => !legacy.steps.find((x: any) => x.office_id === s.office_id)?.office?.parent_office_id)
    if (i >= 0 && steps[i - 1]?.office_id !== umbrella.id && steps[i + 1]?.office_id !== umbrella.id) {
      r = await admin.call('PATCH', `/routes/${legacy.id}`, { steps: steps.map((s: any, k: number) => (k === i ? { ...s, office_id: umbrella.id } : s)) })
      check(r.status === 400, 'but cannot gain another umbrella step', `${r.status} ${r.body?.message}`)
    }
  } else console.log('  (no legacy route with an umbrella step in this database; skipped)')
}
r = await admin.call('POST', '/routes', { name: `Delegation route ${stamp}`, steps: [{ office_id: hrOffice.id, action_label: 'Review' }, { office_id: recordsOffice.id, action_label: 'Log' }] })
const routeId = r.body.route?.id
check(r.status === 201, 'route through the main office', r.status)
const hrStaff = await addAccount(hr, { account_type: 'STAFF', office_id: hrOffice.id, first_name: 'Hal', last_name: 'Main', email: `hs.${stamp}@test.local` })
const hs = await hrStaff.login!()
const fd = new FormData()
fd.append('title', `Delegation test ${stamp}`)
fd.append('route_id', routeId)
fd.append('submit', 'true')
fd.append('file', new Blob([Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64')], { type: 'image/png' }), 'page.png')
r = await hs.call('POST', '/documents', fd)
const doc = r.body?.document
check(r.status === 201 && doc?.status === 'START', 'staff of the main office uploads and submits; it starts there, received by them', `${r.status} ${doc?.status} ${r.body?.message ?? ''}`)
r = await hs.call('GET', `/documents/${doc.id}`)
check(r.body?.permissions?.canHandToUmbrella === true && r.body?.umbrella_options?.some((o: any) => o.id === umbrella.id), 'the receiver is offered the hand-off, with the umbrella as a choice', r.body?.permissions)

const handOff = (by: { call: Call }, umbrellaId = umbrella.id) => by.call('POST', `/documents/${doc.id}/umbrella-handoff`, { umbrella_id: umbrellaId, remarks: 'For payroll check' })
r = await handOff(d2now)
check(r.status === 403 && /Hand to umbrella offices/.test(r.body?.message), 'no "Hand to umbrella offices" permission → refused', `${r.status} ${r.body?.message}`)
r = await handOff(records)
check(r.status === 403, "another office's head can't hand it off", r.status)
r = await handOff(hr)
check(r.status === 403 && /received/.test(r.body?.message), 'only the person who received it hands it off (not even the managing head)', `${r.status} ${r.body?.message}`)
r = await handOff(hs, recordsOffice.id)
check(r.status === 400, 'only to an umbrella office of this office', `${r.status} ${r.body?.message}`)
r = await handOff(hs)
check(r.status === 200, 'the receiver hands it to the umbrella office', `${r.status} ${r.body?.message}`)
r = await hs.call('GET', `/documents/${doc.id}`)
check(r.body?.document?.current_office_id === umbrella.id && r.body?.document?.current_step_number === 1 && r.body?.unit_parent?.id === hrOffice.id, 'it is now at the umbrella office, on the same route step', r.body?.document)
r = await handOff(hs)
check(r.status === 403 || r.status === 409, 'and cannot be handed off twice', r.status)

console.log('\nDocument actions at the umbrella office')
r = await d2now.call('POST', '/qr/scan', { payload: doc.qr_code, action: 'RECEIVE' })
check(r.status === 403 && /Receive documents/.test(r.body?.message), 'no "Receive" permission → scan refused at the unit', `${r.status} ${r.body?.message}`)
r = await st.call('POST', '/qr/scan', { payload: doc.qr_code, action: 'RECEIVE' })
check(r.status === 200, 'staff of the umbrella scans it in', `${r.status} ${r.body?.message}`)
r = await d2now.call('POST', `/documents/${doc.id}/pass-staff`, {})
check(r.status === 403 && /permission/.test(r.body?.message), 'no "Pass" permission → refused', `${r.status} ${r.body?.message}`)
r = await st.call('POST', `/documents/${doc.id}/pass-staff`, {})
check(r.status === 200 || r.status === 201, 'staff passes it to the next desk', `${r.status} ${r.body?.message}`)
r = await d2now.call('POST', '/qr/scan', { payload: doc.qr_code, action: 'RECEIVE' })
check(r.status === 403 && /Receive documents/.test(r.body?.message), 'no "Receive" permission → scan refused', `${r.status} ${r.body?.message}`)
r = await d1.call('POST', '/qr/verify', { payload: doc.qr_code })
check(r.body?.action === 'RECEIVE', 'with "Receive": the scanner offers to receive it', r.body)
r = await d1.call('POST', '/qr/scan', { payload: doc.qr_code, action: 'RECEIVE' })
check(r.status === 200, 'with "Receive": received', `${r.status} ${r.body?.message}`)
r = await d1.call('GET', `/documents/${doc.id}`)
const perms = r.body?.permissions ?? {}
check(perms.canPassToStaff === true && perms.canRequestPickup === false && perms.canSendBack === false && perms.canReturnFromUmbrella === false, 'buttons: pass yes; release, send back and return no', perms)
r = await d1.call('POST', `/documents/${doc.id}/pickup-request`, { liaison_user_id: hr.user.id })
check(r.status === 403 && /Release to a messenger/.test(r.body?.message), 'no "Release" → refused even by direct API call', `${r.status} ${r.body?.message}`)
r = await d1.call('POST', `/documents/${doc.id}/send-back`, { liaison_user_id: 'x', issue_id: 'y' })
check(r.status === 403, 'no "Send back" → refused', r.status)
r = await d1.call('POST', `/documents/${doc.id}/umbrella-return`, {})
check(r.status === 403 && /Hand to umbrella offices/.test(r.body?.message), 'no "Hand to umbrella offices" → cannot return it either', `${r.status} ${r.body?.message}`)
r = await d3.call('POST', '/qr/scan', { payload: doc.qr_code, action: 'RECEIVE' })
check(r.status === 403, 'a delegate of the main office (with Receive) cannot receive it while at the umbrella', `${r.status} ${r.body?.message}`)
r = await d1.call('POST', `/documents/${doc.id}/pass-staff`, {})
check(r.status === 200 || r.status === 201, 'with "Pass": passes it on', `${r.status} ${r.body?.message}`)
r = await st.call('POST', '/qr/scan', { payload: doc.qr_code, action: 'RECEIVE' })
check(r.status === 200, 'umbrella staff takes it back in', `${r.status} ${r.body?.message}`)
r = await st.call('GET', `/documents/${doc.id}`)
check(r.body?.permissions?.canReturnFromUmbrella === true && r.body?.permissions?.canRequestPickup === false && r.body?.permissions?.canSendBack === false, 'at the unit: return yes; release and send back no', r.body?.permissions)
r = await st.call('POST', `/documents/${doc.id}/pickup-request`, { liaison_user_id: hr.user.id })
check(r.status === 409 && /umbrella office/.test(r.body?.message), 'the unit cannot release it to a messenger (server-enforced)', `${r.status} ${r.body?.message}`)
r = await records.call('POST', `/documents/${doc.id}/pass-staff`, {})
check(r.status === 403 || r.status === 409, "another office's head can't act on it", r.status)
r = await st.call('POST', `/documents/${doc.id}/umbrella-return`, { remarks: 'Checked' })
check(r.status === 200, 'the unit returns it to its office', `${r.status} ${r.body?.message}`)
r = await hs.call('POST', '/qr/scan', { payload: doc.qr_code, action: 'RECEIVE' })
check(r.status === 200, 'the main office scans it in again', `${r.status} ${r.body?.message}`)
r = await hs.call('GET', `/documents/${doc.id}`)
check(r.body?.permissions?.canRequestPickup === true && r.body?.permissions?.canReturnFromUmbrella === false, 'back at the office: it can be released onward', r.body?.permissions)
const events = (r.body?.tracking ?? []).map((e: any) => e.event_type)
check(events.includes('HANDED_TO_UMBRELLA') && events.includes('RETURNED_FROM_UMBRELLA') && r.body?.document?.current_step_number === 1, 'the hand-off and return are in the history; still on the same route step', events)

console.log('\nNo crossing offices or organizations')
const reg = await fetch(`${BASE}/api/auth/register`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ organization_name: `Other Org ${stamp}`, first_name: 'O', last_name: 'Admin', email: `other.${stamp}@test.local`, password: 'Other@12345' }) })
const other = reg.ok ? await login(`other.${stamp}@test.local`, 'Other@12345') : null
check(Boolean(other), 'another organization registered')
if (other) {
  r = await other.call('GET', `/documents/${doc.id}`)
  check(r.status === 404, "another organization's admin can't see the document", r.status)
  r = await other.call('PATCH', `/users/${d1.user.id}`, { permissions: [] })
  check(r.status === 404, "another organization's admin can't change the delegate", r.status)
  r = await other.call('POST', `/documents/${doc.id}/umbrella-handoff`, { umbrella_id: umbrella.id })
  check(r.status === 403 || r.status === 404, "another organization can't hand the document off", r.status)
}

console.log('\nLeast privilege down the chain')
r = await hr.call('PATCH', `/users/${d3.user.id}`, { permissions: ['ASSIGN_HEADS', 'MANAGE_TEAM'] })
check(r.status === 200 && r.body?.delegates_updated === 1, 'removing a permission from a grantor also removes it from the delegate it assigned', r.body?.delegates_updated ?? r.status)
r = await hr.call('GET', `/users/${a4.body.user.id}/assignments`)
const latest = r.body?.data?.[0]
check(latest?.action === 'UPDATED' && latest.permissions?.length === 0 && /Receive documents/.test(latest?.note ?? ''), 'recorded in the delegate’s history, with why', latest)
r = await hr.call('PATCH', `/users/${a1.body.user.id}`, { permissions: ['RECEIVE_DOCUMENTS', 'PASS_DOCUMENTS'] })
check(r.status === 200 && !r.body?.delegates_updated, 'an unchanged delegate (no delegates of its own) cascades nothing', r.body?.delegates_updated)

console.log('\nExisting behaviour unchanged')
r = await admin.call('GET', '/documents?limit=50')
const seeded = (r.body?.data ?? []).filter((d: any) => d.qr_code && !d.title.includes(stamp))
r = seeded[0] ? await records.call('POST', '/qr/verify', { payload: seeded[0].qr_code }) : { status: 0, body: null }
check(r.status === 200, 'an existing QR code still scans', `${seeded[0]?.qr_code} ${r.status}`)
r = await records.call('GET', '/users?managed=1')
check(r.status === 200, "a managing head's team list still works", r.status)
r = await admin.call('GET', '/users')
check(r.body?.data?.some((u: any) => u.id === d1.user.id && u.delegated), 'the admin sees delegates in the full roster')

console.log(`\n${passed} passed, ${failed} failed`)
process.exit(failed ? 1 : 0)
