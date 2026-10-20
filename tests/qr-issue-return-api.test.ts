/**
 * QR access, label printing, issue reporting and return pickups, end to end against a running app:
 *   1/2. who may see and print a document's QR (creator, holder once received, internal-route units,
 *        sibling units, parent office, destination before and after receipt, messengers, other offices);
 *   3.   issue priority from the category; "Other" needs a description;
 *   4.   a flagged document goes back one office and that office's liaisons claim the pickup;
 *   5.   the routing slip's table data.
 *
 *   npm run dev                               (another terminal; LOCAL database with the demo seed, migrated)
 *   npm run test:qr-issue-return-api          (or: node tests/qr-issue-return-api.test.ts --base=http://localhost:3000)
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
const denied = (r: Res) => r.status === 403 || r.status === 404
const admin = await login('client@bago.gov.ph')
const hr = await login('hr@bago.gov.ph')
const records = await login('records@bago.gov.ph')
const hrOffice = hr.user.office
const recordsOffice = records.user.office

async function account(by: Session, body: Record<string, unknown>) {
  const r = await by.call('POST', '/users', { first_name: 'Q', ...body })
  if (r.status !== 201) throw new Error(`could not create ${body.email}: ${why(r)}`)
  return { id: r.body.user.id as string, session: await login(body.email as string, r.body.temporary_password) }
}
async function umbrella(name: string, suffix: string) {
  const r = await hr.call('POST', '/offices/umbrellas', { name: `${name} ${stamp}`, code: `${hrOffice.code}-${suffix}${stamp}` })
  if (r.status !== 201) throw new Error(`could not add umbrella ${name}: ${why(r)}`)
  return r.body.office
}
async function upload(by: Session, title: string, routeId: string) {
  const fd = new FormData()
  fd.append('title', `${title} ${stamp}`)
  fd.append('route_id', routeId)
  fd.append('submit', 'true')
  fd.append('file', new Blob([Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64')], { type: 'image/png' }), 'page.png')
  const r = await by.call('POST', '/documents', fd)
  if (r.status !== 201) throw new Error(`upload failed: ${why(r)}`)
  return r.body.document
}
const scan = (s: Session, payload: string, action?: string) => s.call('POST', '/qr/scan', { payload, ...(action && { action }) })
const qrOf = (s: Session, id: string) => s.call('GET', `/qr/${id}`)
const notes = async (s: Session, docId: string, type: string) => ((await s.call('GET', '/notifications?limit=200')).body?.data ?? []).filter((n: any) => n.document_id === docId && n.type === type)

// ── Setup ─────────────────────────────────────────────────────────────────────
const U1 = await umbrella('Qr Unit One', 'Q1')
const U2 = await umbrella('Qr Unit Two', 'Q2')
const hs = await account(hr, { account_type: 'STAFF', office_id: hrOffice.id, last_name: 'Creator', email: `q.hs.${stamp}@test.local` })
const hsB = await account(hr, { account_type: 'STAFF', office_id: hrOffice.id, last_name: 'Colleague', email: `q.hsb.${stamp}@test.local` })
const u1s = await account(hr, { account_type: 'STAFF', office_id: U1.id, last_name: 'UnitOne', email: `q.u1.${stamp}@test.local` })
const u2s = await account(hr, { account_type: 'STAFF', office_id: U2.id, last_name: 'UnitTwo', email: `q.u2.${stamp}@test.local` })
const u2h = await account(hr, { account_type: 'DEPARTMENT_HEAD', office_id: U2.id, last_name: 'UnitTwoHead', email: `q.u2h.${stamp}@test.local` })
const rs = await account(records, { account_type: 'STAFF', office_id: recordsOffice.id, last_name: 'Records', email: `q.rs.${stamp}@test.local` })
const hm = await account(hr, { account_type: 'LIAISON', office_id: hrOffice.id, last_name: 'HrMessenger', email: `q.hm.${stamp}@test.local` })
const hmU1 = await account(hr, { account_type: 'LIAISON', office_id: U1.id, last_name: 'UnitMessenger', email: `q.hmu.${stamp}@test.local` })
const hmOff = await account(hr, { account_type: 'LIAISON', office_id: hrOffice.id, last_name: 'OffDuty', email: `q.hmoff.${stamp}@test.local` })
const rm = await account(records, { account_type: 'LIAISON', office_id: recordsOffice.id, last_name: 'RecMessenger', email: `q.rm.${stamp}@test.local` })
const offices = (await admin.call('GET', '/offices')).body.data as any[]
const third = offices.find((o) => o.id !== hrOffice.id && o.id !== recordsOffice.id && !o.parent_office_id && o.is_active)
const om = await account(admin, { account_type: 'LIAISON', office_id: third.id, last_name: 'Outsider', email: `q.om.${stamp}@test.local` })
for (const m of [hm, hmU1, hmOff, rm, om]) await m.session.call('PATCH', '/liaisons/me', { availability: 'AVAILABLE' })
await hmOff.session.call('PATCH', '/liaisons/me', { availability: 'OFF_DUTY' })
const route = (await admin.call('POST', '/routes', { name: `Qr route ${stamp}`, steps: [{ office_id: hrOffice.id, action_label: 'Review' }, { office_id: recordsOffice.id, action_label: 'File' }] })).body.route
const ir = (await hr.call('POST', '/internal-routes', { name: `Qr internal ${stamp}`, steps: [{ office_id: U1.id }, { office_id: U2.id }] })).body.route

// ════════════════════════════════════════════════════════════════════════════════════
console.log('\n1/2. QR access and printing')
const doc = await upload(hs.session, 'Qr doc', route.id)
const CODE = doc.qr_code as string
check(Boolean(CODE), 'the creator gets its QR code on upload')
let r = await qrOf(hs.session, doc.id)
check(ok(r) && r.body.qr.payload === CODE && r.body.qr.svg, 'creator: QR endpoint gives the label (image and code)', why(r))
r = await qrOf(hsB.session, doc.id)
check(ok(r) && r.body.qr.payload === CODE, 'a colleague of the office holding it (received there): yes', why(r))
r = await qrOf(rs.session, doc.id)
check(denied(r), 'another office: no', why(r))

r = await hs.session.call('POST', `/documents/${doc.id}/internal-start`, { route_id: ir.id })
check(ok(r), 'setup: sent along an internal route to unit 1', why(r))
r = await qrOf(u1s.session, doc.id)
check(r.status === 403, 'unit 1 before scanning it in: no (403)', why(r))
let d = (await u1s.session.call('GET', `/documents/${doc.id}`)).body
check(d?.document && d.document.qr_code === null && d.active_qr === null && d.routing_slip === null, 'unit 1 document page before receipt: no code, no image, no slip', { qr: d?.document?.qr_code, img: Boolean(d?.active_qr) })
r = await u1s.session.call('POST', `/qr/generate/${doc.id}`)
check(r.status === 403, 'unit 1 cannot get a new label before receipt either', why(r))
r = await scan(u1s.session, CODE, 'RECEIVE')
check(ok(r) && r.body.document?.qr_code === CODE, 'unit 1 scans it in, and then gets its code', why(r))
r = await qrOf(u1s.session, doc.id)
check(ok(r) && r.body.qr.payload === CODE, 'unit 1 after receipt: the label to print again — the same code', why(r))
for (const [who, s] of [['sibling unit 2 staff', u2s], ['sibling unit 2 head', u2h]] as const) {
  r = await qrOf(s.session, doc.id)
  check(denied(r), `${who}: no QR while unit 1 has it`, why(r))
  r = await s.session.call('GET', `/documents?scope=all&q=${encodeURIComponent(CODE)}`)
  check(!(r.body?.data ?? []).some((x: any) => x.id === doc.id && x.qr_code), `${who}: search by its code reveals nothing`)
}
r = await qrOf(hr, doc.id)
check(r.status === 403, 'the parent office’s head while a unit has it: no (403)', why(r))
d = (await hr.call('GET', `/documents/${doc.id}`)).body
check(d?.document?.qr_code === null && d.active_qr === null, 'parent office document page: no code, no image')
r = await hr.call('GET', `/documents?scope=all&limit=100&q=${encodeURIComponent(CODE)}`)
check(ok(r) && !r.body.data.some((x: any) => x.id === doc.id), 'parent office: searching its code finds nothing')
r = await hr.call('GET', `/documents?scope=all&limit=100&q=${encodeURIComponent(CODE.slice(0, -3))}`)
check(!(r.body?.data ?? []).some((x: any) => x.id === doc.id), 'parent office: nor does part of its code')
r = await hr.call('GET', `/documents?scope=all&limit=100&q=${encodeURIComponent(`Qr doc ${stamp}`)}`)
const listed = r.body?.data?.find((x: any) => x.id === doc.id)
check(listed && listed.qr_code === null && listed.qr_hidden === true && listed.tracking_number, 'parent office: listed by title with its tracking number, without its code', listed)
r = await hr.call('GET', '/activity?scope=office&days=1&limit=300')
check(ok(r) && !(r.body?.data ?? []).some((x: any) => x.document?.id === doc.id && x.document.qr_code), 'parent office activity log: no code', why(r))
r = await hr.call('POST', `/qr/generate/${doc.id}`)
check(r.status === 403, 'parent office cannot reissue the label', why(r))
r = await hs.session.call('GET', `/documents?scope=all&limit=100&q=${encodeURIComponent(CODE)}`)
check(r.body?.data?.some((x: any) => x.id === doc.id && x.qr_code === CODE), 'the creator still finds it by its code')
r = await admin.call('GET', `/qr/${doc.id}`)
check(ok(r), 'the admin: yes')

await u1s.session.call('POST', `/documents/${doc.id}/internal-advance`, {})
await scan(u2s.session, CODE, 'RECEIVE')
r = await qrOf(u1s.session, doc.id)
check(denied(r), 'unit 1 once it moved on: no', why(r))
r = await qrOf(u2s.session, doc.id)
check(ok(r), 'unit 2 after scanning it in: yes', why(r))
await u2s.session.call('POST', `/documents/${doc.id}/internal-advance`, {})
r = await qrOf(hsB.session, doc.id)
check(r.status === 403, 'back at the parent office, before it scans it in again: no', why(r))
r = await qrOf(hs.session, doc.id)
check(ok(r), 'its creator: yes', why(r))
await scan(hsB.session, CODE, 'RECEIVE')
r = await qrOf(hsB.session, doc.id)
check(ok(r), 'parent office after scanning it in again: yes', why(r))

r = await hsB.session.call('POST', `/documents/${doc.id}/pickup-request`, { liaison_user_id: hm.id })
check(ok(r), 'setup: released to the HR messenger', why(r))
r = await qrOf(hm.session, doc.id)
check(ok(r), 'the messenger it was released to: yes', why(r))
r = await qrOf(rm.session, doc.id)
check(denied(r), 'another messenger: no', why(r))
await scan(hm.session, CODE, 'PICKUP')
await hm.session.call('POST', `/documents/${doc.id}/transit`)
for (const [who, s] of [['destination head', records], ['destination staff', rs.session]] as const) {
  r = await qrOf(s, doc.id)
  check(denied(r), `${who} while it is on its way: no`, why(r))
}
d = (await records.call('GET', `/documents/${doc.id}`)).body
check(d?.document?.qr_code === null && d.active_qr === null && d.routing_slip === null, 'destination document page while on its way: no code, image, print or slip')
r = await records.call('POST', `/qr/generate/${doc.id}`)
check(denied(r), 'the destination cannot reissue it to get a code', why(r))
r = await qrOf(hr, doc.id)
check(ok(r), 'the sending office (its head) still: yes', why(r))
r = await scan(records, CODE, 'RECEIVE')
check(ok(r) && r.body.document?.qr_code === CODE, 'the destination scans the physical label: received, and gets its code', why(r))
r = await qrOf(records, doc.id)
check(ok(r) && r.body.qr.payload === CODE, 'destination after receipt: print again — the same code', why(r))
const slip = r.body?.routing_slip
d = (await records.call('GET', `/documents/${doc.id}`)).body
check(d?.active_qr?.payload === CODE && d.routing_slip, 'destination document page after receipt: label and slip')

console.log('\n5. Routing slip data')
check(slip?.subject === `Qr doc ${stamp}`, 'subject: its title', slip?.subject)
check(slip?.origin_office === hrOffice.name, 'origin office: the uploader’s office (not where it is now)', slip?.origin_office)
check(slip?.first_destination === hrOffice.name && slip?.final_destination === recordsOffice.name, 'first and final destination: the organization route (the internal route doesn’t change them)', slip)
check(slip?.registered_by === `Q Creator`, 'registered by: the uploader', slip?.registered_by)
check(slip?.registered_at === doc.created_at, 'registered at: the upload time (not a later move)', `${slip?.registered_at} vs ${doc.created_at}`)
check(slip?.priority === doc.priority, 'priority: as registered', slip?.priority)
check('document_type' in (slip ?? {}), 'document type field present (empty when none)', slip)

// ════════════════════════════════════════════════════════════════════════════════════
console.log('\n3. Issues: priority from the category')
r = await rs.session.call('POST', '/issues', { document_id: doc.id, title: 'Late', category: 'DELAY', severity: 'CRITICAL' })
check(r.status === 201 && r.body.issue.severity === 'MEDIUM', 'a priority from the browser is ignored (Delay → Medium)', r.body?.issue?.severity ?? why(r))
r = await rs.session.call('POST', '/issues', { document_id: doc.id, title: 'Torn', category: 'DAMAGE' })
check(r.status === 201 && r.body.issue.severity === 'HIGH', 'Damage → High', why(r))
r = await rs.session.call('POST', '/issues', { document_id: doc.id, title: 'Odd', category: 'OTHER' })
check(r.status === 400 && /Describe/.test(r.body?.message), '"Other" without a description is refused', why(r))
r = await rs.session.call('POST', '/issues', { document_id: doc.id, title: 'Odd', category: 'OTHER', description: '   ' })
check(r.status === 400, '"Other" with only spaces is refused', why(r))
r = await rs.session.call('POST', '/issues', { document_id: doc.id, title: 'Odd', category: 'URGENT' })
check(r.status === 400, 'an unknown category is refused', why(r))
r = await rs.session.call('POST', '/issues', { document_id: doc.id, title: 'Odd', category: 'OTHER', description: '  Page 2 is from another form  ' })
const otherIssue = r.body?.issue
check(r.status === 201 && otherIssue.description === 'Page 2 is from another form' && otherIssue.severity === 'MEDIUM', '"Other" with a description: saved (trimmed)', why(r))
r = await rs.session.call('PATCH', `/issues/${otherIssue.id}`, { severity: 'CRITICAL' })
check(r.status === 400, 'the priority can’t be changed afterwards', why(r))
r = await rs.session.call('PATCH', `/issues/${otherIssue.id}`, { status: 'RESOLVED', resolution: 'ok' })
check(ok(r) && r.body.issue.severity === 'MEDIUM', 'other updates still work, priority unchanged', why(r))

// ════════════════════════════════════════════════════════════════════════════════════
console.log('\n4. Return pickups: the liaisons of the office it goes back to')
r = await records.call('GET', `/documents/${doc.id}/return-liaisons`)
const ids = (r.body?.liaisons ?? []).map((l: any) => l.id)
check(ok(r) && r.body.office?.id === hrOffice.id, 'it would go back to HR (the previous office)', why(r))
check(ids.includes(hm.id) && ids.includes(hmU1.id) && ids.includes(hmOff.id) && !ids.includes(rm.id) && !ids.includes(om.id), 'eligible: HR’s liaisons and its units’ — not Records’ or another office’s', ids)
const rec = r.body.liaisons.find((l: any) => l.recommended)
check(rec && rec.uploader_unit && rec.available && !rec.busy && r.body.liaisons[0].uploader_unit, 'recommended: a free liaison of the uploader’s own office (listed first)', r.body.liaisons)
check(!r.body.liaisons.find((l: any) => l.id === hmOff.id)?.recommended, 'an off-duty liaison is never recommended')
r = await records.call('POST', `/documents/${doc.id}/send-back`, { title: 'Missing signature', category: 'MISSING_DOCUMENT', liaison_user_id: rm.id })
check(r.status === 400, 'the flagging office can’t pick a messenger', why(r))
r = await records.call('POST', `/documents/${doc.id}/send-back`, { title: 'Missing signature', category: 'OTHER' })
check(r.status === 400, 'flag & send back with "Other" needs a description too', why(r))
r = await records.call('POST', `/documents/${doc.id}/send-back`, { title: 'Missing signature', category: 'MISSING_DOCUMENT', severity: 'LOW' })
const issueId = r.body?.issue?.id
check(ok(r) && r.body.issue.severity === 'HIGH' && r.body.issue.status === 'IN_PROGRESS', 'flagged and sent back; priority from the category', why(r))
check(r.body?.document?.return_pickup_open === true && r.body.document.sent_back?.office_id === hrOffice.id && !r.body.document.assigned_liaison_id, 'open return pickup to HR, nobody assigned', r.body?.document)
r = await records.call('POST', `/documents/${doc.id}/send-back`, { issue_id: issueId })
check(r.status === 409, 'sending it back again (a retry) is refused', why(r))
const count = async (s: Session) => (await notes(s, doc.id, 'RETURN_PICKUP_AVAILABLE')).length
check((await count(hm.session)) === 1 && (await count(hmU1.session)) === 1, 'HR’s and its unit’s liaisons on duty: notified once', [await count(hm.session), await count(hmU1.session)])
check((await count(hmOff.session)) === 0 && (await count(rm.session)) === 0 && (await count(om.session)) === 0, 'off duty, Records’ and another office’s liaisons: not notified')
const note = (await notes(hm.session, doc.id, 'RETURN_PICKUP_AVAILABLE'))[0]
check(!JSON.stringify(note).includes(CODE), 'the notification carries no QR code')
r = await records.call('POST', `/documents/${doc.id}/pickup-request`, { liaison_user_id: rm.id })
check(r.status === 409, 'it can’t be released forward meanwhile', why(r))
let me = (await hm.session.call('GET', '/liaisons/me')).body
check(me?.returns?.some((x: any) => x.id === doc.id && x.qr_code === null), 'it is in HR liaisons’ "returns to pick up", without its code')
me = (await rm.session.call('GET', '/liaisons/me')).body
check(!me?.returns?.some((x: any) => x.id === doc.id), 'not in Records’ liaisons’ list')
r = await qrOf(hm.session, doc.id)
check(denied(r), 'an eligible liaison gets no QR before claiming', why(r))

r = await records.call('DELETE', `/documents/${doc.id}/pickup-request`)
d = (await records.call('GET', `/documents/${doc.id}`)).body
check(ok(r) && !d.document.sent_back && !d.document.return_pickup_open, 'the flagging office can cancel the send-back before anyone claims it', why(r))
r = await records.call('POST', `/documents/${doc.id}/send-back`, { issue_id: issueId })
check(ok(r), 'and send it back again with the same issue', why(r))
check((await count(hm.session)) === 2 && (await count(hmU1.session)) === 2, 'a new return event: notified again (once more)', [await count(hm.session), await count(hmU1.session)])

r = await om.session.call('POST', `/documents/${doc.id}/return-claim`)
check(r.status === 403 || r.status === 404, 'a liaison of another office can’t claim it, even knowing its id', why(r))
r = await rm.session.call('POST', `/documents/${doc.id}/return-claim`)
check(r.status === 403 || r.status === 404, 'nor a liaison of the flagging office', why(r))
r = await hmOff.session.call('POST', `/documents/${doc.id}/return-claim`)
check(r.status === 409, 'an off-duty liaison of HR can’t claim it', why(r))
r = await records.call('POST', `/documents/${doc.id}/return-claim`)
check(r.status === 403, 'office staff can’t claim it', why(r))
const [c1, c2] = await Promise.all([hm.session.call('POST', `/documents/${doc.id}/return-claim`), hmU1.session.call('POST', `/documents/${doc.id}/return-claim`)])
const winner = ok(c1) ? hm : hmU1
const loser = ok(c1) ? hmU1 : hm
check([c1, c2].filter(ok).length === 1 && [c1, c2].some((x) => x.status === 409), 'two liaisons claim at the same moment: exactly one wins', [why(c1), why(c2)])
d = (await records.call('GET', `/documents/${doc.id}`)).body
check(d.document.assigned_liaison_id === winner.id && !d.document.return_pickup_open && d.document.sent_back?.office_id === hrOffice.id, 'the winner is assigned; still going back to HR', d.document)
r = await qrOf(winner.session, doc.id)
check(ok(r), 'the liaison who claimed it now gets the label', why(r))
r = await loser.session.call('POST', `/documents/${doc.id}/return-claim`)
check(r.status === 409, 'claiming an already claimed pickup: conflict', why(r))
r = await loser.session.call('DELETE', `/documents/${doc.id}/return-claim`)
check(r.status === 409, 'only the one who claimed it can give it up', why(r))
const loserBefore = await count(loser.session)
r = await winner.session.call('DELETE', `/documents/${doc.id}/return-claim`)
check(ok(r) && r.body.document?.return_pickup_open === true, 'the winner gives it up: open again', why(r))
check((await count(loser.session)) === loserBefore + 1, 'the others are told it is available again')
r = await loser.session.call('POST', `/documents/${doc.id}/return-claim`)
check(ok(r), 'another eligible liaison claims it', why(r))
r = await scan(loser.session, CODE, 'PICKUP')
check(ok(r), 'and picks it up', why(r))
await loser.session.call('POST', `/documents/${doc.id}/transit`)
r = await scan(hs.session, CODE, 'RECEIVE')
d = (await hs.session.call('GET', `/documents/${doc.id}`)).body
check(ok(r) && d.document.current_office_id === hrOffice.id && d.document.current_step_number === 1 && !d.document.sent_back, 'HR receives it back: at step 1, the send-back closed', why(r))
check(d.document.qr_code === CODE, 'the QR identity never changed')
const audit = d.tracking.map((e: any) => e.event_type)
check(audit.includes('SENT_BACK') && audit.includes('RETURN_CLAIMED') && audit.includes('RETURN_UNCLAIMED'), 'history: sent back, claimed, given up', audit)

console.log(`\n${passed} passed, ${failed} failed`)
process.exit(failed ? 1 : 0)
