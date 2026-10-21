/**
 * Message timestamps end to end, against a running app: every message has a stored time, the
 * conversation list shows each conversation's latest message (even several sent in the same second),
 * the office channel and document threads carry their latest message too, and threads come back in
 * time order. Needs the 2026-10-25 message precision migration (npm run db:migrate on a local database).
 *
 *   npm run test:messages-api        (or: node tests/messages-api.test.ts --base=http://localhost:3000)
 *
 * It writes messages to the database it runs against and refuses a non-local --base unless --remote.
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
  console.error(`Refusing to run against ${BASE}: this test writes messages. Use a local app, or add --remote.`)
  process.exit(1)
}

let failed = 0
let passed = 0
function check(ok: unknown, label: string, detail: unknown = '') {
  if (ok) passed++
  else failed++
  console.log(`${ok ? '\x1b[32m✔\x1b[0m' : '\x1b[31m✘\x1b[0m'} ${label}${ok ? '' : `  → ${typeof detail === 'string' ? detail : JSON.stringify(detail)?.slice(0, 300)}`}`)
}

async function login(email: string, password = PASSWORD) {
  const res = await fetch(`${BASE}/api/auth/login`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email, password }) })
  const cookie = (res.headers.get('set-cookie') ?? '').split(';')[0]!
  const body = (await res.json().catch(() => ({}))) as { user?: any }
  const call = async (method: string, path: string, json?: unknown) => {
    const r = await fetch(`${BASE}/api${path}`, { method, headers: { cookie, ...(json !== undefined && { 'content-type': 'application/json' }) }, body: json !== undefined ? JSON.stringify(json) : undefined })
    return { status: r.status, body: await r.json().catch(() => null) }
  }
  return { status: res.status, user: body.user, call }
}

const ISO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{3})?Z$/
const stamp = Date.now().toString().slice(-6)
const a = await login('hr@bago.gov.ph')
const b = await login('hr.staff@bago.gov.ph') // same office as a
if (a.status !== 200 || b.status !== 200) {
  console.error('Could not sign in as the demo accounts. Seed a local database (npm run db:reset).')
  process.exit(1)
}

console.log('\n1. Direct messages')
const before = Date.now()
const sent = []
for (let i = 1; i <= 3; i++) sent.push(await a.call('POST', '/messages', { thread_type: 'DIRECT', recipient_id: b.user.id, body: `MT ${stamp} #${i}` }))
const after = Date.now()
check(sent.every((r) => r.status === 201 && ISO.test(r.body?.message?.created_at)), 'every sent message comes back with its stored time (ISO, UTC)', sent.map((r) => r.body?.message?.created_at))
const times = sent.map((r) => Date.parse(r.body.message.created_at))
check(times.every((t) => t >= before - 2000 && t <= after + 2000), 'the times are now (server clock), not made up', times)
check(times[0]! <= times[1]! && times[1]! <= times[2]!, 'the times keep the order the messages were sent in', times)
const threadsB = await b.call('GET', '/messages/threads')
const rowB = threadsB.body?.direct?.find((d: any) => d.user.id === a.user.id)
check(rowB?.last_message?.body === `MT ${stamp} #3`, "the receiver's conversation list shows the latest message (three sent in a row)", rowB?.last_message?.body)
check(rowB?.last_message?.created_at === sent[2]!.body.message.created_at, '…with that message’s own time', [rowB?.last_message?.created_at, sent[2]!.body.message.created_at])
check(rowB?.unread >= 3, '…and counts it unread', rowB?.unread)
check(threadsB.body?.direct?.[0]?.user?.id === a.user.id, 'the conversation moved to the top', threadsB.body?.direct?.[0]?.user?.id)
const threadA = await a.call('GET', `/messages/direct/${b.user.id}`)
const bodies = (threadA.body?.data ?? []).map((m: any) => m.body).filter((x: string) => x.startsWith(`MT ${stamp}`))
check(JSON.stringify(bodies) === JSON.stringify([1, 2, 3].map((i) => `MT ${stamp} #${i}`)), 'the thread lists them oldest first, in the order sent', bodies)
const createdAts = (threadA.body?.data ?? []).map((m: any) => m.created_at)
check(createdAts.every((t: string) => ISO.test(t)), 'every message in the thread has a valid time', createdAts.slice(-3))
const again = await b.call('GET', '/messages/threads')
check(again.body?.direct?.find((d: any) => d.user.id === a.user.id)?.last_message?.created_at === rowB?.last_message?.created_at, 'reloading gives the same time and order', '')

console.log('\n2. Office channel')
const off = await a.call('POST', '/messages', { thread_type: 'OFFICE', body: `MT office ${stamp}` })
check(off.status === 201, 'a message to the office channel is saved', off.status)
const thB = await b.call('GET', '/messages/threads')
check(thB.body?.office?.last_message?.body === `MT office ${stamp}` && thB.body.office.last_message.created_at === off.body?.message?.created_at, 'the office channel row carries its latest message and time', thB.body?.office)

console.log('\n3. Document threads')
const docs = await a.call('GET', '/documents?limit=1')
const doc = docs.body?.data?.[0]
if (doc) {
  const d1 = await a.call('POST', '/messages', { thread_type: 'DOCUMENT', document_id: doc.id, body: `MT doc ${stamp} a` })
  const d2 = await a.call('POST', '/messages', { thread_type: 'DOCUMENT', document_id: doc.id, body: `MT doc ${stamp} b` })
  const thA = await a.call('GET', '/messages/threads')
  const row = thA.body?.documents?.find((x: any) => x.document.id === doc.id)
  check(d1.status === 201 && d2.status === 201 && row?.last_message?.body === `MT doc ${stamp} b` && ISO.test(row.last_message.created_at), 'a document thread carries its latest message and time', row?.last_message)
  check(thA.body?.documents?.[0]?.document?.id === doc.id, 'and moves to the top of the document threads', thA.body?.documents?.[0]?.document?.title)
} else {
  console.log('- no document to write on: document thread checks skipped')
}

console.log(`\n${passed} passed, ${failed} failed`)
process.exitCode = failed ? 1 : 0
