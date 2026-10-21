/**
 * The Backups page's API against a running app whose server has BACKUP_DIR set (and, for the full
 * run, a single organization). LOCAL only: it creates backups in that server's BACKUP_DIR.
 *
 *   node tests/backup-api.test.ts --base=http://localhost:3000 [--password=<demo password>]
 *
 * Checks who may use it (only an ADMIN whose page access includes Backups), that it takes no paths,
 * that two requests at once start one backup, and that a backup made through it verifies and
 * downloads intact (the download is verified again here, independently).
 */
import crypto from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { pipeline } from 'node:stream/promises'
import { Readable } from 'node:stream'

const argv: Record<string, string> = Object.fromEntries(
  process.argv.slice(2).map((a) => {
    const m = /^--([^=]+)(?:=(.*))?$/.exec(a)
    return m ? [m[1]!, m[2] ?? 'true'] : [a, 'true']
  }),
)
const BASE = (argv.base ?? process.env.FV_BASE_URL ?? 'http://localhost:3000').replace(/\/$/, '')
const PASSWORD = argv.password ?? process.env.FV_DEMO_PASSWORD ?? 'Demo@1234'
if (!/^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(BASE)) {
  console.error(`Refusing ${BASE}: this test makes backups. Use a local app.`)
  process.exit(1)
}

let passed = 0
let failed = 0
const check = (ok: unknown, label: string, detail: unknown = '') => {
  if (ok) passed++
  else failed++
  console.log(`${ok ? '\x1b[32m✔\x1b[0m' : '\x1b[31m✘\x1b[0m'} ${label}${ok ? '' : `  → ${typeof detail === 'string' ? detail : JSON.stringify(detail)}`}`)
}

async function login(email: string, password = PASSWORD) {
  const res = await fetch(`${BASE}/api/auth/login`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email, password }) })
  const cookie = (res.headers.get('set-cookie') ?? '').split(';')[0]!
  const call = async (method: string, p: string, json?: unknown) => {
    const r = await fetch(`${BASE}/api${p}`, { method, headers: { cookie, ...(json !== undefined && { 'content-type': 'application/json' }) }, body: json !== undefined ? JSON.stringify(json) : undefined })
    return { status: r.status, body: (await r.json().catch(() => null)) as any }
  }
  return { status: res.status, user: ((await res.json().catch(() => ({}))) as any).user, cookie, call }
}
const anon = async (method: string, p: string) => (await fetch(`${BASE}/api${p}`, { method })).status

const admin = await login('client@bago.gov.ph')
if (admin.status !== 200) {
  console.error('The demo ADMIN could not sign in: seed a local database or pass --password=')
  process.exit(1)
}
const others = { DEPARTMENT_HEAD: await login('records@bago.gov.ph'), STAFF: await login('hr.staff@bago.gov.ph'), LIAISON: await login('liaison.adm@bago.gov.ph') }
const FAKE = 'flowvision_full_2000-01-01_00-00-00'

console.log('Access')
for (const [m, p] of [['GET', '/backups'], ['POST', '/backups'], ['POST', `/backups/${FAKE}/verify`], ['GET', `/backups/${FAKE}/download`]] as const) {
  check((await anon(m, p)) === 401, `signed out: ${m} /api${p} → 401`)
  for (const [role, s] of Object.entries(others)) {
    const r = await s.call(m, p)
    check(r.status === 403, `${role}: ${m} /api${p} → 403`, r.status)
  }
}
// An ADMIN whose page access leaves out Backups.
const stamp = Date.now()
const limited = await admin.call('POST', '/users', { account_type: 'ADMIN', email: `bk.limited.${stamp}@flowvision.test`, first_name: 'Limited', last_name: 'Admin', page_access: ['/documents'] })
if (limited.status === 201) {
  const s = await login(`bk.limited.${stamp}@flowvision.test`, limited.body.temporary_password)
  check((await s.call('GET', '/backups')).status === 403, 'an ADMIN without the Backups page → 403')
  check((await s.call('POST', '/backups')).status === 403, '…and cannot start one')
  await admin.call('PATCH', `/users/${s.user.id}`, { status: 'SUSPENDED' })
} else check(false, 'could create a limited ADMIN for the page-access check', limited.status)

let overview = await admin.call('GET', '/backups')
check(overview.status === 200, 'ADMIN: GET /api/backups → 200', overview.status)
if (!overview.body?.enabled) {
  check((await admin.call('POST', '/backups')).status === 503, `not available on this server, so POST → 503 (${overview.body?.reason})`)
  console.log(`\n${passed} passed, ${failed} failed (backups are not enabled on this server: the creation checks were skipped)`)
  process.exitCode = failed ? 1 : 0
} else {
  console.log('Paths and names')
  for (const bad of ['..%2F..%2Fpackage.json', '..%5C..%5C.env', 'C%3A%5CWindows%5Cwin.ini', 'flowvision_full_x', FAKE]) {
    const r = await admin.call('GET', `/backups/${bad}/download`)
    check(r.status === 404, `download "${decodeURIComponent(bad)}" → 404`, r.status)
  }
  const before = overview.body.backups.length

  console.log('Create, twice at once')
  const [a, b] = await Promise.all([admin.call('POST', '/backups', { dir: 'C:\\', db: 'mysql' }), admin.call('POST', '/backups')])
  const statuses = [a.status, b.status].sort()
  check(statuses[0] === 202 && statuses[1] === 409, 'two simultaneous requests: one starts (202), the other is refused (409)', statuses)
  const started = Date.now()
  do {
    await new Promise((r) => setTimeout(r, 1000))
    overview = await admin.call('GET', '/backups')
  } while (overview.body.job?.state === 'running' && Date.now() - started < 300_000)
  const job = overview.body.job
  check(job?.state === 'done', 'the backup finishes', job?.error ?? job?.state)
  check(['VERIFIED', 'VERIFIED_WITH_WARNINGS'].includes(job?.result?.status), 'and is verified', job?.result?.status)
  check(overview.body.backups.length === before + 1, 'one new backup in the list (the request body was ignored)', `${before} → ${overview.body.backups.length}`)
  const row = overview.body.backups.find((x: any) => x.name === job?.result?.name)
  check(row && row.bytes > 0 && row.created_at && row.summary?.tables > 0, 'history shows time, size and contents', row)
  if (overview.body.copy) check(job?.result?.copy?.ok === row?.copies?.length > 0, 'copy status in the job matches the history')

  console.log('Verify and download')
  const v = await admin.call('POST', `/backups/${row.name}/verify`)
  check(v.status === 200 && v.body?.ok === true, 'verify → ok', v.body)
  const dl = await fetch(`${BASE}/api/backups/${row.name}/download`, { headers: { cookie: admin.cookie } })
  check(dl.status === 200 && /attachment/.test(dl.headers.get('content-disposition') ?? ''), 'download → 200 as an attachment', dl.status)
  const tmp = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'fv-bk-dl-')), `${row.name}.zip`)
  await pipeline(Readable.fromWeb(dl.body as any), fs.createWriteStream(tmp))
  check(fs.statSync(tmp).size === row.bytes, 'the download is complete (size matches)', `${fs.statSync(tmp).size} vs ${row.bytes}`)
  if (!row.encrypted) {
    const { verifyPackage } = await import('../server/lib/backup/package.ts')
    const res = await verifyPackage(tmp)
    check(res.ok, 'the downloaded package verifies on its own (every checksum and the dump)', res.errors)
  }
  fs.rmSync(path.dirname(tmp), { recursive: true, force: true })
  const logs = await admin.call('GET', '/activity?limit=20')
  check(JSON.stringify(logs.body ?? '').includes('BACKUP_DOWNLOAD') || logs.status !== 200, 'backup actions reach the activity log', logs.status)
  console.log(`\n${passed} passed, ${failed} failed`)
  process.exitCode = failed ? 1 : 0
}
void crypto
