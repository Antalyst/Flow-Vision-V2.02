/**
 * The one-time initial administrator (server/lib/bootstrap.ts, scripts/admin-bootstrap.ts) on a real
 * database. It creates its OWN throwaway database `fv_bootstrap_test_<random>` on a LOCAL MySQL /
 * MariaDB server, loads database/flowvision-complete-schema.sql into it, and drops it at the end.
 * It never reads .env and refuses any non-local host.
 *
 *   FV_TEST_DB_PORT=3306 FV_TEST_DB_USER=root FV_TEST_DB_PASS= npm run test:admin-bootstrap
 */
import { after, describe, it } from 'node:test'
import assert from 'node:assert/strict'
import crypto from 'node:crypto'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { spawn } from 'node:child_process'
import mysql from 'mysql2/promise'

const HOST = process.env.FV_TEST_DB_HOST ?? '127.0.0.1'
const PORT = Number(process.env.FV_TEST_DB_PORT ?? 3306)
const USER = process.env.FV_TEST_DB_USER ?? 'root'
const PASS = process.env.FV_TEST_DB_PASS ?? ''
if (!['localhost', '127.0.0.1', '::1'].includes(HOST)) {
  console.error(`Refusing ${HOST}: this test creates and drops a database. Use a local server.`)
  process.exit(1)
}
const DB = `fv_bootstrap_test_${crypto.randomBytes(4).toString('hex')}`
const ROOT = path.resolve(import.meta.dirname, '..')
const SCRIPT = path.join(ROOT, 'scripts', 'admin-bootstrap.ts')

// The app's database config reads process.env when first imported: point it at the throwaway database.
for (const k of Object.keys(process.env)) if (k.startsWith('FV_BOOTSTRAP_')) delete process.env[k]
Object.assign(process.env, { DB_HOST: HOST, DB_PORT: String(PORT), DB_USER: USER, DB_PASS: PASS, DB_NAME: DB, DB_LOGGING: 'false' })

const conn = await mysql.createConnection({ host: HOST, port: PORT, user: USER, password: PASS, multipleStatements: true })
await conn.query(`CREATE DATABASE \`${DB}\` CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci`)
await conn.query(`USE \`${DB}\``)
const schemaSql = await fs.readFile(path.join(ROOT, 'database', 'flowvision-complete-schema.sql'), 'utf8')
await conn.query(schemaSql)
const bootstrapDdl = schemaSql.match(/CREATE TABLE `system_bootstrap` \([\s\S]*?\) ENGINE=[^\n]*;/)![0]
const migrationSql = await fs.readFile(path.join(ROOT, 'database', 'migrations', '2026-10-24-admin-bootstrap.sql'), 'utf8')

const { sequelize } = await import('../server/lib/models.ts')
const { bootstrapAdmin, bootstrapStatus, BootstrapError } = await import('../server/lib/bootstrap.ts')
const { verifyPassword, hashPassword } = await import('../server/lib/auth.ts')

after(async () => {
  await sequelize.close()
  await conn.query(`DROP DATABASE IF EXISTS \`${DB}\``)
  await conn.end()
})

// Generated per run: no credential lives in the repository.
const strongPassword = () => `Fv!${crypto.randomBytes(12).toString('base64url')}7q`
const PASSWORD = strongPassword()

const one = async (sql: string, params: unknown[] = []) => ((await conn.query(sql, params)) as unknown as [Array<Record<string, any>>])[0][0]
const n = async (sql: string, params: unknown[] = []) => Number((await one(sql, params))!.n)
const counts = async () => ({
  users: await n('SELECT COUNT(*) n FROM users'),
  admins: await n("SELECT COUNT(*) n FROM users WHERE account_type = 'ADMIN'"),
  organizations: await n('SELECT COUNT(*) n FROM organizations'),
  marker: await n('SELECT COUNT(*) n FROM system_bootstrap'),
  types: await n('SELECT COUNT(*) n FROM document_types'),
  audit: await n("SELECT COUNT(*) n FROM audit_logs WHERE action = 'ADMIN_BOOTSTRAP'"),
})
const EMPTY = { users: 0, admins: 0, organizations: 0, marker: 0, types: 0, audit: 0 }

async function wipe() {
  const [tables] = (await conn.query("SELECT TABLE_NAME t FROM information_schema.TABLES WHERE TABLE_SCHEMA = ? AND TABLE_TYPE = 'BASE TABLE'", [DB])) as unknown as [Array<{ t: string }>]
  await conn.query(['SET FOREIGN_KEY_CHECKS = 0', ...tables.map(({ t }) => `DELETE FROM \`${t}\``), 'SET FOREIGN_KEY_CHECKS = 1'].join(';'))
}
async function insertOrg(name: string) {
  const id = crypto.randomUUID()
  await conn.query("INSERT INTO organizations (id, name, status) VALUES (?, ?, 'active')", [id, name])
  return id
}
async function insertUser(orgId: string, email: string, type: string) {
  const id = crypto.randomUUID()
  await conn.query("INSERT INTO users (id, org_id, email, password_hash, first_name, last_name, account_type, status) VALUES (?, ?, ?, ?, 'Pre', 'Existing', ?, 'active')", [
    id, orgId, email, await hashPassword(strongPassword()), type,
  ])
  return id
}

const admin = (over: Record<string, unknown> = {}) => ({ email: 'first.admin@city.test', firstName: 'First', lastName: 'Admin', password: PASSWORD, organizationName: 'City of Testville', ...over })
async function rejects(promise: Promise<unknown>, code: string) {
  await assert.rejects(promise, (err: unknown) => err instanceof BootstrapError && err.code === code)
}

/** Run the CLI in its own process, in an empty directory (so no .env is ever loaded). */
async function cli(args: string[], env: Record<string, string> = {}) {
  const cwd = await fs.mkdtemp(path.join(os.tmpdir(), 'fv-bootstrap-'))
  const childEnv: Record<string, string | undefined> = { ...process.env, DB_HOST: HOST, DB_PORT: String(PORT), DB_USER: USER, DB_PASS: PASS, DB_NAME: DB, DB_LOGGING: 'false', ...env }
  return new Promise<{ code: number | null; out: string }>((resolve) => {
    const child = spawn(process.execPath, [SCRIPT, ...args], { cwd, env: childEnv, stdio: ['ignore', 'pipe', 'pipe'] })
    let out = ''
    child.stdout.on('data', (d) => (out += d))
    child.stderr.on('data', (d) => (out += d))
    child.on('close', (code) => {
      fs.rm(cwd, { recursive: true, force: true }).finally(() => resolve({ code, out }))
    })
  })
}
const cliEnv = (over: Record<string, string> = {}) => ({
  FV_BOOTSTRAP_ADMIN_EMAIL: 'ops.admin@city.test',
  FV_BOOTSTRAP_ADMIN_FIRST_NAME: 'Ops',
  FV_BOOTSTRAP_ADMIN_LAST_NAME: 'Admin',
  FV_BOOTSTRAP_ADMIN_PASSWORD: PASSWORD,
  FV_BOOTSTRAP_ORG_NAME: 'City of Clitown',
  ...over,
})

describe('initial administrator bootstrap (library)', () => {
  it('a fresh database is not bootstrapped yet', async () => {
    const s = await bootstrapStatus()
    assert.equal(s.migrated, true)
    assert.equal(s.done, false)
    assert.equal(s.organizations, 0)
  })

  it('bad or missing input fails before anything is written', async () => {
    await rejects(bootstrapAdmin(admin({ password: 'Short1!' })), 'INVALID_INPUT')
    await rejects(bootstrapAdmin(admin({ password: 'onlylowercaseletters' })), 'INVALID_INPUT')
    await rejects(bootstrapAdmin(admin({ password: 'First.Admin#2026x' })), 'INVALID_INPUT') // contains the email name
    await rejects(bootstrapAdmin(admin({ password: 'MyFlowVision#2026' })), 'INVALID_INPUT')
    await rejects(bootstrapAdmin(admin({ password: undefined })), 'INVALID_INPUT')
    await rejects(bootstrapAdmin(admin({ email: 'not-an-email' })), 'INVALID_INPUT')
    await rejects(bootstrapAdmin(admin({ lastName: '  ' })), 'INVALID_INPUT')
    await rejects(bootstrapAdmin(admin({ organizationName: '' })), 'ORGANIZATION_REQUIRED') // empty installation needs a name
    assert.deepEqual(await counts(), EMPTY)
  })

  it('concurrent attempts create exactly one administrator', async () => {
    const attempts = await Promise.allSettled(Array.from({ length: 6 }, (_, i) => bootstrapAdmin(admin({ email: `racer${i}@city.test` }))))
    const won = attempts.filter((a) => a.status === 'fulfilled') as Array<PromiseFulfilledResult<Awaited<ReturnType<typeof bootstrapAdmin>>>>
    const lost = attempts.filter((a) => a.status === 'rejected') as PromiseRejectedResult[]
    assert.equal(won.length, 1, 'exactly one attempt succeeds')
    assert.ok(lost.every((l) => l.reason instanceof BootstrapError && l.reason.code === 'ALREADY_DONE'), 'the others are refused as already done')
    const c = await counts()
    assert.equal(c.users, 1)
    assert.equal(c.admins, 1)
    assert.equal(c.organizations, 1)
    assert.equal(c.marker, 1)
    assert.equal(c.audit, 1)
    assert.ok(c.types > 0, 'the new organization gets the default document types')
    const marker = (await one('SELECT * FROM system_bootstrap'))!
    assert.equal(marker.admin_user_id, won[0]!.value.userId)
    assert.equal(marker.org_id, won[0]!.value.orgId)
    assert.equal(marker.method, 'CLI')
    const org = (await one('SELECT * FROM organizations'))!
    assert.equal(org.created_by, won[0]!.value.userId)
  })

  it('the password is stored only as a bcrypt hash, on an ordinary active ADMIN', async () => {
    const u = (await one("SELECT * FROM users WHERE account_type = 'ADMIN'"))!
    assert.notEqual(u.password_hash, PASSWORD)
    assert.match(u.password_hash, /^\$2[aby]\$12\$/)
    assert.equal(await verifyPassword(PASSWORD, u.password_hash), true)
    assert.equal(u.status, 'active')
    assert.equal(u.office_id, null)
    assert.equal(u.page_access, null)
    const log = (await one("SELECT new_values FROM audit_logs WHERE action = 'ADMIN_BOOTSTRAP'"))!
    assert.ok(!JSON.stringify(log).includes(PASSWORD) && !JSON.stringify(log).includes('$2'), 'the audit entry holds no secret')
  })

  it('running it again changes nothing', async () => {
    const before = await counts()
    await rejects(bootstrapAdmin(admin({ email: 'second.admin@city.test', password: strongPassword() })), 'ALREADY_DONE')
    assert.deepEqual(await counts(), before)
    assert.equal((await bootstrapStatus()).done, true)
  })

  it('an existing ADMIN blocks it even if the marker row was deleted (and the attempt leaves no marker)', async () => {
    await conn.query('DELETE FROM system_bootstrap')
    await rejects(bootstrapAdmin(admin({ email: 'third.admin@city.test' })), 'ALREADY_DONE')
    const c = await counts()
    assert.equal(c.marker, 0)
    assert.equal(c.admins, 1)
  })

  it('an existing installation is closed by the migration (idempotent); its data is untouched', async () => {
    await wipe()
    const orgId = await insertOrg('Existing City')
    const adminId = await insertUser(orgId, 'old.admin@city.test', 'ADMIN')
    await insertUser(orgId, 'old.staff@city.test', 'STAFF')
    const usersBefore = await one('SELECT COUNT(*) n, GROUP_CONCAT(password_hash ORDER BY id) h FROM users')
    await conn.query(migrationSql)
    await conn.query(migrationSql)
    const marker = (await one('SELECT * FROM system_bootstrap'))!
    assert.equal(marker.method, 'EXISTING')
    assert.equal(marker.admin_user_id, adminId)
    assert.equal(await n('SELECT COUNT(*) n FROM system_bootstrap'), 1)
    await rejects(bootstrapAdmin(admin({ email: 'intruder@city.test' })), 'ALREADY_DONE')
    assert.deepEqual(await one('SELECT COUNT(*) n, GROUP_CONCAT(password_hash ORDER BY id) h FROM users'), usersBefore)
  })

  it('the migration records nothing on an empty database', async () => {
    await wipe()
    await conn.query(migrationSql)
    assert.equal(await n('SELECT COUNT(*) n FROM system_bootstrap'), 0)
  })

  it('an organization without an administrator gets one; a taken email fails without leftovers', async () => {
    await wipe()
    const orgId = await insertOrg('Seeded City')
    await insertUser(orgId, 'clerk@city.test', 'STAFF')
    await rejects(bootstrapAdmin(admin({ email: 'clerk@city.test', organizationName: null })), 'EMAIL_TAKEN')
    assert.equal(await n('SELECT COUNT(*) n FROM system_bootstrap'), 0)
    assert.equal(await n('SELECT COUNT(*) n FROM users'), 1)
    const r = await bootstrapAdmin(admin({ organizationName: null }))
    assert.equal(r.orgId, orgId)
    assert.equal(r.organizationCreated, false)
    assert.equal(await n('SELECT COUNT(*) n FROM organizations'), 1)
    assert.equal(await n('SELECT COUNT(*) n FROM document_types'), 0, 'an existing organization keeps its own types')
  })

  it('with several organizations it needs the id of the right one', async () => {
    await wipe()
    await insertOrg('North')
    const south = await insertOrg('South')
    await rejects(bootstrapAdmin(admin({ organizationName: null })), 'ORGANIZATION_REQUIRED')
    await rejects(bootstrapAdmin(admin({ organizationId: crypto.randomUUID() })), 'ORGANIZATION_REQUIRED')
    assert.equal(await n('SELECT COUNT(*) n FROM system_bootstrap'), 0)
    const r = await bootstrapAdmin(admin({ organizationId: south }))
    assert.equal(r.orgId, south)
    assert.equal(await n('SELECT COUNT(*) n FROM organizations'), 2)
  })

  it('refuses on a database that was not migrated', async () => {
    await wipe()
    await conn.query('DROP TABLE system_bootstrap')
    try {
      assert.equal((await bootstrapStatus()).migrated, false)
      await rejects(bootstrapAdmin(admin()), 'NOT_MIGRATED')
      assert.equal(await n('SELECT COUNT(*) n FROM users'), 0)
      assert.equal(await n('SELECT COUNT(*) n FROM organizations'), 0)
    } finally {
      await conn.query(bootstrapDdl)
    }
  })
})

describe('initial administrator bootstrap (command line)', () => {
  it('refuses a remote host and a password on the command line, before connecting', async () => {
    const remote = await cli([], { DB_HOST: 'db.example.invalid', ...cliEnv() })
    assert.equal(remote.code, 1)
    assert.match(remote.out, /refusing to run against the remote database/)
    const argv = await cli(['--password=Secret#2026abc'])
    assert.equal(argv.code, 2)
    assert.ok(!argv.out.includes('Secret#2026abc'))
  })

  it('fails safely without configuration: no terminal and no variables, or a wrong database', async () => {
    await wipe()
    const none = await cli([])
    assert.equal(none.code, 2)
    assert.match(none.out, /no terminal/)
    const badDb = await cli([], { DB_PORT: '1', ...cliEnv() })
    assert.equal(badDb.code, 1)
    assert.match(badDb.out, /cannot connect/)
    assert.ok(!badDb.out.includes(PASSWORD))
    assert.deepEqual(await counts(), EMPTY)
  })

  it('creates the administrator once from deployment variables, never printing the secret', async () => {
    await wipe()
    const runs = await Promise.all([cli([], cliEnv()), cli([], cliEnv()), cli([], cliEnv())])
    const ok = runs.filter((r) => r.code === 0)
    assert.equal(ok.length, 1, `exactly one of three simultaneous processes succeeds: ${runs.map((r) => r.code).join(', ')}`)
    assert.ok(runs.filter((r) => r.code !== 0).every((r) => r.code === 3 && /already has its initial administrator/.test(r.out)), runs.map((r) => r.out).join('\n---\n'))
    for (const r of runs) {
      assert.ok(!r.out.includes(PASSWORD), 'the password is never printed')
      assert.ok(!/\$2[aby]\$/.test(r.out), 'no password hash is printed')
    }
    assert.match(ok[0]!.out, /initial administrator created: ops\.admin@city\.test/)
    const u = (await one("SELECT * FROM users WHERE account_type = 'ADMIN'"))!
    assert.equal(u.email, 'ops.admin@city.test')
    assert.equal(u.status, 'pending', 'a password from configuration must be replaced at first sign-in')
    assert.equal(await verifyPassword(PASSWORD, u.password_hash), true)
    const c = await counts()
    assert.equal(c.admins, 1)
    assert.equal(c.organizations, 1)
    assert.equal(c.marker, 1)

    const again = await cli([], cliEnv({ FV_BOOTSTRAP_ADMIN_EMAIL: 'other@city.test' }))
    assert.equal(again.code, 3)
    assert.deepEqual(await counts(), c)
    const status = await cli(['--status'])
    assert.equal(status.code, 0)
    assert.match(status.out, /\[bootstrap\] done/)
  })
})
