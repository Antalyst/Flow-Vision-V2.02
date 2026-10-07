/**
 * FlowVision end-to-end flow test: runs the real document workflow against the running app
 * and its database, and prints a green ✔ for every step that works and a red ✘ for every bug.
 *
 *   npm run dev                      (in another terminal: the app must be running)
 *   npm run test:flow                (asks for the CLIENT password)
 *   npm run test:flow -- --email=admin@example.com --password=***
 *
 * Options:
 *   --email=…  --password=…   CLIENT account that runs the test (or FV_CLIENT_EMAIL / FV_CLIENT_PASSWORD)
 *   --route="Payroll"         Document Route to follow (name or id; default: the first active route)
 *   --only=client,employee,staff   Which uploader roles to run (default: all three)
 *   --base=http://localhost:3000   Where the app runs (or FV_BASE_URL)
 *
 * For every uploader (CLIENT, then EMPLOYEE, then STAFF) it uploads 4 documents (single file, single
 * image, 2 files, 2 images), assigns a messenger to each, and walks each one through every office on
 * the route: messenger scans to pick up → office staff scan to receive → pass to the next staff →
 * next staff receives → release to one of THAT office's messengers … → the last office approves.
 * One document per uploader is flagged with an issue on the way and sent back to the previous
 * office with a messenger, received there, routed forward again, and its issue resolved.
 * Along the way it checks the rules (validation), who can see what (visibility), the routing cards
 * and timeline (transparency), and that every step is in the activity log under the right person
 * (accountability).
 *
 * It writes to the database it runs against: test accounts e2e.*@flowvision.test (reused on every
 * run; their passwords are reset each time) and documents titled "[E2E …]".
 */
import readline from 'node:readline/promises'

// ---------------------------------------------------------------------------
// Options
// ---------------------------------------------------------------------------

const argv: Record<string, string> = Object.fromEntries(
  process.argv.slice(2).map((a) => {
    const m = /^--([^=]+)(?:=(.*))?$/.exec(a)
    return m ? [m[1]!, m[2] ?? 'true'] : [a, 'true']
  }),
)
const BASE = (argv.base ?? process.env.FV_BASE_URL ?? 'http://localhost:3000').replace(/\/$/, '')
const ONLY = new Set((argv.only ?? 'client,employee,staff').toLowerCase().split(',').map((s) => s.trim()))
const RUN = new Date().toLocaleString('sv-SE').slice(0, 16)
const EMAIL_DOMAIN = 'flowvision.test'

// ---------------------------------------------------------------------------
// Output
// ---------------------------------------------------------------------------

const paint = (code: number) => (s: string) => `\x1b[${code}m${s}\x1b[0m`
const green = paint(32)
const red = paint(31)
const yellow = paint(33)
const cyan = paint(36)
const dim = paint(2)
const bold = paint(1)

const totals = { pass: 0, fail: 0, skip: 0 }
const failures: string[] = []
let context = ''

function pass(label: string, info = '') {
  totals.pass++
  console.log(`    ${green('✔')} ${label}${info ? dim(`  · ${info}`) : ''}`)
}
function fail(label: string, why: string) {
  totals.fail++
  failures.push(`${context ? `${context} › ` : ''}${label} — ${why}`)
  console.log(`    ${red('✘')} ${red(label)}  ${red(`→ ${why}`)}`)
}
function skip(label: string, why: string) {
  totals.skip++
  console.log(`    ${yellow('–')} ${label}  ${dim(why)}`)
}
function note(text: string) {
  console.log(`    ${dim(`ℹ ${text}`)}`)
}
function check(cond: unknown, label: string, why: string, info = '') {
  if (cond) pass(label, info)
  else fail(label, why)
  return Boolean(cond)
}
function section(title: string) {
  console.log(`\n${bold(cyan(`━━ ${title} ━━`))}`)
}
function sub(title: string) {
  console.log(`\n  ${bold(title)}`)
}

/** A required step failed: the rest of this document's flow can't run. */
class FlowStop extends Error {}
function must(cond: unknown, label: string, why: string, info = '') {
  if (!check(cond, label, why, info)) throw new FlowStop(label)
}

// ---------------------------------------------------------------------------
// HTTP
// ---------------------------------------------------------------------------

interface Session {
  id: string
  name: string
  email: string
  role: string
  officeId: string | null
  hasApprovalAuthority: boolean
  cookie: string
}
interface Res {
  status: number
  ok: boolean
  data: any
}

async function api(s: Session | null, method: string, path: string, body?: unknown): Promise<Res> {
  const headers: Record<string, string> = {}
  if (s?.cookie) headers.cookie = s.cookie
  let payload: BodyInit | undefined
  if (body instanceof FormData) payload = body
  else if (body !== undefined) {
    headers['content-type'] = 'application/json'
    payload = JSON.stringify(body)
  }
  const res = await fetch(`${BASE}/api${path}`, { method, headers, body: payload })
  for (const cookie of res.headers.getSetCookie()) {
    const m = /^fv_session=([^;]*)/.exec(cookie)
    if (m && s) s.cookie = `fv_session=${m[1]}`
  }
  const isJson = (res.headers.get('content-type') ?? '').includes('json')
  const data = isJson ? await res.json().catch(() => null) : await res.arrayBuffer()
  return { status: res.status, ok: res.ok, data }
}

const why = (r: Res, expected?: string) =>
  `${expected ? `expected ${expected}, got ` : ''}HTTP ${r.status}${r.data?.message ? ` "${r.data.message}"` : ''}`
/** A request that should be refused: 4xx with one of these statuses. */
const refused = (r: Res, ...statuses: number[]) => statuses.includes(r.status)
const codeOf = (r: Res) => r.data?.data?.code as string | undefined

async function login(email: string, password: string): Promise<Session> {
  const s: Session = { id: '', name: email, email, role: '', officeId: null, hasApprovalAuthority: false, cookie: '' }
  const r = await api(s, 'POST', '/auth/login', { email, password })
  if (!r.ok) throw new Error(`Login failed for ${email}: ${why(r)}`)
  const u = r.data.user
  Object.assign(s, {
    id: u.id,
    name: `${u.first_name} ${u.last_name}`.trim() || email,
    role: u.account_type,
    officeId: u.office?.id ?? null,
    hasApprovalAuthority: Boolean(u.has_approval_authority),
  })
  return s
}

// ---------------------------------------------------------------------------
// Test data
// ---------------------------------------------------------------------------

interface SampleFile {
  name: string
  type: string
  bytes: Uint8Array
}

const text = (s: string) => new TextEncoder().encode(s)
const b64 = (s: string) => new Uint8Array(Buffer.from(s, 'base64'))
const pdf = (label: string) =>
  text(
    `%PDF-1.4\n1 0 obj<</Type/Catalog/Pages 2 0 R>>endobj\n2 0 obj<</Type/Pages/Kids[3 0 R]/Count 1>>endobj\n` +
      `3 0 obj<</Type/Page/Parent 2 0 R/MediaBox[0 0 612 792]>>endobj\ntrailer<</Root 1 0 R>>\n%${label}\n%%EOF\n`,
  )
const PNG = b64('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==')
const JPG = b64(
  '/9j/4AAQSkZJRgABAQEASABIAAD/2wBDAP//////////////////////////////////////////////////////////////////////////////////////wgALCAABAAEBAREA/8QAFBABAAAAAAAAAAAAAAAAAAAAAP/aAAgBAQABPxA=',
)

const UPLOADS: Array<{ label: string; files: SampleFile[]; pages?: number }> = [
  { label: 'Single file', files: [{ name: 'e2e-letter.pdf', type: 'application/pdf', bytes: pdf('single') }] },
  { label: 'Single image', files: [{ name: 'e2e-photo.png', type: 'image/png', bytes: PNG }], pages: 1 },
  {
    label: 'Two files',
    files: [
      { name: 'e2e-request.pdf', type: 'application/pdf', bytes: pdf('first') },
      { name: 'e2e-attachment.pdf', type: 'application/pdf', bytes: pdf('second') },
    ],
  },
  {
    label: 'Two images',
    files: [
      { name: 'e2e-page1.png', type: 'image/png', bytes: PNG },
      { name: 'e2e-page2.jpg', type: 'image/jpeg', bytes: JPG },
    ],
    pages: 2,
  },
]
/** The upload that gets flagged with an issue and sent back on its way. */
const FLAGGED_UPLOAD = 2

function uploadForm(title: string, files: SampleFile[], routeId: string, pages?: number) {
  const fd = new FormData()
  fd.append('title', title)
  fd.append('description', 'Automated end-to-end flow test (tests/flow.test.ts).')
  fd.append('route_id', routeId)
  fd.append('submit', 'true')
  if (pages) fd.append('pages', String(pages))
  for (const f of files) fd.append('file', new Blob([f.bytes], { type: f.type }), f.name)
  return fd
}

// New format {OFFICE}{MMDDYY}{6 digits}, e.g. BCC100726123456.
const QR_RE = /^[A-Z0-9-]+\d{12}$/
const AT_OFFICE = ['START', 'ARRIVED_AT_OFFICE']

// ---------------------------------------------------------------------------
// State shared by the run
// ---------------------------------------------------------------------------

let client: Session
let route: any
const officeNames = new Map<string, string>()
const officeCodes = new Map<string, string>()
/** Two test STAFF desks per office on the route. */
const desks = new Map<string, Session[]>()
const sessions = new Map<string, Session>()
/** Each office's own test messengers. */
const messengerPools = new Map<string, Session[]>()
const createdDocs: string[] = []

const officeName = (id: string | null | undefined) => (id ? (officeNames.get(id) ?? 'office') : 'origin')
const remember = (s: Session) => (sessions.set(s.id, s), s)
const allMessengers = () => [...messengerPools.values()].flat()
const who = (p: any) => (p ? `${p.first_name} ${p.last_name}` : '?')

interface TestDoc {
  id: string
  qr: string
  label: string
  uploader: Session
  /** The messenger carrying it on the current hop (each office uses its own). */
  messenger: Session | null
  /** A messenger was assigned at the origin (the messenger now holds a job). */
  assignedAtOrigin?: boolean
  /** Flag an issue at this step and send it back to the previous office (once). */
  flagAtStep?: number
  issueId?: string
  issueReporter?: Session
  flagged?: boolean
  resolved?: boolean
}

/** Create a test account (or reuse it, with a fresh temporary password) and sign in as it. */
async function ensureAccount(spec: { email: string; first: string; last: string; type: string; officeId: string | null }) {
  const r = await api(client, 'POST', '/users', {
    email: spec.email,
    first_name: spec.first,
    last_name: spec.last,
    account_type: spec.type,
    office_id: spec.officeId,
  })
  let temp: string
  if (r.status === 201) temp = r.data.temporary_password
  else if (r.status === 409) {
    const found = await api(client, 'GET', `/users?q=${encodeURIComponent(spec.email)}`)
    const user = found.data?.data?.find((u: any) => u.email === spec.email)
    if (!user) throw new Error(`${spec.email} exists but was not found in this organization`)
    if (user.office_id !== spec.officeId || user.account_type !== spec.type || user.status !== 'ACTIVE') {
      const fix = await api(client, 'PATCH', `/users/${user.id}`, { account_type: spec.type, office_id: spec.officeId, status: 'ACTIVE' })
      if (!fix.ok) throw new Error(`Could not update ${spec.email}: ${why(fix)}`)
    }
    const reset = await api(client, 'POST', `/users/${user.id}/reset-password`)
    if (!reset.ok) throw new Error(`Could not reset ${spec.email}: ${why(reset)}`)
    temp = reset.data.temporary_password
  } else throw new Error(`Could not create ${spec.email}: ${why(r)}`)
  return remember(await login(spec.email, temp))
}

/**
 * `count` of an office's own messengers that are on duty and free right now (more test messengers
 * are created for that office when needed). `officeId` null = the organization origin of a CLIENT
 * upload, where any messenger may be used: the first office's messengers are taken.
 */
async function freeMessengers(officeId: string | null, count: number) {
  const office = officeId ?? route.steps[0].office_id
  const pool = messengerPools.get(office) ?? []
  messengerPools.set(office, pool)
  const free: Session[] = []
  for (let n = 1; free.length < count && n <= 12; n++) {
    let m = pool[n - 1]
    if (!m) {
      const code = officeCodes.get(office)!
      m = await ensureAccount({ email: `e2e.messenger${n}.${code}@${EMAIL_DOMAIN}`, first: 'E2E', last: `Messenger${n} ${code.toUpperCase()}`, type: 'LIAISON', officeId: office })
      pool[n - 1] = m
    }
    const me = await api(m, 'GET', '/liaisons/me')
    let availability = me.data?.profile?.availability
    if (availability === 'OFF_DUTY') {
      const on = await api(m, 'PATCH', '/liaisons/me', { availability: 'AVAILABLE' })
      availability = on.data?.profile?.availability
    }
    if (availability === 'AVAILABLE') free.push(m)
  }
  if (free.length < count) throw new Error(`Only ${free.length} free messengers at ${officeName(office)}, need ${count}`)
  return free
}

async function viewDoc(s: Session, id: string) {
  const r = await api(s, 'GET', `/documents/${id}`)
  if (!r.ok) throw new FlowStop(`Could not open the document as ${s.name}: ${why(r)}`)
  return r.data
}

const scan = (s: Session, qr: string, action?: 'PICKUP' | 'RECEIVE') => api(s, 'POST', '/qr/scan', { payload: qr, ...(action && { action }) })
const verify = (s: Session, qr: string) => api(s, 'POST', '/qr/verify', { payload: qr })

/** A test staff member of an office other than `officeId`. */
const outsiderOf = (officeId: string | null | undefined) => [...desks.entries()].find(([id]) => id !== officeId)?.[1][0]

// ---------------------------------------------------------------------------
// Workflow steps
// ---------------------------------------------------------------------------

/** Release the document to one of the office's own messengers (checking another office's can't be used). */
async function releaseToMessenger(doc: TestDoc, by: Session, officeId: string | null, where: string, strict: boolean) {
  const [m] = await freeMessengers(officeId, 1)
  if (strict && officeId) {
    const listed = await api(by, 'GET', `/liaisons?document_id=${doc.id}`)
    const foreign = (listed.data?.data ?? []).filter((l: any) => l.user?.office?.id !== officeId)
    check(listed.ok && !foreign.length, `Messenger list shows only ${where}'s own messengers`, listed.ok ? `also lists ${foreign.length} from other offices` : why(listed))
    const otherOffice = [...messengerPools.keys()].find((id) => id !== officeId) ?? [...desks.keys()].find((id) => id !== officeId)
    if (otherOffice) {
      const [foreignMessenger] = await freeMessengers(otherOffice, 1)
      const r = await api(by, 'POST', `/documents/${doc.id}/pickup-request`, { liaison_user_id: foreignMessenger!.id })
      check(
        refused(r, 409) && codeOf(r) === 'MESSENGER_OTHER_OFFICE',
        `A messenger of ${officeName(otherOffice)} can't be used for a document at ${where}`,
        why(r, '409 MESSENGER_OTHER_OFFICE'),
      )
    }
  }
  const r = await api(by, 'POST', `/documents/${doc.id}/pickup-request`, { liaison_user_id: m!.id, remarks: 'E2E: please deliver' })
  must(r.ok, `${by.name} assigns ${where}'s messenger ${m!.name}`, why(r))
  check(r.data.document?.assigned_liaison_id === m!.id, 'Document shows the assigned messenger', `assigned_liaison_id = ${r.data.document?.assigned_liaison_id}`)
  doc.messenger = m!
}

/** Messenger picks the document up where it is and carries it to `dest`, whose first desk receives it. */
async function carry(doc: TestDoc, dest: { office_id: string; step_number: number }, strict: boolean) {
  const m = doc.messenger!
  const destName = officeName(dest.office_id)
  const destDesks = desks.get(dest.office_id)!

  if (strict) {
    const early = await scan(destDesks[0]!, doc.qr, 'RECEIVE')
    check(refused(early, 403), `${destName} can't receive it before the messenger picks it up`, why(early, '403'))
    const idle = allMessengers().find((x) => x.id !== m.id)
    if (idle) {
      const wrong = await scan(idle, doc.qr, 'PICKUP')
      check(refused(wrong, 403), `Another messenger (${idle.name}) can't pick it up`, why(wrong, '403'))
    }
  }

  const preview = await verify(m, doc.qr)
  check(preview.data?.action === 'PICKUP', 'Messenger scan preview says PICKUP', `action = ${preview.data?.action ?? why(preview)}`)
  const picked = await scan(m, doc.qr, 'PICKUP')
  must(picked.ok && picked.data.document?.status === 'PICKED_UP', `Messenger ${m.name} scans the QR → picked up`, picked.ok ? `status = ${picked.data.document?.status}` : why(picked))
  const transit = await api(m, 'POST', `/documents/${doc.id}/transit`)
  must(transit.ok && transit.data.document?.status === 'IN_TRANSIT', `Messenger marks it in transit to ${destName}`, transit.ok ? `status = ${transit.data.document?.status}` : why(transit))

  if (strict) {
    const otherOffice = [...desks.keys()].find((id) => id !== dest.office_id)
    if (otherOffice) {
      const wrong = await scan(desks.get(otherOffice)![0]!, doc.qr, 'RECEIVE')
      check(refused(wrong, 403), `${officeName(otherOffice)} (not where it's going) can't receive it`, why(wrong, '403'))
    }
  }

  const receiver = destDesks[0]!
  const preview2 = await verify(receiver, doc.qr)
  check(preview2.data?.action === 'RECEIVE', `${destName} scan preview says RECEIVE`, `action = ${preview2.data?.action ?? why(preview2)}`)
  const received = await scan(receiver, doc.qr, 'RECEIVE')
  must(
    received.ok && received.data.document?.status === 'ARRIVED_AT_OFFICE' && received.data.document?.current_step_number === dest.step_number,
    `${receiver.name} at ${destName} scans the QR → received (step ${dest.step_number})`,
    received.ok ? `status = ${received.data.document?.status}, step = ${received.data.document?.current_step_number}` : why(received),
  )
  check(received.data.document?.received_by?.id === receiver.id, 'Receiver is recorded by name', `received_by = ${received.data.document?.received_by?.id}`)
  const free = await api(m, 'GET', '/liaisons/me')
  check(free.data?.profile?.availability === 'AVAILABLE', 'Messenger is free again after the delivery', `availability = ${free.data?.profile?.availability}`)
}

/** At an office: pass desk to desk, the next staff receives, then flag & send back, release onward, or decide. */
async function atOffice(doc: TestDoc, view: any, strict: boolean) {
  const d = view.document
  const steps = view.route.steps
  const step = steps.find((s: any) => s.step_number === d.current_step_number)
  const next = steps.find((s: any) => s.step_number === d.current_step_number + 1) ?? null
  const isFinal = Boolean(step?.is_final_checkpoint) || !next
  const here = officeName(d.current_office_id)
  const staffHere = [...(desks.get(d.current_office_id) ?? []), ...[...sessions.values()].filter((s) => s.officeId === d.current_office_id && s.role !== 'LIAISON')]
  const unique = [...new Map(staffHere.map((s) => [s.id, s])).values()]

  let a = d.received_by ? sessions.get(d.received_by.id) : undefined
  if (!a) {
    a = unique[0]!
    const r = await scan(a, doc.qr, 'RECEIVE')
    must(r.ok, `${a.name} at ${here} scans the QR → received`, why(r))
  }
  const b = unique.find((s) => s.id !== a!.id)
  sub(`${here} · step ${d.current_step_number}${isFinal ? ' · last office' : ''}  ${dim(`(received by ${a.name})`)}`)
  must(b, 'A second staff member is available at this office', 'no other test staff at this office')

  if (strict && next) {
    const [m] = await freeMessengers(d.current_office_id, 1)
    const notReceiver = await api(b!, 'POST', `/documents/${doc.id}/pickup-request`, { liaison_user_id: m!.id })
    check(refused(notReceiver, 403), `${b!.name} can't release it (only ${a.name}, who received it, can)`, why(notReceiver, '403'))
  }

  const passed = await api(a, 'POST', `/documents/${doc.id}/pass-staff`, { remarks: 'E2E: passing to the next desk' })
  must(passed.ok, `${a.name} passes it to the next staff`, why(passed))
  const afterPass = await viewDoc(client, doc.id)
  const card = afterPass.routing.at(-1)
  check(card?.pending_pass?.by?.id === a.id, 'Routing card shows it waiting for the next staff', `pending_pass = ${JSON.stringify(card?.pending_pass)}`)
  check(!afterPass.document.assigned_liaison_id, 'No messenger is assigned while it waits for the next staff', `assigned_liaison_id = ${afterPass.document.assigned_liaison_id}`)

  if (strict) {
    if (next) {
      const [m] = await freeMessengers(d.current_office_id, 1)
      const blocked = await api(a, 'POST', `/documents/${doc.id}/pickup-request`, { liaison_user_id: m!.id })
      check(refused(blocked, 409), "A messenger can't be assigned until the next staff receives it", why(blocked, '409'))
    }
    const own = await verify(a, doc.qr)
    check(own.ok && !own.data?.action, `${a.name} (who passed it) can't scan it back in`, `action = ${own.data?.action ?? why(own)}`)
  }

  const preview = await verify(b!, doc.qr)
  check(preview.data?.action === 'RECEIVE', 'Next staff scan preview says RECEIVE', `action = ${preview.data?.action ?? why(preview)}`)
  const got = await scan(b!, doc.qr, 'RECEIVE')
  must(got.ok && got.data.document?.received_by?.id === b!.id, `${b!.name} (next staff) scans the QR → received`, got.ok ? `received_by = ${got.data.document?.received_by?.id}` : why(got))
  const afterReceive = await viewDoc(client, doc.id)
  const deskList = afterReceive.routing.at(-1)?.desks ?? []
  check(
    deskList.at(-1)?.staff?.id === b!.id && deskList.at(-2)?.staff?.id === a.id && deskList.at(-2)?.passed_at,
    'Routing card lists both desks in order',
    `desks = ${deskList.map((x: any) => who(x.staff)).join(' → ')}`,
    `${a.name} → ${b!.name}`,
  )

  // The office that flagged it gets it back fixed: the person who flagged the issue resolves it.
  if (doc.flagged && !doc.resolved && doc.issueReporter?.officeId === d.current_office_id) await resolveIssue(doc)

  if (!doc.flagged && doc.flagAtStep === d.current_step_number) {
    await flagAndSendBack(doc, view, a, b!, strict)
    return
  }
  if (isFinal) await decide(doc, b!, strict)
  else {
    await releaseToMessenger(doc, b!, d.current_office_id, here, strict)
    await carry(doc, next, strict)
  }
}

/** The receiver flags an issue on the document and sends it back to the previous office with one of their office's messengers. */
async function flagAndSendBack(doc: TestDoc, view: any, a: Session, b: Session, strict: boolean) {
  const d = view.document
  const here = officeName(d.current_office_id)
  const steps = view.route.steps
  const prevStep = steps.find((s: any) => s.step_number === d.current_step_number - 1)
  const target = prevStep
    ? { office_id: prevStep.office_id as string, step_number: prevStep.step_number as number }
    : { office_id: doc.uploader.officeId!, step_number: 0 }
  const targetName = target.step_number === 0 ? `${officeName(target.office_id)} (its origin)` : officeName(target.office_id)
  sub(`Flag an issue at ${here} and send it back to ${targetName}`)

  const flagged = await api(b, 'POST', '/issues', {
    document_id: doc.id,
    title: `E2E: missing signature (${doc.label})`,
    description: 'Flagged by the automated flow test.',
    category: 'MISSING_DOCUMENT',
    severity: 'HIGH',
  })
  must(flagged.status === 201, `${b.name} flags an issue on the document`, why(flagged, '201'))
  const issue = flagged.data.issue
  check(issue?.status === 'OPEN', 'Issue starts as OPEN', `status = ${issue?.status}`)
  doc.issueId = issue.id
  doc.issueReporter = b
  const adminNotes = await api(client, 'GET', '/notifications?limit=100')
  check(
    adminNotes.data?.data?.some((n: any) => n.type === 'ISSUE_REPORTED' && n.document_id === doc.id),
    'CLIENT admin is notified of the issue',
    'no ISSUE_REPORTED notification',
  )
  const flaggedView = await viewDoc(client, doc.id)
  check(flaggedView.document.open_issues >= 1, 'Document shows it has an open issue', `open_issues = ${flaggedView.document.open_issues}`)

  const [m] = await freeMessengers(d.current_office_id, 1)
  if (strict) {
    const byA = await api(a, 'POST', `/documents/${doc.id}/send-back`, { issue_id: issue.id, liaison_user_id: m!.id })
    check(refused(byA, 403), `${a.name} can't send it back (only ${b.name}, who received it, can)`, why(byA, '403'))
    const noIssue = await api(b, 'POST', `/documents/${doc.id}/send-back`, { liaison_user_id: m!.id })
    check(refused(noIssue, 400), 'Sending back without flagging an issue is rejected', why(noIssue, '400'))
    const otherOffice = [...messengerPools.keys()].find((id) => id !== d.current_office_id) ?? target.office_id
    const [foreign] = await freeMessengers(otherOffice, 1)
    const wrongMessenger = await api(b, 'POST', `/documents/${doc.id}/send-back`, { issue_id: issue.id, liaison_user_id: foreign!.id })
    check(refused(wrongMessenger, 409) && codeOf(wrongMessenger) === 'MESSENGER_OTHER_OFFICE', `A messenger of ${officeName(otherOffice)} can't take it back`, why(wrongMessenger, '409 MESSENGER_OTHER_OFFICE'))
  }

  const sent = await api(b, 'POST', `/documents/${doc.id}/send-back`, { issue_id: issue.id, liaison_user_id: m!.id, remarks: 'E2E: please complete the signature' })
  must(sent.ok, `${b.name} sends it back with ${here}'s messenger ${m!.name}`, why(sent))
  doc.flagged = true
  doc.messenger = m!
  check(sent.data.issue?.status === 'IN_PROGRESS', 'Issue status changes OPEN → IN PROGRESS', `status = ${sent.data.issue?.status}`)
  check(sent.data.document?.sent_back?.office_id === target.office_id, `Document shows it is going back to ${targetName}`, `sent_back = ${JSON.stringify(sent.data.document?.sent_back)}`)
  check(sent.data.document?.assigned_liaison_id === m!.id, 'Document shows the messenger taking it back', `assigned_liaison_id = ${sent.data.document?.assigned_liaison_id}`)

  const targetDesk = desks.get(target.office_id)?.[0]
  if (targetDesk) {
    const inbox = await api(targetDesk, 'GET', '/notifications?limit=100')
    check(inbox.data?.data?.some((n: any) => n.type === 'DOCUMENT_SENT_BACK' && n.document_id === doc.id), `${targetName} is notified it is coming back`, 'no DOCUMENT_SENT_BACK notification')
  }
  if (doc.uploader.id !== b.id) {
    const inbox = await api(doc.uploader, 'GET', '/notifications?limit=100')
    check(inbox.data?.data?.some((n: any) => n.type === 'DOCUMENT_SENT_BACK' && n.document_id === doc.id), 'Uploader is notified it was flagged and sent back', 'no DOCUMENT_SENT_BACK notification')
  }

  await carry(doc, target, strict)
  const back = await viewDoc(client, doc.id)
  check(back.document.current_office_id === target.office_id && back.document.current_step_number === target.step_number, `Document is back at ${targetName}`, `at ${officeName(back.document.current_office_id)}, step ${back.document.current_step_number}`)
  check(back.routing.at(-2)?.sent_back && back.routing.at(-2)?.to_office?.id === target.office_id, `Routing card at ${here} shows "flagged and sent back to ${targetName}"`, `sent_back = ${back.routing.at(-2)?.sent_back}, to = ${back.routing.at(-2)?.to_office?.name}`)
  check(!back.document.sent_back, 'The send-back is closed once it is received', `sent_back = ${JSON.stringify(back.document.sent_back)}`)
}

/** The person who flagged the issue resolves it once the document is back with the fix. */
async function resolveIssue(doc: TestDoc) {
  const r = await api(doc.issueReporter!, 'PATCH', `/issues/${doc.issueId}`, { status: 'RESOLVED', resolution: 'E2E: signature completed by the previous office' })
  check(r.ok && r.data.issue?.status === 'RESOLVED', `${doc.issueReporter!.name} resolves the issue → RESOLVED`, r.ok ? `status = ${r.data.issue?.status}` : why(r))
  const after = await viewDoc(client, doc.id)
  check(after.document.open_issues === 0, 'Document has no open issue any more', `open_issues = ${after.document.open_issues}`)
  doc.resolved = true
}

/** The last office on the route approves the document. */
async function decide(doc: TestDoc, b: Session, strict: boolean) {
  const view = await viewDoc(b, doc.id)
  const approval = view.pending_approval
  must(approval?.id, `Approval request is waiting for ${b.name}`, 'pending_approval is empty')
  check(view.permissions?.canApprove, 'Approve / Return buttons are shown', 'permissions.canApprove = false')

  if (strict) {
    const [m] = await freeMessengers(b.officeId, 1)
    const release = await api(b, 'POST', `/documents/${doc.id}/pickup-request`, { liaison_user_id: m!.id })
    check(refused(release, 409), "The last office can't release it to a messenger (it's decided here)", why(release, '409'))
    const outsider = outsiderOf(b.officeId)
    if (outsider) {
      const r = await api(outsider, 'PATCH', `/approvals/${approval.id}`, { decision: 'APPROVED' })
      check(refused(r, 403, 404), `${outsider.name} (another office) can't approve it`, why(r, '403'))
    }
    const byClient = await api(client, 'PATCH', `/approvals/${approval.id}`, { decision: 'APPROVED' })
    check(refused(byClient, 403), "The CLIENT admin can't approve it", why(byClient, '403'))
    const noRemarks = await api(b, 'PATCH', `/approvals/${approval.id}`, { decision: 'RETURNED' })
    check(refused(noRemarks, 400), 'Returning without remarks is rejected', why(noRemarks, '400'))
    if (b.role === 'STAFF' && b.hasApprovalAuthority) {
      const list = await api(b, 'GET', '/approvals')
      check(list.data?.data?.some((x: any) => x.document_id === doc.id), 'It is listed on the STAFF Approvals page', `not in GET /approvals (${why(list)})`)
    }
  }

  const done = await api(b, 'PATCH', `/approvals/${approval.id}`, { decision: 'APPROVED', remarks: 'E2E: approved' })
  must(done.ok && done.data.document?.status === 'COMPLETED', `${b.name} approves it → COMPLETED`, done.ok ? `status = ${done.data.document?.status}` : why(done))
}

// ---------------------------------------------------------------------------
// Transparency + accountability checks on a finished document
// ---------------------------------------------------------------------------

const REQUIRED_EVENTS = ['CREATED', 'SUBMITTED', 'PICKUP_REQUESTED', 'PICKED_UP', 'IN_TRANSIT', 'ARRIVED', 'RECEIVED', 'PASSED_TO_STAFF', 'APPROVAL_REQUESTED', 'APPROVED', 'COMPLETED']
// Events the system records on its own (no person did them).
const SYSTEM_EVENTS = new Set(['APPROVAL_REQUESTED', 'COMPLETED'])

async function audit(doc: TestDoc, strict: boolean) {
  sub(`Routing details, timeline and activity log`)
  const view = await viewDoc(client, doc.id)
  const steps: any[] = view.route.steps
  const routing: any[] = view.routing

  // Transparency: a routing card for every office visit, each with who received, passed, released, carried, decided.
  const missingSteps = steps.filter((s) => !routing.some((v) => v.step_number === s.step_number))
  check(!missingSteps.length, `Routing cards cover every office on the route (${steps.length})`, `missing step ${missingSteps.map((s) => s.step_number).join(', ')}`, `${routing.length} visits`)
  for (const [i, v] of routing.entries()) {
    const s = steps.find((x) => x.step_number === v.step_number)
    const next = steps.find((x) => x.step_number === v.step_number + 1)
    const lastVisit = i === routing.length - 1
    const label = `Routing card · step ${v.step_number} ${v.office?.name ?? 'origin'}${v.sent_back ? ' (flagged, sent back)' : ''}`
    const problems: string[] = []
    if (s && v.office?.id !== s.office_id) problems.push(`office is ${v.office?.name}`)
    if (v.step_number >= 1) {
      if (!v.received_by) problems.push('no receiver')
      if ((v.desks?.length ?? 0) < 2) problems.push('desk-to-desk handover missing')
    }
    let story = ''
    if (lastVisit) {
      if (v.state !== 'APPROVED') problems.push(`state ${v.state}`)
      if (!v.decided_by) problems.push('no decided_by')
      story = `${v.desks?.map((x: any) => who(x.staff)).join(' → ')} · approved by ${who(v.decided_by)}`
    } else {
      const expectedTo = routing[i + 1]?.office?.id
      if (v.step_number >= 1 && !v.released_by) problems.push('no released_by')
      if (!v.messenger) problems.push('no messenger')
      if (!v.picked_up_at) problems.push('no picked_up_at')
      if (v.to_office?.id !== expectedTo) problems.push(`to_office is ${v.to_office?.name}, next visit is ${routing[i + 1]?.office?.name}`)
      if (v.sent_back && routing[i + 1]?.step_number !== v.step_number - 1) problems.push('sent back but did not go to the previous office')
      if (!v.sent_back && next && routing[i + 1]?.step_number !== next.step_number) problems.push('skipped an office')
      story = `${v.desks?.map((x: any) => who(x.staff)).join(' → ') || 'origin'} · ${v.sent_back ? 'sent back' : 'released'} by ${who(v.released_by)} · messenger ${who(v.messenger)} → ${v.to_office?.name}`
    }
    check(!problems.length, label, problems.join(', '), story)
  }

  // Timeline: every kind of step is there, and every person-made step names who did it.
  const tracking: any[] = view.tracking
  const types = new Set(tracking.map((e) => e.event_type))
  const required = doc.flagged ? [...REQUIRED_EVENTS, 'SENT_BACK'] : REQUIRED_EVENTS
  const missing = required.filter((t) => !types.has(t))
  check(!missing.length, `Timeline has every step${doc.flagged ? ' (including the send-back)' : ''}`, `missing ${missing.join(', ')}`, `${tracking.length} events`)
  const anonymous = tracking.filter((e) => !SYSTEM_EVENTS.has(e.event_type) && !e.actor)
  check(!anonymous.length, 'Every timeline step names the person who did it', `no actor on ${anonymous.map((e) => e.event_type).join(', ')}`)

  // Accountability: the activity log has every timeline step, under the same person.
  const log = await api(client, 'GET', `/activity?scope=organization&days=1&limit=200&q=${encodeURIComponent(doc.qr)}`)
  if (!check(log.ok, 'Activity log loads (organization scope)', why(log))) return
  const rows: any[] = log.data.data.filter((r: any) => r.document?.id === doc.id)
  const byId = new Map(rows.map((r) => [r.id, r]))
  const groups = new Map<string, any[]>()
  for (const e of tracking) groups.set(e.event_type, [...(groups.get(e.event_type) ?? []), e])
  for (const [type, events] of groups) {
    const lost = events.filter((e) => !byId.has(e.id))
    const wrongActor = events.filter((e) => byId.has(e.id) && (byId.get(e.id).actor?.id ?? null) !== (e.actor?.id ?? null))
    const names = [...new Set(events.map((e) => (e.actor ? who(e.actor) : 'system')))].join(', ')
    check(!lost.length && !wrongActor.length, `Activity log · ${type} ×${events.length}`, lost.length ? `${lost.length} not in the activity log` : `logged under the wrong person`, names)
  }

  if (strict) {
    // Each person sees their own steps in "My actions".
    const people = new Map<string, Session>()
    for (const e of tracking) if (e.actor && sessions.has(e.actor.id)) people.set(e.actor.id, sessions.get(e.actor.id)!)
    for (const p of people.values()) {
      const theirs = tracking.filter((e) => e.actor?.id === p.id && e.event_type !== 'CREATED')
      if (!theirs.length) continue
      const mine = await api(p, 'GET', `/activity?scope=mine&days=1&limit=200&q=${encodeURIComponent(doc.qr)}`)
      const ids = new Set((mine.data?.data ?? []).map((r: any) => r.id))
      const lost = theirs.filter((e) => !ids.has(e.id))
      check(mine.ok && !lost.length, `${p.name}'s "My actions" log has their ${theirs.length} step(s)`, mine.ok ? `missing ${lost.map((e) => e.event_type).join(', ')}` : why(mine))
    }
  }

  if (doc.issueId) {
    const issues = await api(client, 'GET', `/issues?document_id=${doc.id}`)
    const issue = (issues.data?.data ?? []).find((i: any) => i.id === doc.issueId)
    check(issue?.status === 'RESOLVED' && issue?.reporter?.id === doc.issueReporter?.id, 'Issue is RESOLVED and names who flagged it', `status = ${issue?.status}, reporter = ${who(issue?.reporter)}`)
  }

  const notes = await api(doc.uploader, 'GET', '/notifications?limit=100')
  check(
    notes.data?.data?.some((n: any) => n.document_id === doc.id && n.type === 'DOCUMENT_COMPLETED'),
    `Uploader ${doc.uploader.name} is notified it was approved`,
    'no DOCUMENT_COMPLETED notification',
  )
}

// ---------------------------------------------------------------------------
// One uploader: 4 uploads, assign messengers, walk each to the end
// ---------------------------------------------------------------------------

async function runUploader(label: string, uploader: Session) {
  section(`${label} uploads · ${uploader.name}${uploader.officeId ? ` (${officeName(uploader.officeId)})` : ''}`)

  sub('1. Upload 4 documents')
  const docs: TestDoc[] = []
  for (const kind of UPLOADS) {
    context = `${label} · ${kind.label}`
    const title = `[E2E ${RUN}] ${label} · ${kind.label}`
    const r = await api(uploader, 'POST', '/documents', uploadForm(title, kind.files, route.id, kind.pages))
    if (!check(r.status === 201, `Upload: ${kind.label} (${kind.files.map((f) => f.name).join(', ')})`, why(r, '201'))) continue
    const d = r.data.document
    createdDocs.push(d.id)
    check(d.status === 'START', '  submitted into its route', `status = ${d.status}`, d.current_step_number === 0 ? `starts at its origin (${d.origin?.name})` : `starts at ${officeName(d.current_office_id)}, step ${d.current_step_number}`)
    check(QR_RE.test(d.qr_code ?? ''), '  QR label created', `qr_code = ${d.qr_code}`, d.qr_code)
    check(d.file_count === kind.files.length, `  ${kind.files.length} file(s) under one QR`, `file_count = ${d.file_count}`)
    const detail = await api(uploader, 'GET', `/documents/${d.id}`)
    const files: any[] = detail.data?.files ?? []
    for (const [i, f] of kind.files.entries()) {
      const stored = files[i]
      const dl = stored ? await api(uploader, 'GET', String(stored.url).replace(/^\/api/, '')) : null
      check(dl?.status === 200 && (dl.data as ArrayBuffer).byteLength === f.bytes.length, `  file ${i + 1} opens and matches what was uploaded`, stored ? why(dl!) : 'file is missing', stored?.name)
    }
    const doc: TestDoc = { id: d.id, qr: d.qr_code, label: kind.label, uploader, messenger: null }
    if (docs.length === FLAGGED_UPLOAD) {
      // From step 1 it goes back to the uploader's own office (its origin) when there is one; else from step 2 to step 1.
      doc.flagAtStep = uploader.officeId && d.current_step_number === 0 ? 1 : Math.min(2, route.steps.length)
      if (doc.flagAtStep <= d.current_step_number && d.current_step_number > 0) doc.flagAtStep = d.current_step_number + 1
    }
    docs.push(doc)
  }
  if (!docs.length) return
  const flaggedDoc = docs.find((d) => d.flagAtStep)
  if (flaggedDoc) note(`"${flaggedDoc.label}" will be flagged with an issue at step ${flaggedDoc.flagAtStep} and sent back to the previous office.`)

  context = `${label} · visibility`
  sub('2. Who can see the new upload')
  const first = (await viewDoc(client, docs[0]!.id)).document
  const ownView = await api(uploader, 'GET', `/documents/${first.id}`)
  check(ownView.ok, 'Uploader can open it', why(ownView))
  if (uploader.role !== 'CLIENT') {
    const adminView = await api(client, 'GET', `/documents/${first.id}`)
    check(adminView.ok, 'CLIENT admin can open it', why(adminView))
  }
  const outsiderOffice = [...desks.keys()].find((id) => id !== first.current_office_id && id !== uploader.officeId)
  if (outsiderOffice) {
    const outsider = desks.get(outsiderOffice)![0]!
    const r = await api(outsider, 'GET', `/documents/${first.id}`)
    check(refused(r, 404), `${outsider.name} (${officeName(outsiderOffice)}, not reached yet) can't open it`, why(r, '404'))
  }

  sub('3. Assign a messenger to each upload (from where it starts)')
  const atOrigin: TestDoc[] = []
  for (const doc of docs) {
    const d = (await viewDoc(client, doc.id)).document
    if (d.current_step_number === 0) atOrigin.push(doc)
    else note(`${doc.label}: starts at ${officeName(d.current_office_id)} (the uploader works there), so that office releases it after the desk-to-desk handover`)
  }
  const originOffice = uploader.officeId
  const pool = atOrigin.length ? await freeMessengers(originOffice, atOrigin.length) : []
  for (const [i, doc] of atOrigin.entries()) {
    context = `${label} · ${doc.label}`
    const m = pool[i]!
    if (i === 0 && originOffice) {
      const otherOffice = [...desks.keys()].find((id) => id !== originOffice)
      if (otherOffice) {
        const [foreign] = await freeMessengers(otherOffice, 1)
        const r = await api(uploader, 'POST', `/documents/${doc.id}/pickup-request`, { liaison_user_id: foreign!.id })
        check(refused(r, 409) && codeOf(r) === 'MESSENGER_OTHER_OFFICE', `A messenger of ${officeName(otherOffice)} can't be used at the origin (${officeName(originOffice)})`, why(r, '409 MESSENGER_OTHER_OFFICE'))
      }
    }
    if (i > 0 && atOrigin[i - 1]!.messenger) {
      const busy = atOrigin[i - 1]!.messenger!
      const r = await api(uploader, 'POST', `/documents/${doc.id}/pickup-request`, { liaison_user_id: busy.id })
      check(refused(r, 409) && codeOf(r) === 'MESSENGER_BUSY', `Busy messenger ${busy.name} can't be given a second document`, r.ok ? 'it was accepted' : why(r, '409 MESSENGER_BUSY'))
    }
    const r = await api(uploader, 'POST', `/documents/${doc.id}/pickup-request`, { liaison_user_id: m.id, remarks: 'E2E: please deliver' })
    if (check(r.ok && r.data.document?.assigned_liaison_id === m.id, `${doc.label}: messenger ${m.name} assigned`, r.ok ? `assigned_liaison_id = ${r.data.document?.assigned_liaison_id}` : why(r))) {
      doc.messenger = m
      doc.assignedAtOrigin = true
    }
  }
  context = `${label} · messengers`
  const holding = docs.find((d) => d.assignedAtOrigin)
  if (holding) {
    const offDuty = await api(holding.messenger!, 'PATCH', '/liaisons/me', { availability: 'OFF_DUTY' })
    check(refused(offDuty, 409), `${holding.messenger!.name} can't go off duty while holding a document`, why(offDuty, '409'))
  }

  for (const [i, doc] of docs.entries()) {
    context = `${label} · ${doc.label}`
    const strict = i === 0 || i === FLAGGED_UPLOAD
    sub(`4.${i + 1} ${doc.label} → follow the route${doc.flagAtStep ? ' (flagged on the way)' : ''}${strict ? ' (with all rule checks)' : ''}  ${dim(doc.qr)}`)
    try {
      for (let guard = 0; guard < 40; guard++) {
        const view = await viewDoc(client, doc.id)
        const d = view.document
        if (d.status === 'COMPLETED') break
        if (!AT_OFFICE.includes(d.status)) throw new FlowStop(`unexpected status ${d.status}`)
        if (d.current_step_number === 0) {
          sub(`origin  ${dim(`(${d.origin?.name})`)}`)
          if (!d.assigned_liaison_id) {
            // Back at its origin office after a send-back: the uploader releases it again.
            await releaseToMessenger(doc, doc.uploader, d.current_office_id, officeName(d.current_office_id), false)
          }
          const next = view.route.steps.find((s: any) => s.step_number === 1)
          await carry(doc, next, strict && !doc.flagged)
        } else await atOffice(doc, view, strict && !(doc.flagged && i !== FLAGGED_UPLOAD))
      }
      await audit(doc, strict)
    } catch (err) {
      if (err instanceof FlowStop) note('This document stopped here; moving on to the next one.')
      else fail('Unexpected error', err instanceof Error ? err.message : String(err))
    }
  }

  if (label === 'CLIENT') await clientOriginSendBackRule()
}

/** A CLIENT upload starts at the organization: from the first office there is no office to send it back to. */
async function clientOriginSendBackRule() {
  context = 'CLIENT · send-back rule'
  sub('A CLIENT upload cannot be sent back past the first office')
  const r = await api(client, 'POST', '/documents', uploadForm(`[E2E ${RUN}] CLIENT · send-back rule`, UPLOADS[0]!.files, route.id))
  if (!check(r.status === 201, 'Upload a document for this check', why(r, '201'))) return
  const doc: TestDoc = { id: r.data.document.id, qr: r.data.document.qr_code, label: 'send-back rule', uploader: client, messenger: null }
  createdDocs.push(doc.id)
  try {
    await releaseToMessenger(doc, client, null, 'the organization', false)
    const first = route.steps[0]
    await carry(doc, first, false)
    const receiver = desks.get(first.office_id)![0]!
    const [m] = await freeMessengers(first.office_id, 1)
    const res = await api(receiver, 'POST', `/documents/${doc.id}/send-back`, { title: 'E2E: wrong form', category: 'OTHER', liaison_user_id: m!.id })
    check(refused(res, 409) && codeOf(res) === 'NO_PREVIOUS_OFFICE', `${officeName(first.office_id)} can't send a CLIENT upload back (no office before it)`, why(res, '409 NO_PREVIOUS_OFFICE'))
    const issues = await api(client, 'GET', `/issues?document_id=${doc.id}`)
    check((issues.data?.data ?? []).length === 0, 'The refused send-back leaves no stray issue behind', `${issues.data?.data?.length} issue(s) on the document`)
  } catch (err) {
    if (!(err instanceof FlowStop)) throw err
  }
}

// ---------------------------------------------------------------------------
// Visibility rules that apply to the whole run
// ---------------------------------------------------------------------------

async function visibilityChecks() {
  section('Visibility & access rules')
  context = 'visibility'
  const anyDoc = createdDocs[0]
  const messenger = allMessengers()[0]
  const desk = [...desks.values()][0]?.[0]

  const all = await api(client, 'GET', `/documents?scope=all&limit=100&q=${encodeURIComponent(`[E2E ${RUN}]`)}`)
  const seen = new Set((all.data?.data ?? []).map((d: any) => d.id))
  check(createdDocs.every((id) => seen.has(id)), `CLIENT sees every test document of this run (${createdDocs.length})`, `sees ${createdDocs.filter((id) => seen.has(id)).length}`)

  if (desk) {
    const mine = await api(desk, 'GET', '/documents?scope=all&limit=100')
    const others = (mine.data?.data ?? []).filter((d: any) => d.submitted_by !== desk.id)
    check(mine.ok && !others.length, `STAFF ${desk.name} lists only their own uploads`, mine.ok ? `lists ${others.length} other documents` : why(mine))
  }
  if (messenger) {
    const list = await api(messenger, 'GET', '/documents?scope=all&limit=100')
    const others = (list.data?.data ?? []).filter((d: any) => d.assigned_liaison_id !== messenger.id)
    check(list.ok && !others.length, `Messenger ${messenger.name} can't list documents not assigned to them`, list.ok ? `?scope=all lists ${others.length} other documents` : why(list))
    if (anyDoc) {
      const delivered = await api(messenger, 'GET', `/documents/${anyDoc}`)
      const carried = (await viewDoc(client, anyDoc)).tracking.some((e: any) => e.actor?.id === messenger.id)
      if (carried) check(delivered.ok, `Messenger ${messenger.name} can still open a document they delivered`, why(delivered))
    }
    const upload = await api(messenger, 'POST', '/documents', uploadForm('E2E messenger upload', UPLOADS[0]!.files, route.id))
    check(refused(upload, 403), "Messenger can't upload documents", why(upload, '403'))
    if (upload.ok) createdDocs.push(upload.data.document.id)
  }
  if (anyDoc) {
    // A STAFF member of an office the (finished) document isn't at can't open it, so they shouldn't write on it.
    const current = (await viewDoc(client, anyDoc)).document.current_office_id
    const outsider = outsiderOf(current)
    if (outsider) {
      const openRes = await api(outsider, 'GET', `/documents/${anyDoc}/timeline`)
      if (openRes.ok) skip("Someone who can't open a document can't add notes to it", `${outsider.name} can open it, so the rule could not be tested`)
      else {
        const noteRes = await api(outsider, 'POST', `/documents/${anyDoc}/notes`, { remarks: 'E2E: note from someone who cannot open this document' })
        check(refused(noteRes, 403, 404), `${outsider.name} (can't open the document) can't add notes to its timeline`, `note was accepted, HTTP ${noteRes.status}`)
        const msg = await api(outsider, 'POST', '/messages', { thread_type: 'DOCUMENT', document_id: anyDoc, body: 'E2E: message from someone who cannot open this document' })
        check(refused(msg, 400, 403, 404), `${outsider.name} can't post in its document thread`, `message was accepted, HTTP ${msg.status}`)
        const issue = await api(outsider, 'POST', '/issues', { document_id: anyDoc, title: 'E2E: issue on a document I cannot open' })
        check(refused(issue, 400, 403, 404), `${outsider.name} can't flag an issue on it`, `issue was accepted, HTTP ${issue.status}`)
      }
    }
    const qr = (await viewDoc(client, anyDoc)).document.qr_code
    const r = await scan(client, qr)
    check(refused(r, 403), "CLIENT admin can't scan QR codes", why(r, '403'))
  }

  context = 'upload validation'
  sub('Upload validation')
  const noTitle = await api(client, 'POST', '/documents', uploadForm('', UPLOADS[0]!.files, route.id))
  check(refused(noTitle, 400), 'Upload without a title is rejected', why(noTitle, '400'))
  if (noTitle.ok) createdDocs.push(noTitle.data.document.id)
  const badType = await api(client, 'POST', '/documents', uploadForm('E2E bad file type', [{ name: 'notes.txt', type: 'text/plain', bytes: text('hello') }], route.id))
  check(refused(badType, 400), 'Upload of a .txt file is rejected (PDF, Word, Excel, images only)', why(badType, '400'))
  if (badType.ok) createdDocs.push(badType.data.document.id)
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function ask(question: string) {
  if (!process.stdin.isTTY) {
    console.log(red('\n✘ Pass the CLIENT login: npm run test:flow -- --email=… --password=…  (or set FV_CLIENT_EMAIL / FV_CLIENT_PASSWORD)'))
    process.exit(1)
  }
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout })
  const answer = await rl.question(question)
  rl.close()
  return answer.trim()
}

async function main() {
  const started = Date.now()
  console.log(bold('\nFlowVision · end-to-end flow test'))
  console.log(dim(`App: ${BASE}`))

  const health = await fetch(`${BASE}/api/health`).then((r) => r.json()).catch(() => null)
  if (health?.status !== 'ok') {
    console.log(red(`\n✘ The app is not reachable at ${BASE} (start it with "npm run dev").`))
    process.exit(1)
  }

  const email = argv.email ?? process.env.FV_CLIENT_EMAIL ?? (await ask('CLIENT email: '))
  const password = argv.password ?? process.env.FV_CLIENT_PASSWORD ?? (await ask('CLIENT password: '))

  section('Setup')
  context = 'setup'
  client = remember(await login(email, password))
  if (!check(client.role === 'CLIENT', `Signed in as CLIENT ${client.name}`, `this account is ${client.role}`)) process.exit(1)

  const routes = await api(client, 'GET', '/routes')
  const wanted = argv.route?.toLowerCase()
  route = (routes.data?.data ?? []).find((r: any) => (wanted ? r.id === argv.route || r.name.toLowerCase() === wanted : r.steps.length >= 1))
  if (!route) {
    console.log(red(`\n✘ No active Document Route${wanted ? ` named "${argv.route}"` : ''} found.`))
    process.exit(1)
  }
  for (const s of route.steps) officeNames.set(s.office_id, s.office?.name ?? s.office_id)
  pass(`Route "${route.name}"`, route.steps.map((s: any) => `${s.step_number}. ${s.office?.name}${s.is_final_checkpoint ? ' (final)' : ''}`).join(' → '))

  const routeOffices = [...new Map(route.steps.map((s: any) => [s.office_id, s.office])).values()] as any[]
  for (const office of routeOffices) {
    const code = String(office.code ?? office.id).toLowerCase().replace(/[^a-z0-9]/g, '')
    officeCodes.set(office.id, code)
    const pair: Session[] = []
    for (const n of [1, 2]) {
      pair.push(await ensureAccount({ email: `e2e.staff${n}.${code}@${EMAIL_DOMAIN}`, first: 'E2E', last: `Staff${n} ${office.code}`, type: 'STAFF', officeId: office.id }))
    }
    desks.set(office.id, pair)
    const messengers = await freeMessengers(office.id, 1)
    pass(`Test staff and messengers of ${office.name}`, [...pair, ...messengers].map((s) => s.email).join(', '))
  }

  const firstOffice = route.steps[0].office_id
  const employeeOffice = routeOffices.find((o) => o.id !== firstOffice)?.id ?? firstOffice
  const runs: Array<[string, () => Promise<Session>]> = [
    ['CLIENT', async () => client],
    ['EMPLOYEE', () => ensureAccount({ email: `e2e.employee@${EMAIL_DOMAIN}`, first: 'E2E', last: 'Employee', type: 'EMPLOYEE', officeId: employeeOffice })],
    ['STAFF', () => ensureAccount({ email: `e2e.uploader.staff@${EMAIL_DOMAIN}`, first: 'E2E', last: 'Uploader Staff', type: 'STAFF', officeId: firstOffice })],
  ]

  for (const [label, getUploader] of runs) {
    if (!ONLY.has(label.toLowerCase())) continue
    context = label
    try {
      await runUploader(label, await getUploader())
    } catch (err) {
      fail(`${label} run`, err instanceof Error ? err.message : String(err))
    }
  }

  try {
    await visibilityChecks()
  } catch (err) {
    fail('Visibility checks', err instanceof Error ? err.message : String(err))
  }

  const secs = Math.round((Date.now() - started) / 1000)
  section('Summary')
  console.log(`    ${green(`✔ ${totals.pass} passed`)}   ${totals.fail ? red(`✘ ${totals.fail} failed`) : dim('✘ 0 failed')}   ${dim(`– ${totals.skip} skipped`)}   ${dim(`(${Math.floor(secs / 60)}m ${secs % 60}s)`)}`)
  if (failures.length) {
    console.log(`\n  ${bold(red('What failed:'))}`)
    for (const f of failures) console.log(`    ${red('✘')} ${f}`)
  } else console.log(`\n  ${green(bold('Every step worked.'))}`)
  console.log(dim(`\n  Test documents are titled "[E2E ${RUN}] …". Test accounts: e2e.*@${EMAIL_DOMAIN}.\n`))
  process.exit(failures.length ? 1 : 0)
}

main().catch((err) => {
  console.error(red(`\n✘ ${err instanceof Error ? err.message : String(err)}`))
  process.exit(1)
})
