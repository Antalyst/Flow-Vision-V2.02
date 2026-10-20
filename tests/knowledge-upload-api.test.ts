/**
 * Knowledge-file upload end to end, against a running app (the real POST /api/org/knowledge).
 *
 *   npm run dev       (another terminal; LOCAL database with the demo seed; KNOWLEDGE_MAX_MB=130)
 *   npm run test:knowledge-upload-api   (or: node tests/knowledge-upload-api.test.ts --base=http://localhost:3000)
 *
 * Checks: login required, ADMIN only, bad input answers 4xx (never a 500), a small TXT and a small PDF,
 * a 127 MiB PDF (the size that used to fail with "RangeError: Invalid array length"), the size limit,
 * and that an office-scoped file reaches only its office. It writes to the database it runs against
 * (knowledge files it creates are deleted at the end) and refuses a non-local --base unless --remote.
 * --limit-mb=130 must match the app's KNOWLEDGE_MAX_MB; --big-mb=127 sets the big file's size.
 */
const argv: Record<string, string> = Object.fromEntries(
  process.argv.slice(2).map((a) => {
    const m = /^--([^=]+)(?:=(.*))?$/.exec(a)
    return m ? [m[1]!, m[2] ?? 'true'] : [a, 'true']
  }),
)
const BASE = (argv.base ?? process.env.FV_BASE_URL ?? 'http://localhost:3000').replace(/\/$/, '')
const PASSWORD = argv.password ?? process.env.FV_DEMO_PASSWORD ?? 'Demo@1234'
const LIMIT_MB = Number(argv['limit-mb'] ?? 130)
const BIG_MB = Number(argv['big-mb'] ?? 127)
const MiB = 1024 * 1024
if (!/^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(BASE) && !argv.remote) {
  console.error(`Refusing to run against ${BASE}: this test creates knowledge files. Use a local app, or add --remote.`)
  process.exit(1)
}

let failed = 0
let passed = 0
function check(ok: unknown, label: string, detail = '') {
  if (ok) passed++
  else failed++
  console.log(`${ok ? '\x1b[32m✔\x1b[0m' : '\x1b[31m✘\x1b[0m'} ${label}${ok ? '' : `  → ${detail}`}`)
}

async function login(email: string) {
  const res = await fetch(`${BASE}/api/auth/login`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email, password: PASSWORD }) })
  if (!res.ok) throw new Error(`could not sign in as ${email} (${res.status})`)
  return (res.headers.get('set-cookie') ?? '').split(';')[0]!
}
async function call(cookie: string, method: string, path: string, body?: BodyInit, headers: Record<string, string> = {}) {
  const r = await fetch(`${BASE}/api${path}`, { method, body, headers: { ...(cookie && { cookie }), ...headers } })
  return { status: r.status, body: (await r.json().catch(() => null)) as any }
}
const upload = (cookie: string, file: { name: string; type: string; data: Uint8Array | Buffer } | null, fields: Record<string, string> = {}) => {
  const f = new FormData()
  for (const [k, v] of Object.entries(fields)) f.append(k, v)
  if (file) f.append('file', new Blob([file.data as BlobPart], { type: file.type }), file.name)
  return call(cookie, 'POST', '/org/knowledge', f)
}

/** A valid PDF with real text on page 1, plus `padBytes` of unreferenced binary data (a scan's worth of weight). */
function makePdf(text: string[], padBytes = 0) {
  const content = `BT /F1 12 Tf 72 720 Td 16 TL ${text.map((l) => `(${l.replace(/[()\\]/g, '')}) Tj T*`).join(' ')} ET`
  const objs = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>',
    `<< /Length ${content.length} >>\nstream\n${content}\nendstream`,
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
  ]
  const chunks: Buffer[] = [Buffer.from('%PDF-1.4\n')]
  const offsets: number[] = []
  let size = chunks[0]!.length
  const add = (b: Buffer) => (chunks.push(b), (size += b.length))
  objs.forEach((o, i) => {
    offsets.push(size)
    add(Buffer.from(`${i + 1} 0 obj\n${o}\nendobj\n`))
  })
  if (padBytes) {
    offsets.push(size)
    add(Buffer.from(`6 0 obj\n<< /Length ${padBytes} >>\nstream\n`))
    add(Buffer.alloc(padBytes, 0x5a))
    add(Buffer.from('\nendstream\nendobj\n'))
  }
  const n = offsets.length + 1
  const xref = size
  add(Buffer.from(`xref\n0 ${n}\n0000000000 65535 f \n${offsets.map((o) => `${String(o).padStart(10, '0')} 00000 n \n`).join('')}trailer\n<< /Size ${n} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`))
  return Buffer.concat(chunks)
}

const health = await fetch(`${BASE}/api/health`).catch(() => null)
if (!health?.ok) {
  console.error(`The app is not reachable at ${BASE} (start it with npm run dev).`)
  process.exit(1)
}

const created: string[] = []
const track = (r: { body: any }) => r.body?.knowledge_file?.id && created.push(r.body.knowledge_file.id)

const admin = await login('client@bago.gov.ph')
const records = await login('records@bago.gov.ph') // DEPARTMENT_HEAD, Records Section
const hr = await login('hr@bago.gov.ph') // DEPARTMENT_HEAD, HR office
const staff = await login('hr.staff@bago.gov.ph')
const messenger = await login('liaison.adm@bago.gov.ph')

console.log('\nWho may upload')
const txt = { name: 'charter.txt', type: 'text/plain', data: Buffer.from("CITIZEN'S CHARTER\nFees: PHP 500\nProcessing time: 3 days") }
check((await upload('', txt)).status === 401, 'no session → 401')
check((await upload(staff, txt)).status === 403, 'STAFF → 403')
check((await upload(records, txt)).status === 403, 'DEPARTMENT_HEAD → 403')
check((await upload(messenger, txt)).status === 403, 'LIAISON (messenger) → 403')

console.log('\nBad input answers 4xx, never a server error')
const noFile = await upload(admin, null, { title: 'x' })
check(noFile.status === 400, 'no file → 400', String(noFile.status))
const json = await call(admin, 'POST', '/org/knowledge', JSON.stringify({ a: 1 }), { 'content-type': 'application/json' })
check(json.status === 400, 'not multipart → 400', String(json.status))
const garbage = await call(admin, 'POST', '/org/knowledge', 'this is not multipart', { 'content-type': 'multipart/form-data; boundary=XYZ' })
check(garbage.status === 400, 'malformed multipart → 400', String(garbage.status))
const noBoundary = await call(admin, 'POST', '/org/knowledge', 'x', { 'content-type': 'multipart/form-data' })
check(noBoundary.status === 400, 'multipart without a boundary → 400', String(noBoundary.status))
const exe = await upload(admin, { name: 'x.exe', type: 'application/octet-stream', data: Buffer.from('MZ') })
check(exe.status === 400, 'unsupported file type → 400', String(exe.status))
const badOffice = await upload(admin, txt, { office_id: '00000000-0000-4000-8000-000000000000' })
check(badOffice.status === 400, 'office that does not exist in this organization → 400', String(badOffice.status))
const badKind = await upload(admin, txt, { kind: 'SECRET' })
check(badKind.status === 400, 'unknown kind → 400', String(badKind.status))

console.log('\nValid uploads')
const offices = (await call(admin, 'GET', '/offices')).body?.data as Array<{ id: string; name: string; code: string }>
// The Records head's own office (umbrella offices under it have RECORDS in their code too).
const recordsOfficeId = (await call(records, 'GET', '/auth/me')).body?.user?.office?.id
const recordsOffice = offices.find((o) => o.id === recordsOfficeId)!
const before = {
  admin: (await call(admin, 'GET', '/ai/context')).body?.knowledge_files ?? 0,
  records: (await call(records, 'GET', '/ai/context')).body?.knowledge_files ?? 0,
  hr: (await call(hr, 'GET', '/ai/context')).body?.knowledge_files ?? 0,
}

const small = await upload(admin, txt, { title: 'Test charter (txt)', kind: 'CITIZENS_CHARTER' })
track(small)
check(small.status === 201 && small.body.knowledge_file.status === 'READY' && small.body.knowledge_file.kind === 'CITIZENS_CHARTER' && small.body.knowledge_file.office === null, 'small TXT, organization-wide, Citizen’s Charter → 201 READY', JSON.stringify(small.body).slice(0, 200))

const pdf = makePdf(["CITIZEN'S CHARTER 2026", 'Issuance of Business Permit', 'Fees: PHP 500.00', 'Processing time: 3 days'])
const smallPdf = await upload(admin, { name: 'charter.pdf', type: 'application/pdf', data: pdf }, { title: 'Test charter (pdf)' })
track(smallPdf)
check(smallPdf.status === 201 && smallPdf.body.knowledge_file.status === 'READY' && smallPdf.body.knowledge_file.char_count > 20 && !smallPdf.body.knowledge_file.needs_reread, 'small PDF → 201 READY with its text read', JSON.stringify(smallPdf.body).slice(0, 200))

const scoped = await upload(admin, { name: 'records-only.txt', type: 'text/plain', data: Buffer.from('Records Section procedures: certified true copies cost PHP 50 per page.') }, { title: 'Test: Records only', office_id: recordsOffice.id })
track(scoped)
check(scoped.status === 201 && scoped.body.knowledge_file.office?.id === recordsOffice.id, 'file scoped to one office → 201 with that office', JSON.stringify(scoped.body).slice(0, 200))

console.log('\nOffice scope after upload (what each account can read)')
const after = {
  admin: (await call(admin, 'GET', '/ai/context')).body?.knowledge_files ?? 0,
  records: (await call(records, 'GET', '/ai/context')).body?.knowledge_files ?? 0,
  hr: (await call(hr, 'GET', '/ai/context')).body?.knowledge_files ?? 0,
}
check(after.admin - before.admin === 3, 'ADMIN reads all 3 new files', `${before.admin} → ${after.admin}`)
check(after.records - before.records === 3, 'the Records head reads the 2 organization-wide files and the Records-only one', `${before.records} → ${after.records}`)
check(after.hr - before.hr === 2, 'the HR head reads only the 2 organization-wide files (not the Records-only one)', `${before.hr} → ${after.hr}`)

console.log(`\nLarge file (${BIG_MB} MiB PDF)`)
const t0 = Date.now()
const big = await upload(admin, { name: 'citizens-charter-big.pdf', type: 'application/pdf', data: makePdf(["CITIZEN'S CHARTER BIG FILE", 'Fees: PHP 999.00'], BIG_MB * MiB) }, { title: 'Test charter (big pdf)' })
track(big)
check(big.status === 201 && big.body.knowledge_file.status === 'READY' && big.body.knowledge_file.file_size > 126 * MiB && big.body.knowledge_file.char_count > 10, `${BIG_MB} MiB PDF → 201 READY, text read`, `${big.status} ${JSON.stringify(big.body).slice(0, 200)}`)
console.log(`   (took ${((Date.now() - t0) / 1000).toFixed(1)} s)`)

console.log('\nCleaning up the files this test created')
for (const id of created) await call(admin, 'DELETE', `/org/knowledge/${id}`)
const left = (await call(admin, 'GET', '/ai/context')).body?.knowledge_files ?? 0
check(left === before.admin, 'knowledge files are back to what they were', `${before.admin} vs ${left}`)

// Last on purpose: the app rejects this from its declared size without reading the body (the existing
// middleware does it). Under `nuxt dev` the dev proxy then keeps that connection busy, so a request
// sent right after it can stall for a while. The production server doesn't do that.
console.log(`\nThe size limit (${LIMIT_MB} MiB)`)
const tooBig = await upload(admin, { name: 'too-big.pdf', type: 'application/pdf', data: Buffer.alloc((LIMIT_MB + 10) * MiB, 1) })
check(tooBig.status === 413, `a file over the ${LIMIT_MB} MiB limit → 413`, String(tooBig.status))

console.log(`\n${passed} passed, ${failed} failed`)
process.exit(failed ? 1 : 0)
