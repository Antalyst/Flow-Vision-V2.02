/**
 * The document-origin migration (database/migrations/2026-10-31-document-origin.sql) on a database from
 * before it: which documents get an origin office from their history, which stay NULL and why, that nothing
 * else changes, that it stops on a column / index / foreign key defined differently, its rollback, running
 * it twice, and npm run db:migrate (which runs the same file).
 *
 *   FV_THROWAWAY_DB=1 DB_HOST=127.0.0.1 DB_PORT=… DB_USER=… DB_PASS=… npm run test:document-origin-migration
 *
 * Only against a throwaway MySQL/MariaDB server you started for it (FlowVision's .env database is the shared
 * Hostinger one, local development included). It creates (and drops) its own databases, fv_origin_mig_<n>_<k>,
 * on that server, so the account needs CREATE and DROP. It reads DB_* from the environment, never from .env;
 * it refuses the server named in .env and any host that isn't local, and is skipped without FV_THROWAWAY_DB=1.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import fs from 'node:fs/promises'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import { parseEnv } from 'node:util'

const root = path.resolve(import.meta.dirname, '..')
const host = process.env.DB_HOST ?? ''
const port = process.env.DB_PORT ?? '3306'
// The app's own database (.env) is the shared Hostinger one, used by local development too: never test there.
// Only host and port are compared; no value is printed.
const appDb = await fs
  .readFile(path.join(root, '.env'), 'utf8')
  .then((text) => parseEnv(text))
  .catch(() => ({}) as Record<string, string>)
const isAppServer = Boolean(appDb.DB_HOST) && appDb.DB_HOST === host && (appDb.DB_PORT ?? '3306') === port
const skip =
  process.env.FV_THROWAWAY_DB !== '1'
    ? 'set FV_THROWAWAY_DB=1 to confirm DB_* points at a throwaway server you started for this'
    : !host
      ? 'DB_HOST not set'
      : isAppServer
        ? 'refusing: DB_HOST/DB_PORT is the database server in .env (the shared production database)'
        : !['localhost', '127.0.0.1'].includes(host)
          ? 'refusing DB_HOST: only a throwaway server on this machine'
          : false
const prefix = `fv_origin_mig_${Date.now().toString().slice(-8)}`

test('document-origin migration', { skip }, async (t) => {
  const mysql = await import('mysql2/promise')
  const connect = (database?: string) =>
    mysql.createConnection({ host, port: Number(process.env.DB_PORT ?? 3306), user: process.env.DB_USER, password: process.env.DB_PASS ?? '', database, multipleStatements: true })
  const server = await connect()
  const [[{ version }]] = (await server.query('SELECT VERSION() AS version')) as any
  t.diagnostic(`server ${version}`)
  const schema = await fs.readFile(path.join(root, 'database/flowvision-complete-schema.sql'), 'utf8')
  const migration = await fs.readFile(path.join(root, 'database/migrations/2026-10-31-document-origin.sql'), 'utf8')
  const rollback = await fs.readFile(path.join(root, 'database/migrations/2026-10-31-document-origin.rollback.sql'), 'utf8')
  const opened: Array<{ name: string; db: Awaited<ReturnType<typeof connect>> }> = []
  t.after(async () => {
    for (const { name, db } of opened) {
      await db.end().catch(() => {})
      await server.query(`DROP DATABASE IF EXISTS \`${name}\``)
    }
    await server.end()
  })

  /** A new database with the current schema, taken back to before the migration. */
  async function freshDb() {
    const name = `${prefix}_${opened.length}`
    await server.query(`CREATE DATABASE \`${name}\` CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci`)
    const db = await connect(name)
    opened.push({ name, db })
    await db.query(schema)
    await db.query(rollback)
    const rows = async (sql: string, params: unknown[] = []) => (await db.query(sql, params))[0] as any[]
    return { name, db, rows }
  }
  const hasFk = async (rows: (sql: string) => Promise<any[]>) =>
    (await rows("SELECT DELETE_RULE AS d FROM information_schema.REFERENTIAL_CONSTRAINTS WHERE CONSTRAINT_SCHEMA = DATABASE() AND CONSTRAINT_NAME = 'fk_documents_origin_office'"))[0]?.d ?? null
  const hasIdx = async (rows: (sql: string) => Promise<any[]>) =>
    (await rows("SHOW INDEX FROM documents WHERE Key_name = 'idx_documents_origin_office'")).length > 0

  // ── The main database: one fixture per historical case ───────────────────────────────────────
  const { name: mainName, db, rows } = await freshDb()
  assert.equal((await rows("SHOW COLUMNS FROM documents LIKE 'origin_office_id'")).length, 0, 'the rollback removes the column')

  const id = () => randomUUID()
  const [orgA, orgB, MAIN, UNIT, OTHER, FOREIGN] = [id(), id(), id(), id(), id(), id()]
  const [mover, unitStaff, admin] = [id(), id(), id()]
  // Malformed audit JSON can't be stored while the schema's json_valid check is on (MariaDB and MySQL
  // both keep it); drop it here so the migration's handling of it is tested anyway.
  // MySQL: named table constraints. MariaDB 10.4: column-level checks, removed by redefining the column.
  for (const c of await rows("SELECT CONSTRAINT_NAME AS n FROM information_schema.TABLE_CONSTRAINTS WHERE CONSTRAINT_SCHEMA = DATABASE() AND TABLE_NAME = 'audit_logs' AND CONSTRAINT_TYPE = 'CHECK'")) {
    await db.query(`ALTER TABLE audit_logs DROP CONSTRAINT \`${c.n}\``).catch(() => {})
  }
  await db.query('ALTER TABLE audit_logs MODIFY old_values longtext CHARACTER SET utf8mb4 COLLATE utf8mb4_bin NULL, MODIFY new_values longtext CHARACTER SET utf8mb4 COLLATE utf8mb4_bin NULL')
  await db.query('SET FOREIGN_KEY_CHECKS = 0')
  await db.query('INSERT INTO organizations (id, name) VALUES (?, ?), (?, ?)', [orgA, 'Org A', orgB, 'Org B'])
  await db.query('INSERT INTO offices (id, org_id, name, code, parent_office_id) VALUES (?,?,?,?,NULL), (?,?,?,?,?), (?,?,?,?,NULL), (?,?,?,?,NULL)', [
    MAIN, orgA, 'Main', 'A-MAIN', UNIT, orgA, 'Unit', 'A-MAIN-U', MAIN, OTHER, orgA, 'Other', 'A-OTHER', FOREIGN, orgB, 'Foreign', 'B-FOR',
  ])
  // The main-office uploader has since moved to OTHER: their current office must not be used.
  await db.query('INSERT INTO users (id, org_id, email, password_hash, account_type, office_id) VALUES (?,?,?,?,?,?), (?,?,?,?,?,?), (?,?,?,?,?,NULL)', [
    mover, orgA, 'mover@t', 'x', 'STAFF', OTHER, unitStaff, orgA, 'unit@t', 'x', 'STAFF', UNIT, admin, orgA, 'admin@t', 'x', 'ADMIN',
  ])
  const UPDATED = '2026-01-02 03:04:05'
  const ev = (type: string, extra: Record<string, unknown> = {}) => ({ id: id(), type, at: '2026-01-01T00:00:00.000Z', by: mover, status: 'START', ...extra })
  const log = (...types: string[]) => JSON.stringify(types.map((type) => ev(type)))
  // What the app writes on upload-and-submit, and on a draft.
  const submitted = (office: string | null, step: number) => ({ id: 'x', status: 'START', current_office_id: office, current_step_number: step, submitted_by: mover })
  const draftAudit = { id: 'x', status: 'CREATED', current_step_number: 1, submitted_by: mover }
  const docs: Record<string, string> = {}
  type Visit = [step: number, office: string | null, notes: string | null]
  async function doc(key: string, by: string, visits: Visit[], audits: Array<Record<string, unknown> | string | null> = []) {
    const d = (docs[key] = id())
    await db.query('INSERT INTO documents (id, org_id, route_id, title, submitted_by, status, updated_at) VALUES (?,?,?,?,?,?,?)', [d, orgA, id(), key, by, visits.length ? 'START' : 'CREATED', UPDATED])
    for (const [step, office, notes] of visits) {
      await db.query('INSERT INTO document_tracking (id, document_id, step_number, office_id, status, notes) VALUES (?,?,?,?,?,?)', [id(), d, step, office, 'START', notes])
    }
    for (const a of audits) {
      await db.query('INSERT INTO audit_logs (id, user_id, action, entity_type, entity_id, new_values) VALUES (?,?,?,?,?,?)', [id(), by, 'DOCUMENT_CREATE', 'document', d, a === null ? null : typeof a === 'string' ? a : JSON.stringify(a)])
    }
  }
  const expected: Record<string, string | null> = {}
  const backfilled = (key: string, office: string) => (expected[key] = office)

  // Backfilled: exactly one SUBMITTED event, first in its step-0/1 visit, with an office, audit agreeing or silent.
  await doc('main office', mover, [[0, MAIN, log('SUBMITTED')]], [submitted(MAIN, 0)])
  backfilled('main office', MAIN)
  await doc('umbrella office', unitStaff, [[0, UNIT, log('SUBMITTED')]], [submitted(UNIT, 0)])
  backfilled('umbrella office', UNIT)
  await doc('first office, step 1', mover, [[1, MAIN, log('SUBMITTED', 'RECEIVED')]], [submitted(MAIN, 1)])
  backfilled('first office, step 1', MAIN)
  await doc('later step-0 and step-1 visits', mover, [[0, MAIN, log('SUBMITTED', 'PICKED_UP')], [1, OTHER, log('ARRIVED', 'RECEIVED', 'SENT_BACK')], [0, MAIN, log('ARRIVED', 'RECEIVED')], [1, OTHER, log('ARRIVED')]])
  backfilled('later step-0 and step-1 visits', MAIN)
  await doc('resubmitted elsewhere later', mover, [[0, MAIN, log('SUBMITTED')], [0, OTHER, log('RESUBMITTED')], [1, OTHER, log('RESUBMITTED', 'RECEIVED')]])
  backfilled('resubmitted elsewhere later', MAIN)
  await doc('draft submitted later', unitStaff, [[0, UNIT, log('SUBMITTED')]], [draftAudit])
  backfilled('draft submitted later', UNIT)
  await doc('audit without office or step fields', mover, [[0, MAIN, log('SUBMITTED')]], [{ status: 'START' }])
  backfilled('audit without office or step fields', MAIN)
  await doc('audit without any field', mover, [[0, MAIN, log('SUBMITTED')]], [{}])
  backfilled('audit without any field', MAIN)
  await doc('audit is JSON null', mover, [[0, MAIN, log('SUBMITTED')]], ['null'])
  backfilled('audit is JSON null', MAIN)
  await doc('audit without new_values', mover, [[0, MAIN, log('SUBMITTED')]], [null])
  backfilled('audit without new_values', MAIN)
  await doc('two agreeing audits', mover, [[0, MAIN, log('SUBMITTED')]], [submitted(MAIN, 0), submitted(MAIN, 0)])
  backfilled('two agreeing audits', MAIN)
  await doc('a SUBMITTED remark is not an event', mover, [[0, MAIN, JSON.stringify([ev('SUBMITTED'), ev('NOTE', { remarks: '"type":"SUBMITTED" was typed here' })])]])
  backfilled('a SUBMITTED remark is not an event', MAIN)

  // Left NULL:
  await doc('admin upload (no office)', admin, [[0, null, log('SUBMITTED')]], [submitted(null, 0)])
  await doc('before the event log', mover, [[0, MAIN, 'Document submitted']])
  await doc('resubmission only', mover, [[0, OTHER, log('RESUBMITTED')]])
  await doc('two SUBMITTED visits, different offices', mover, [[0, MAIN, log('SUBMITTED')], [0, OTHER, log('SUBMITTED')]])
  await doc('two SUBMITTED visits, same office', mover, [[0, MAIN, log('SUBMITTED')], [0, MAIN, log('SUBMITTED')]])
  await doc('two SUBMITTED events in one visit', mover, [[0, MAIN, log('SUBMITTED', 'SUBMITTED')]])
  await doc('SUBMITTED at step 0 and at step 2', mover, [[0, MAIN, log('SUBMITTED')], [2, OTHER, log('SUBMITTED')]])
  await doc('SUBMITTED only at a later step', mover, [[2, MAIN, log('SUBMITTED')]])
  await doc('SUBMITTED not first in its visit', mover, [[0, MAIN, log('ARRIVED', 'SUBMITTED')]])
  await doc('unreadable notes', mover, [[0, MAIN, 'note: "type":"SUBMITTED" {broken']])
  await doc('an unreadable visit next to a good one', mover, [[0, MAIN, log('SUBMITTED')], [1, OTHER, '[{"type":"SUBMITTED"']])
  await doc('office of another organization', mover, [[0, FOREIGN, log('SUBMITTED')]])
  await doc('office that does not exist', mover, [[0, id(), log('SUBMITTED')]])
  await doc('audit: different office', mover, [[0, MAIN, log('SUBMITTED')]], [submitted(OTHER, 0)])
  await doc('audit: office is null', mover, [[0, MAIN, log('SUBMITTED')]], [submitted(null, 0)])
  await doc('audit: different step', mover, [[0, MAIN, log('SUBMITTED')]], [submitted(MAIN, 1)])
  await doc('audit: contradictory status', mover, [[0, MAIN, log('SUBMITTED')]], [{ ...submitted(MAIN, 0), status: 'COMPLETED' }])
  await doc('audit: draft with an office', mover, [[0, MAIN, log('SUBMITTED')]], [{ ...draftAudit, current_office_id: OTHER }])
  await doc('audit: different origin_office_id', mover, [[0, MAIN, log('SUBMITTED')]], [{ ...submitted(MAIN, 0), origin_office_id: OTHER }])
  await doc('audit: malformed JSON', mover, [[0, MAIN, log('SUBMITTED')]], ['{"status":"START", broken'])
  await doc('audit: not an object', mover, [[0, MAIN, log('SUBMITTED')]], ['["START"]'])
  await doc('one agreeing and one contradicting audit', mover, [[0, MAIN, log('SUBMITTED')]], [submitted(MAIN, 0), submitted(OTHER, 0)])
  await doc('draft', mover, [], [draftAudit])
  await db.query('SET FOREIGN_KEY_CHECKS = 1')

  const snapshot = async () => ({
    tracking: await rows('SELECT id, document_id, step_number, office_id, status, notes, updated_at FROM document_tracking ORDER BY id'),
    audit: await rows('SELECT * FROM audit_logs ORDER BY id'),
    users: await rows('SELECT id, office_id FROM users ORDER BY id'),
  })
  const before = await snapshot()
  const originsOf = async (r = rows) => Object.fromEntries((await r('SELECT title, origin_office_id FROM documents')).map((x) => [x.title, x.origin_office_id])) as Record<string, string | null>
  const assertOrigins = (got: Record<string, string | null>, label: string) => {
    for (const key of Object.keys(docs)) assert.equal(got[key], expected[key] ?? null, `${label}: "${key}"`)
  }
  const stampsKept = async () => (await rows("SELECT DATE_FORMAT(updated_at, '%Y-%m-%d %H:%i:%s') AS u FROM documents")).every((r) => r.u === UPDATED)

  await t.test('adds the column, index and foreign key (RESTRICT), matching offices.id', async () => {
    const results = ((await db.query(migration))[0] as any[]).flat()
    const reported = results.find((r: any) => r && 'origins_backfilled' in r)
    assert.equal(Number(reported?.origins_backfilled), Object.keys(expected).length, 'reports how many it backfilled')
    const outcomes = results.filter((r: any) => r && 'outcome' in r)
    assert.equal(outcomes.reduce((n: number, r: any) => n + Number(r.documents), 0), Object.keys(docs).length, 'reports an outcome for every document')
    const [col] = await rows("SELECT DATA_TYPE, CHARACTER_MAXIMUM_LENGTH AS len, COLLATION_NAME, IS_NULLABLE FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'documents' AND COLUMN_NAME = 'origin_office_id'")
    const [office] = await rows("SELECT COLLATION_NAME FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'offices' AND COLUMN_NAME = 'id'")
    assert.deepEqual([col?.DATA_TYPE, Number(col?.len), col?.COLLATION_NAME, col?.IS_NULLABLE], ['char', 36, office?.COLLATION_NAME, 'YES'])
    assert.ok(await hasIdx(rows))
    assert.equal(await hasFk(rows), 'RESTRICT')
  })

  await t.test('backfills only what the history proves', async () => {
    assertOrigins(await originsOf(), 'origin')
  })

  await t.test('the umbrella origin leads to its main office', async () => {
    const [r] = await rows('SELECT p.id AS main FROM documents d JOIN offices o ON o.id = d.origin_office_id JOIN offices p ON p.id = o.parent_office_id WHERE d.id = ?', [docs['umbrella office']])
    assert.equal(r?.main, MAIN)
  })

  await t.test('changes nothing else', async () => {
    assert.deepEqual(await snapshot(), before, 'tracking, audit and users are untouched')
    assert.ok(await stampsKept(), 'documents keep their updated_at')
  })

  await t.test('an office that is a document’s origin cannot be deleted', async () => {
    // An office nothing else points at, made the origin of one document.
    const lone = id()
    await db.query('INSERT INTO offices (id, org_id, name, code) VALUES (?, ?, ?, ?)', [lone, orgA, 'Lone', 'A-LONE'])
    await db.query('UPDATE documents SET origin_office_id = ?, updated_at = updated_at WHERE id = ?', [lone, docs.draft])
    await assert.rejects(db.query('DELETE FROM offices WHERE id = ?', [lone]), (e: any) => e.errno === 1451, 'refused while it is an origin')
    await db.query('UPDATE documents SET origin_office_id = NULL, updated_at = updated_at WHERE id = ?', [docs.draft])
    await db.query('DELETE FROM offices WHERE id = ?', [lone])
    assert.equal((await rows('SELECT 1 FROM offices WHERE id = ?', [lone])).length, 0, 'and only that blocked it')
  })

  await t.test('running it again overwrites nothing', async () => {
    await db.query('UPDATE documents SET origin_office_id = ?, updated_at = updated_at WHERE id = ?', [OTHER, docs['umbrella office']])
    const results = ((await db.query(migration))[0] as any[]).flat()
    assert.equal(Number(results.find((r: any) => r && 'origins_backfilled' in r)?.origins_backfilled), 0)
    assert.equal((await originsOf())['umbrella office'], OTHER, 'a recorded origin is kept, even one that differs from the history')
    await db.query('UPDATE documents SET origin_office_id = ?, updated_at = updated_at WHERE id = ?', [UNIT, docs['umbrella office']])
  })

  await t.test('rollback, then migrate again: same result', async () => {
    await db.query(rollback)
    assert.equal((await rows("SHOW COLUMNS FROM documents LIKE 'origin_office_id'")).length, 0)
    assert.equal(await hasFk(rows), null)
    await db.query(rollback) // twice is fine
    await db.query(migration)
    assertOrigins(await originsOf(), 'after rollback')
  })

  await t.test('npm run db:migrate runs the same file', async () => {
    await db.query('UPDATE documents SET origin_office_id = NULL, updated_at = updated_at')
    execFileSync(process.execPath, ['scripts/db-migrate.ts'], { cwd: root, env: { ...process.env, DB_NAME: mainName }, stdio: 'pipe' })
    assertOrigins(await originsOf(), 'db:migrate')
    assert.ok(await stampsKept(), 'documents keep their updated_at')
  })

  await t.test('works on a documents table without updated_at', async () => {
    await db.query(rollback)
    await db.query('ALTER TABLE documents DROP COLUMN updated_at')
    await db.query(migration)
    assertOrigins(await originsOf(), 'without updated_at')
  })

  // ── Existing objects defined differently: it stops before changing anything ─────────────────────────
  const stops = async (setup: string, message: RegExp) => {
    const fresh = await freshDb()
    await fresh.db.query(setup)
    const table = async () => ((await fresh.rows('SHOW CREATE TABLE documents'))[0] as any)['Create Table']
    const before = await table()
    // Case-insensitive: with lower_case_table_names=1 (Windows) the server lowercases the name in the message.
    await assert.rejects(fresh.db.query(migration), (e: any) => new RegExp(message.source, 'i').test(String(e.message)), 'the script stops with the reason')
    assert.equal(await table(), before, 'documents is exactly as it was: no column, index or foreign key was added')
    return fresh
  }

  await t.test('stops on an existing column of another type', async () => {
    const f = await stops('ALTER TABLE documents ADD COLUMN origin_office_id varchar(36) NULL', /ABORTED documents origin_office_id is defined differently/)
    assert.equal(await hasIdx(f.rows), false, 'no index was added')
    assert.equal(await hasFk(f.rows), null, 'no foreign key was added')
  })

  await t.test('stops on an existing column with another collation', async () => {
    await stops('ALTER TABLE documents ADD COLUMN origin_office_id char(36) CHARACTER SET utf8mb4 COLLATE utf8mb4_bin NULL', /ABORTED documents origin_office_id is defined differently/)
  })

  await t.test('stops on an existing NOT NULL column', async () => {
    await stops("ALTER TABLE documents ADD COLUMN origin_office_id char(36) CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci NOT NULL DEFAULT ''", /ABORTED documents origin_office_id is defined differently/)
  })

  await t.test('stops on an index of that name on another column', async () => {
    const f = await stops('CREATE INDEX idx_documents_origin_office ON documents (current_office_id)', /ABORTED idx_documents_origin_office is defined differently/)
    assert.equal(await hasFk(f.rows), null, 'no foreign key was added')
  })

  await t.test('stops on a foreign key of that name with another rule', async () => {
    const f = await stops(
      'ALTER TABLE documents ADD COLUMN origin_office_id char(36) CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci NULL DEFAULT NULL; ' +
        'ALTER TABLE documents ADD CONSTRAINT fk_documents_origin_office FOREIGN KEY (origin_office_id) REFERENCES offices (id) ON DELETE CASCADE',
      /ABORTED fk_documents_origin_office is defined differently/i,
    )
    assert.equal(await hasFk(f.rows), 'CASCADE', 'it was left as it was')
  })

  await t.test('stops on another foreign key on the column', async () => {
    await stops(
      'ALTER TABLE documents ADD COLUMN origin_office_id char(36) CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci NULL DEFAULT NULL; ' +
        'ALTER TABLE documents ADD CONSTRAINT fk_somebody_else FOREIGN KEY (origin_office_id) REFERENCES offices (id)',
      /ABORTED fk_documents_origin_office is defined differently/i,
    )
  })

  await t.test('upgrades the earlier ON DELETE SET NULL foreign key to RESTRICT', async () => {
    const f = await freshDb()
    await f.db.query(
      'ALTER TABLE documents ADD COLUMN origin_office_id char(36) CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci NULL DEFAULT NULL AFTER current_office_id; ' +
        'CREATE INDEX idx_documents_origin_office ON documents (origin_office_id); ' +
        'ALTER TABLE documents ADD CONSTRAINT fk_documents_origin_office FOREIGN KEY (origin_office_id) REFERENCES offices (id) ON DELETE SET NULL',
    )
    await f.db.query(migration)
    assert.equal(await hasFk(f.rows), 'RESTRICT')
  })
})
