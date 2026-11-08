/**
 * What the notification bell relies on, end to end against a running app on a THROWAWAY database with the demo
 * seed (FlowVision's .env database is the shared Hostinger one, local development included — never run this there):
 *
 *   node tests/notification-bell-api.test.ts --base=http://localhost:3010
 *
 * A fresh account gets 12 real notifications (documents arriving at its office). Then: the unread total is exact,
 * the bell's list (GET /notifications?unread=true&limit=10) is the 10 newest unread ones, reading it marks nothing
 * read, marking one read changes only that one, nobody can read or mark another account's notifications, and the
 * account's open sessions hear about new notifications and read state over the existing WebSocket (/_ws).
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
interface Session {
  call: (method: string, path: string, body?: unknown) => Promise<Res>
  user: any
  cookie: string
}
async function login(email: string, password = PASSWORD): Promise<Session> {
  const res = await fetch(`${BASE}/api/auth/login`, { method: 'POST', headers: { 'content-type': 'application/json', origin: BASE }, body: JSON.stringify({ email, password }) })
  if (!res.ok) throw new Error(`could not sign in as ${email} (${res.status})`)
  const cookie = (res.headers.get('set-cookie') ?? '').split(';')[0]!
  const user = (await res.json()).user
  const call = async (method: string, path: string, body?: unknown) => {
    const form = body instanceof FormData
    const r = await fetch(`${BASE}/api${path}`, {
      method,
      headers: { cookie, origin: BASE, ...(!form && body !== undefined && { 'content-type': 'application/json' }) },
      body: form ? body : body !== undefined ? JSON.stringify(body) : undefined,
    })
    return { status: r.status, body: await r.json().catch(() => null) }
  }
  return { call, user, cookie }
}

const health = await fetch(`${BASE}/api/health`).catch(() => null)
if (!health?.ok) {
  console.error(`The app is not reachable at ${BASE}.`)
  process.exit(1)
}

const stamp = Date.now().toString().slice(-6)
const why = (r: Res) => `${r.status} ${r.body?.message ?? ''}`
const admin = await login('client@bago.gov.ph')
const records = await login('records@bago.gov.ph')
const recordsOffice = records.user.office

async function account(by: Session, body: Record<string, unknown>) {
  const r = await by.call('POST', '/users', { first_name: 'N', ...body })
  if (r.status !== 201) throw new Error(`could not create ${body.email}: ${why(r)}`)
  const password = r.body.temporary_password as string
  return { id: r.body.user.id as string, email: body.email as string, password, session: await login(body.email as string, password) }
}
const png = () => new Blob([Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64')], { type: 'image/png' })
async function upload(title: string, routeId: string) {
  const fd = new FormData()
  fd.append('title', `${title} ${stamp}`)
  fd.append('route_id', routeId)
  fd.append('submit', 'true')
  fd.append('file', png(), 'page.png')
  const r = await admin.call('POST', '/documents', fd)
  if (r.status !== 201) throw new Error(`upload failed: ${why(r)}`)
  return r.body.document
}

/** The account's realtime socket, as the app opens it (session cookie on the upgrade). */
function socket(s: Session) {
  const events: Array<{ event: string; payload: any }> = []
  const ws = new WebSocket(`${BASE.replace(/^http/, 'ws')}/_ws`, { headers: { cookie: s.cookie } } as any)
  ws.onmessage = (m) => {
    try {
      events.push(JSON.parse(String(m.data)))
    } catch {
      /* not JSON */
    }
  }
  const opened = new Promise<boolean>((resolve) => {
    ws.onopen = () => resolve(true)
    ws.onerror = () => resolve(false)
    setTimeout(() => resolve(false), 5000)
  })
  const waitFor = async (event: string, after = 0, ms = 4000) => {
    const until = Date.now() + ms
    while (Date.now() < until) {
      const hit = events.slice(after).find((e) => e.event === event)
      if (hit) return hit
      await new Promise((r) => setTimeout(r, 100))
    }
    return null
  }
  return { ws, events, opened, waitFor }
}

// ── Setup: two fresh Records staff accounts; 12 documents arrive at Records ──────────────────────────────
const x = await account(records, { account_type: 'STAFF', office_id: recordsOffice.id, last_name: 'BellX', email: `bell.x.${stamp}@test.local` })
const y = await account(records, { account_type: 'STAFF', office_id: recordsOffice.id, last_name: 'BellY', email: `bell.y.${stamp}@test.local` })
// A second session of the same account: another tab or device.
const xTab2 = await login(x.email, x.password)
// Named to sort last, so suites that take "the first route" (flow.test.ts) don't pick this one-office route.
const r0 = await admin.call('POST', '/routes', { name: `zz Test bell ${stamp}`, steps: [{ office_id: recordsOffice.id, action_label: 'Review' }] })
const routeId = r0.body?.route?.id as string
for (let i = 1; i <= 12; i++) await upload(`Bell doc ${String(i).padStart(2, '0')}`, routeId)

// ════════════════════════════════════════════════════════════════════════════════════════════════════
console.log('\n1. The badge count and the bell’s list')
let r = await x.session.call('GET', '/notifications?unread=true&limit=10')
check(r.status === 200 && r.body.unread === 12, 'the unread total is every unread notification (12), not just the ones listed', r.body?.unread)
const bell = r.body.data as any[]
check(bell.length === 10, 'the bell gets at most 10', bell.length)
check(bell.every((n) => n.is_read === false), '…all unread', bell.map((n: any) => n.is_read))
const full = ((await x.session.call('GET', '/notifications?limit=50')).body.data as any[]).filter((n) => !n.is_read)
check(JSON.stringify(bell.map((n) => n.id)) === JSON.stringify(full.slice(0, 10).map((n) => n.id)), '…and they are the 10 newest unread ones, newest first', { bell: bell.map((n) => n.title), all: full.map((n: any) => n.title) })
check(bell.every((n, i) => i === 0 || n.created_at <= bell[i - 1].created_at), '…ordered newest first', bell.map((n) => n.created_at))
r = await x.session.call('GET', '/notifications?unread=true&limit=10')
check(r.body.unread === 12, 'opening the list again marks nothing read', r.body.unread)
r = await x.session.call('GET', '/notifications?unread=true&limit=500')
check(r.body.data.length === 12, 'the list size is capped by the request, not by what is stored', r.body.data.length)

console.log('\n2. Marking one read, and realtime')
const tabA = socket(x.session)
const tabB = socket(xTab2)
const connected = (await tabA.opened) && (tabB ? await tabB.opened : true)
check(connected, 'two sessions of the account open the realtime socket', null)
await new Promise((res) => setTimeout(res, 300))
const first = bell[0]
const mark = tabB ? tabB.events.length : 0
r = await x.session.call('PATCH', `/notifications/${first.id}/read`)
check(r.status === 200 && r.body.notification?.is_read === true, 'one notification is marked read', why(r))
check(r.body.unread === 11, '…and the response carries the new unread total (the badge never guesses)', r.body?.unread)
r = await x.session.call('GET', '/notifications?unread=true&limit=10')
check(r.body.unread === 11 && !r.body.data.some((n: any) => n.id === first.id) && r.body.data.length === 10, 'the badge goes down by one, and it leaves the unread list (another one takes its place)', { unread: r.body.unread, n: r.body.data.length })
const stillUnread = ((await x.session.call('GET', '/notifications?limit=50')).body.data as any[]).filter((n) => !n.is_read).length
check(stillUnread === 11, 'only that one was marked read', stillUnread)
if (tabB) {
  const ev = await tabB.waitFor('notifications:changed', mark)
  check(ev?.payload?.unread === 11, 'the other session hears “notifications:changed” with the new total', ev)
}
r = await x.session.call('PATCH', `/notifications/${first.id}/read`)
check(r.status === 200 && r.body.unread === 11, 'marking it read again is harmless (same total)', why(r))
const before = tabA.events.length
await upload('Bell doc new', routeId)
const pushed = await tabA.waitFor('notification', before)
check(Boolean(pushed), 'a new notification is pushed to the account’s session', pushed)
r = await x.session.call('GET', '/notifications?unread=true&limit=10')
check(r.body.unread === 12 && r.body.data[0]?.title?.includes('Bell doc new'), 'the badge goes up and the new one is first', { unread: r.body.unread, first: r.body.data[0]?.title })

console.log('\n3. Only the account’s own notifications')
const yBefore = (await y.session.call('GET', '/notifications?unread=true&limit=10')).body.unread
r = await y.session.call('PATCH', `/notifications/${r.body.data[0].id}/read`)
check(r.status === 404, 'another account cannot mark it read (404, as if it didn’t exist)', why(r))
r = await x.session.call('GET', '/notifications?unread=true&limit=10')
check(r.body.unread === 12, '…and it is still unread', r.body.unread)
r = await y.session.call('GET', `/notifications?unread=true&limit=10&user_id=${x.id}`)
check(r.body.unread === yBefore, 'a user_id in the request is ignored: the caller’s own count', { y: r.body.unread, before: yBefore })
const xIds = new Set(((await x.session.call('GET', '/notifications?limit=100')).body.data as any[]).map((n) => n.id))
const yList = (await y.session.call('GET', `/notifications?limit=100&user_id=${x.id}`)).body.data as any[]
check(!yList.some((n) => xIds.has(n.id)), 'another account never sees these notifications', yList.length)
const anon = await fetch(`${BASE}/api/notifications?unread=true&limit=10`)
check(anon.status === 401, 'without a session → 401', anon.status)

// Simultaneous reads, as from two tabs: two different notifications, one of them twice. Each counts once.
const unreadNow = (await x.session.call('GET', '/notifications?unread=true&limit=10')).body
const [p, q] = unreadNow.data as any[]
const together = await Promise.all([p, q, p].map((n) => x.session.call('PATCH', `/notifications/${n.id}/read`)))
check(together.every((t) => t.status === 200 && t.body.unread >= unreadNow.unread - 2 && t.body.unread < unreadNow.unread), 'simultaneous reads all succeed, each reporting a total in range', together.map((t) => [t.status, t.body?.unread]))
r = await x.session.call('GET', '/notifications?unread=true&limit=10')
check(r.body.unread === unreadNow.unread - 2, 'simultaneous reads: exactly two fewer unread (never double-counted, never negative)', { before: unreadNow.unread, after: r.body.unread })

console.log('\n4. Mark all read, empty list')
const markAll = tabB ? tabB.events.length : 0
r = await x.session.call('POST', '/notifications/read-all')
check(r.status === 200, 'mark all read', why(r))
r = await x.session.call('GET', '/notifications?unread=true&limit=10')
check(r.body.unread === 0 && r.body.data.length === 0, 'nothing unread: the bell shows its empty state', r.body)
if (tabB) {
  const ev = await tabB.waitFor('notifications:changed', markAll)
  check(ev?.payload?.unread === 0, 'the other session hears the cleared count', ev)
}
r = await y.session.call('GET', '/notifications?unread=true&limit=10')
check(r.body.unread === yBefore, 'another account’s notifications are untouched', { y: r.body.unread, before: yBefore })

tabA.ws.close()
tabB?.ws.close()
console.log(`\n${passed} passed, ${failed} failed`)
process.exitCode = failed ? 1 : 0
