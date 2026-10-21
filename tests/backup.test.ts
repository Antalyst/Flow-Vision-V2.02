/**
 * Backups end to end (scripts/backup.ts, server/lib/backup/*) on a throwaway database and generated
 * files. LOCAL only: it creates database fv_backup_test_<random> (and restore targets next to it) on
 * the server below, and folders in the system temp directory; it removes all of them at the end.
 * It never reads .env.
 *
 *   FV_TEST_DB_PORT=3306 FV_TEST_DB_USER=root FV_TEST_DB_PASS= \
 *   FV_TEST_DUMP_BIN="C:\mariadb\bin\mariadb-dump.exe" [FV_TEST_RESTIC_BIN="C:\restic\restic.exe"] \
 *   npm run test:backup
 */
import { after, before, describe, it } from 'node:test'
import assert from 'node:assert/strict'
import crypto from 'node:crypto'
import fs from 'node:fs'
import fsp from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { spawn, execFileSync } from 'node:child_process'
import mysql from 'mysql2/promise'
import archiver from 'archiver'
import unzipper from 'unzipper'

const HOST = process.env.FV_TEST_DB_HOST ?? '127.0.0.1'
const PORT = Number(process.env.FV_TEST_DB_PORT ?? 3306)
const ROOT_USER = process.env.FV_TEST_DB_USER ?? 'root'
const ROOT_PASS = process.env.FV_TEST_DB_PASS ?? ''
const DUMP_BIN = process.env.FV_TEST_DUMP_BIN
const RESTIC_BIN = process.env.FV_TEST_RESTIC_BIN
if (!['localhost', '127.0.0.1', '::1'].includes(HOST)) {
  console.error(`Refusing ${HOST}: this test creates and drops databases. Use a local server.`)
  process.exit(1)
}
if (!DUMP_BIN || !fs.existsSync(DUMP_BIN)) {
  console.error('Set FV_TEST_DUMP_BIN to mariadb-dump.exe (or mysqldump.exe) matching the test server.')
  process.exit(1)
}

const REPO = path.resolve(import.meta.dirname, '..')
const SCRIPT = path.join(REPO, 'scripts', 'backup.ts')
const tag = crypto.randomBytes(4).toString('hex')
const DB = `fv_backup_test_${tag}`
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'fv-backup-test-'))
const dirs = {
  cwd: path.join(TMP, 'cwd'),
  uploads: path.join(TMP, 'uploads'),
  local: path.join(TMP, 'local'),
  external: path.join(TMP, 'external'),
  work: path.join(TMP, 'work'),
}
for (const d of Object.values(dirs)) fs.mkdirSync(d, { recursive: true })
// A dedicated account with a password, to prove the password never leaks.
const BK_USER = `fvbk_${tag}`
const BK_PASS = `Pw-${crypto.randomBytes(12).toString('base64url')}`

const root = await mysql.createConnection({ host: HOST, port: PORT, user: ROOT_USER, password: ROOT_PASS, multipleStatements: true })
await root.query(`CREATE DATABASE \`${DB}\` CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci`)
await root.query(`USE \`${DB}\``)
await root.query(await fsp.readFile(path.join(REPO, 'database', 'flowvision-complete-schema.sql'), 'utf8'))
await root.query(`CREATE USER '${BK_USER}'@'%' IDENTIFIED BY '${BK_PASS}'`)
await root.query(`GRANT SELECT, SHOW VIEW, TRIGGER, LOCK TABLES, EVENT ON \`${DB}\`.* TO '${BK_USER}'@'%'`)
const restoreDbs = new Set<string>()

after(async () => {
  for (const d of [DB, ...restoreDbs]) await root.query(`DROP DATABASE IF EXISTS \`${d}\``).catch(() => {})
  await root.query(`DROP USER IF EXISTS '${BK_USER}'@'%'`).catch(() => {})
  await root.end()
  await fsp.rm(TMP, { recursive: true, force: true }).catch(() => {})
})

// ---------------------------------------------------------------------------
// Fixtures: one organization, documents whose files are on disk, in file_blobs, and missing
// ---------------------------------------------------------------------------
const uuid = () => crypto.randomUUID()
const ids = { org: uuid(), user: uuid(), office: uuid(), route: uuid() }
const files = {
  pdf: { key: `${uuid()}/Leave form.pdf`, data: Buffer.concat([Buffer.from('%PDF-1.4\n'), crypto.randomBytes(2000)]) },
  docx: { key: `${uuid()}/Ñiño résumé (final).docx`, data: Buffer.concat([Buffer.from('PK\u0003\u0004'), crypto.randomBytes(5000)]) },
  scan: { key: `${uuid()}/scan.png`, data: Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), crypto.randomBytes(3 * 1024 * 1024)]) },
  knowledge: { key: `knowledge/${uuid()}/Charter.pdf`, data: Buffer.concat([Buffer.from('%PDF-1.7\n'), crypto.randomBytes(4000)]) },
  logo: { key: `org/${uuid()}/logo.png`, data: Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47]), crypto.randomBytes(500)]) },
}
const blobKey = `${uuid()}/stored in database.pdf`
const missingKey = `${uuid()}/never uploaded.pdf`
const SECRET_TEXT = `confidential-${tag}`

async function writeUpload(key: string, data: Buffer) {
  const p = path.join(dirs.uploads, ...key.split('/'))
  await fsp.mkdir(path.dirname(p), { recursive: true })
  await fsp.writeFile(p, data)
}

async function addDocument(title: string, key: string, extraFiles: string[] = []) {
  const id = uuid()
  await root.query('INSERT INTO documents (id, org_id, route_id, title, description, submitted_by, file_url) VALUES (?, ?, ?, ?, ?, ?, ?)', [id, ids.org, ids.route, title, SECRET_TEXT, ids.user, key])
  for (const [i, k] of [key, ...extraFiles].entries()) {
    await root.query('INSERT INTO document_files (id, document_id, file_url, file_name, sort_order) VALUES (?, ?, ?, ?, ?)', [uuid(), id, k, path.basename(k), i])
  }
  await root.query("INSERT INTO document_tracking (id, document_id, office_id, step_number, status) VALUES (?, ?, ?, 0, 'START')", [uuid(), id, ids.office])
  return id
}

before(async () => {
  await root.query("INSERT INTO organizations (id, name, status, logo_url) VALUES (?, 'Test City', 'active', ?)", [ids.org, files.logo.key])
  await root.query("INSERT INTO users (id, org_id, email, password_hash, account_type, status) VALUES (?, ?, 'admin@test.local', 'x', 'ADMIN', 'active')", [ids.user, ids.org])
  await root.query("INSERT INTO offices (id, org_id, name, code) VALUES (?, ?, 'Records', 'TC-REC')", [ids.office, ids.org])
  await root.query("INSERT INTO organization_routes (id, org_id, name, created_by) VALUES (?, ?, 'Main', ?)", [ids.route, ids.org, ids.user])
  for (const f of Object.values(files)) await writeUpload(f.key, f.data)
  await addDocument('Leave form', files.pdf.key, [files.docx.key, files.scan.key])
  await addDocument('Stored in the database', blobKey)
  await addDocument('Lost one', missingKey)
  // A file kept in file_blobs, in parts (the Vercel storage mode), large enough that a dump takes a moment.
  for (let part = 0; part < 6; part++) await root.query('INSERT INTO file_blobs (file_url, part, data, size, complete) VALUES (?, ?, ?, ?, 1)', [blobKey, part, crypto.randomBytes(3 * 1024 * 1024), 3 * 1024 * 1024])
  await root.query("INSERT INTO knowledge_files (id, org_id, title, file_url, file_name, file_size) VALUES (?, ?, 'Charter', ?, 'Charter.pdf', ?)", [uuid(), ids.org, files.knowledge.key, files.knowledge.data.length])
})

// ---------------------------------------------------------------------------
// Running the CLI
// ---------------------------------------------------------------------------
type Env = Record<string, string | undefined>
const baseEnv = (): Env => {
  const e: Env = { ...process.env }
  for (const k of Object.keys(e)) if (/^(DB_|BACKUP_|RESTORE_|RESTIC_|FV_TEST_)/.test(k)) delete e[k]
  return {
    ...e,
    DB_HOST: HOST,
    DB_PORT: String(PORT),
    DB_USER: BK_USER,
    DB_PASS: BK_PASS,
    DB_NAME: DB,
    UPLOAD_DIR: dirs.uploads,
    BACKUP_DIR: dirs.local,
    BACKUP_COPY_DIR: dirs.external,
    BACKUP_DUMP_BIN: DUMP_BIN,
    BACKUP_RESERVE_MB: '1',
  }
}
function cli(args: string[], env: Env = {}, { killOn = null as RegExp | null } = {}) {
  return new Promise<{ code: number | null; out: string; killed: boolean }>((resolve) => {
    const child = spawn(process.execPath, [SCRIPT, ...args], { cwd: dirs.cwd, env: { ...baseEnv(), ...env }, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true })
    let out = ''
    let killed = false
    const take = (d: Buffer) => {
      out += d
      if (killOn && !killed && killOn.test(out)) {
        killed = true
        child.kill('SIGKILL')
      }
    }
    child.stdout.on('data', take)
    child.stderr.on('data', take)
    child.on('close', (code) => resolve({ code, out, killed }))
  })
}
const packages = (dir = dirs.local) => fs.readdirSync(dir).filter((f) => /^flowvision_full_.+\.zip(\.fvenc)?$/.test(f)).sort()
const sha = (file: string) => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex')
const noSecrets = (text: string) => {
  assert.ok(!text.includes(BK_PASS), 'the database password never appears')
}

let firstPackage = ''

describe('full backup', () => {
  it('needs an initialized (marked) destination', async () => {
    const r = await cli(['full'])
    assert.equal(r.code, 1)
    assert.match(r.out, /DEST_UNMARKED/)
    assert.deepEqual(packages(), [])
    const init = await cli(['init'])
    assert.equal(init.code, 0, init.out)
  })

  it('exports the database and the uploaded files into a verified package, copied and verified on the second drive', async () => {
    const r = await cli(['full'])
    assert.equal(r.code, 0, r.out)
    noSecrets(r.out)
    assert.match(r.out, /status VERIFIED_WITH_WARNINGS/) // the one missing file
    assert.match(r.out, /copied and verified on/)
    const [pkg] = packages()
    assert.ok(pkg)
    firstPackage = pkg!
    assert.match(pkg!, /^flowvision_full_\d{4}-\d{2}-\d{2}_\d{2}-\d{2}-\d{2}\.zip$/)
    assert.equal(sha(path.join(dirs.local, pkg!)), sha(path.join(dirs.external, pkg!)), 'the external copy is identical')
    const sidecar = JSON.parse(fs.readFileSync(path.join(dirs.local, pkg!.replace('.zip', '.json')), 'utf8'))
    assert.equal(sidecar.package_sha256, sha(path.join(dirs.local, pkg!)))
    assert.equal(sidecar.copies.length, 1)
    noSecrets(JSON.stringify(sidecar))
    assert.ok(!fs.readdirSync(os.tmpdir()).some((d) => d.startsWith('fv-db-') && fs.existsSync(path.join(os.tmpdir(), d, 'client.cnf'))), 'the temporary credentials file is gone')
  })

  it('the package holds the dump, every file under its key, a manifest and checksums', async () => {
    const zip = await unzipper.Open.file(path.join(dirs.local, firstPackage))
    const names = zip.files.map((f) => f.path)
    for (const n of ['manifest.json', 'CHECKSUMS.sha256', 'RESTORE.md', 'database/flowvision.sql.gz']) assert.ok(names.includes(n), n)
    for (const f of Object.values(files)) {
      const entry = zip.files.find((e) => e.path === `files/${f.key}`)
      assert.ok(entry, `files/${f.key}`)
      assert.ok((await entry!.buffer()).equals(f.data), `content of ${f.key}`)
    }
    const manifest = JSON.parse((await zip.files.find((e) => e.path === 'manifest.json')!.buffer()).toString())
    assert.equal(manifest.format, 'flowvision-backup')
    assert.equal(manifest.format_version, 1)
    assert.match(manifest.backup_id, /^[0-9a-f-]{36}$/)
    assert.ok(manifest.database.tables.includes('documents') && manifest.database.views.length === 3)
    assert.match(manifest.database.engine, /MariaDB|MySQL/)
    assert.equal(manifest.files.in_package.length, 5)
    assert.equal(manifest.files.in_database.length, 1)
    assert.equal(manifest.files.in_database[0].bytes, 6 * 3 * 1024 * 1024)
    assert.equal(manifest.files.missing.length, 1)
    assert.equal(manifest.files.missing[0].key, missingKey)
    const sums = (await zip.files.find((e) => e.path === 'CHECKSUMS.sha256')!.buffer()).toString().trim().split('\n')
    assert.equal(sums.length, names.length - 1)
    const dump = (await zip.files.find((e) => e.path === 'database/flowvision.sql.gz')!.buffer())
    const sql = (await import('node:zlib')).gunzipSync(dump).toString('latin1')
    assert.match(sql, /-- Dump completed/)
    assert.ok(sql.includes(SECRET_TEXT), 'the dump holds the records')
    noSecrets(sql)
  })

  it('reports a referenced file that exists nowhere, and --strict refuses to keep such a backup', async () => {
    const before = packages()
    const r = await cli(['full', '--strict', '--no-copy'])
    assert.equal(r.code, 1)
    assert.match(r.out, /referenced file/)
    assert.deepEqual(packages(), before, 'nothing new was kept')
    assert.ok(!fs.readdirSync(dirs.local).some((f) => f.startsWith('.work-') || f.endsWith('.partial')), 'no leftovers')
  })
})

describe('destinations', () => {
  const freeLetter = 'QRSTUVWXYZ'.split('').find((l) => !fs.existsSync(`${l}:\\`))

  it('a missing drive is an error, never a fallback', { skip: process.platform !== 'win32' || !freeLetter }, async () => {
    const r = await cli(['full'], { BACKUP_DIR: `${freeLetter}:\\FlowVisionBackups` })
    assert.equal(r.code, 1)
    assert.match(r.out, /DRIVE_MISSING/)
    assert.ok(!fs.existsSync(`${freeLetter}:\\`))
  })

  it('a missing folder, a relative path and a folder overlapping the uploads are refused', async () => {
    assert.match((await cli(['full'], { BACKUP_DIR: path.join(TMP, 'nope') })).out, /DEST_MISSING/)
    assert.match((await cli(['full'], { BACKUP_DIR: 'backups' })).out, /absolute path/)
    assert.match((await cli(['full'], { BACKUP_DIR: dirs.uploads })).out, /DEST_UNMARKED|DEST_UNSAFE/)
  })

  it('not enough free space: refused before anything is written', async () => {
    const before = packages()
    const r = await cli(['full'], { BACKUP_RESERVE_MB: String(1024 * 1024 * 1024) })
    assert.equal(r.code, 1)
    assert.match(r.out, /NO_SPACE/)
    assert.deepEqual(packages(), before)
  })

  it('a destination this Windows account cannot write to is refused', { skip: process.platform !== 'win32' || !process.env.USERNAME }, async () => {
    const ro = path.join(TMP, 'readonly')
    fs.mkdirSync(ro)
    fs.writeFileSync(path.join(ro, '.flowvision-backup-destination'), 'x')
    execFileSync('icacls', [ro, '/deny', `${process.env.USERNAME}:(W,AD)`], { stdio: 'ignore' })
    try {
      const r = await cli(['full'], { BACKUP_DIR: ro })
      assert.equal(r.code, 1)
      assert.match(r.out, /DEST_NOT_WRITABLE/)
    } finally {
      execFileSync('icacls', [ro, '/remove:d', process.env.USERNAME!], { stdio: 'ignore' })
    }
  })

  it('when the external drive is unavailable the backup is kept locally and says so', async () => {
    const r = await cli(['full'], { BACKUP_COPY_DIR: path.join(TMP, 'unplugged') })
    assert.equal(r.code, 1, 'exit 1: not in two places')
    assert.match(r.out, /ON THIS COMPUTER ONLY/)
    const newest = packages().at(-1)!
    const v = await cli(['verify', newest.replace(/\.zip$/, '')])
    assert.equal(v.code, 0, v.out)
    const c = await cli(['copy', newest.replace(/\.zip$/, '')])
    assert.equal(c.code, 0, c.out)
    assert.equal(sha(path.join(dirs.external, newest)), sha(path.join(dirs.local, newest)))
  })

  it('an existing different file at the destination is never overwritten', async () => {
    const name = packages().at(-1)!
    const fresh = path.join(TMP, 'external2')
    fs.mkdirSync(fresh)
    fs.writeFileSync(path.join(fresh, '.flowvision-backup-destination'), 'x')
    fs.writeFileSync(path.join(fresh, name), 'something else')
    const r = await cli(['copy', name.replace(/\.zip$/, '')], { BACKUP_COPY_DIR: fresh })
    assert.equal(r.code, 1)
    assert.match(r.out, /DEST_CONFLICT/)
    assert.equal(fs.readFileSync(path.join(fresh, name), 'utf8'), 'something else')
  })
})

describe('interruptions and concurrency', () => {
  it('a backup killed half-way leaves no package, keeps the earlier ones, and the next run cleans up', async () => {
    const before = packages().map((p) => [p, sha(path.join(dirs.local, p))])
    const r = await cli(['full', '--no-copy'], {}, { killOn: /Exporting the database/ })
    assert.ok(r.killed, 'the run was interrupted')
    assert.deepEqual(packages(), before.map(([p]) => p), 'no new package')
    for (const [p, h] of before) assert.equal(sha(path.join(dirs.local, p!)), h, 'earlier backups unchanged')
    const again = await cli(['full', '--no-copy'])
    assert.equal(again.code, 0, again.out)
    assert.ok(!fs.readdirSync(dirs.local).some((f) => f.startsWith('.work-') || f.endsWith('.partial') || f === '.flowvision-backup.lock'), 'leftovers and the stale lock are gone')
  })

  it('two backups started together: one runs, the other is refused', async () => {
    const [a, b] = await Promise.all([cli(['full', '--no-copy']), cli(['full', '--no-copy'])])
    const codes = [a.code, b.code].sort()
    assert.deepEqual(codes, [0, 1], `${a.out}\n---\n${b.out}`)
    assert.match((a.code ? a : b).out, /BUSY/)
  })
})

describe('corrupted or incomplete packages are rejected', () => {
  const copyOf = (name: string) => {
    const p = path.join(dirs.work, name)
    fs.copyFileSync(path.join(dirs.local, firstPackage), p)
    return p
  }

  it('a changed byte', async () => {
    const p = copyOf('flipped.zip')
    const buf = fs.readFileSync(p)
    const at = buf.indexOf(Buffer.from('%PDF-1.4')) + 100
    buf[at] = buf[at]! ^ 0xff
    fs.writeFileSync(p, buf)
    const r = await cli(['verify', p])
    assert.equal(r.code, 1)
    assert.match(r.out, /Checksum mismatch|VERIFICATION FAILED/)
  })

  it('a truncated package', async () => {
    const p = copyOf('truncated.zip')
    fs.truncateSync(p, Math.floor(fs.statSync(p).size / 2))
    const r = await cli(['verify', p])
    assert.equal(r.code, 1)
  })

  it('a package whose manifest was edited, or with an extra or unsafe entry', async () => {
    const src = await unzipper.Open.file(path.join(dirs.local, firstPackage))
    const rebuild = async (file: string, edit: (name: string, data: Buffer) => Buffer | null, extra: Array<[string, Buffer]> = []) => {
      await new Promise<void>(async (resolve, reject) => {
        const out = fs.createWriteStream(file)
        const z = archiver('zip', { store: true })
        out.on('close', () => resolve())
        z.on('error', reject)
        z.pipe(out)
        for (const e of src.files) {
          const data = edit(e.path, await e.buffer())
          if (data) (z as any).append(data, { name: e.path })
        }
        for (const [n, d] of extra) (z as any).append(d, { name: n })
        void z.finalize()
      })
    }
    const edited = path.join(dirs.work, 'edited.zip')
    await rebuild(edited, (n, d) => (n === 'manifest.json' ? Buffer.from(d.toString().replace('"format_version": 1', '"format_version": 1 ')) : d))
    assert.equal((await cli(['verify', edited])).code, 1, 'edited manifest')
    const extra = path.join(dirs.work, 'extra.zip')
    await rebuild(extra, (_n, d) => d, [['files/../../evil.txt', Buffer.from('x')]])
    const r = await cli(['verify', extra])
    assert.equal(r.code, 1)
    assert.match(r.out, /unsafe|not covered/i)
    const dropped = path.join(dirs.work, 'dropped.zip')
    await rebuild(dropped, (n, d) => (n.startsWith('files/knowledge/') ? null : d))
    assert.match((await cli(['verify', dropped])).out, /Missing component/)
  })
})

describe('encryption', () => {
  const passFile = path.join(TMP, 'passphrase.txt')
  let encName = ''

  it('an encrypted package hides its contents and verifies only with the passphrase', async () => {
    fs.writeFileSync(passFile, crypto.randomBytes(24).toString('base64url'))
    const r = await cli(['full', '--no-copy'], { BACKUP_PASSPHRASE_FILE: passFile })
    assert.equal(r.code, 0, r.out)
    encName = packages().find((p) => p.endsWith('.fvenc'))!
    assert.ok(encName)
    const bytes = fs.readFileSync(path.join(dirs.local, encName))
    assert.equal(bytes.subarray(0, 8).toString(), 'FVBKENC1')
    assert.ok(!bytes.includes(Buffer.from('manifest.json')) && !bytes.includes(files.pdf.data.subarray(10, 60)), 'no plaintext inside')
    const withPass = await cli(['verify', encName.replace('.zip.fvenc', '')], { BACKUP_PASSPHRASE_FILE: passFile })
    assert.equal(withPass.code, 0, withPass.out)
    assert.match(withPass.out, /every checksum/)
    const without = await cli(['verify', encName.replace('.zip.fvenc', '')])
    assert.equal(without.code, 0)
    assert.match(without.out, /file checksum verified/)
    const wrongFile = path.join(TMP, 'wrong.txt')
    fs.writeFileSync(wrongFile, crypto.randomBytes(24).toString('base64url'))
    const copy = path.join(dirs.work, 'enc.zip.fvenc')
    fs.copyFileSync(path.join(dirs.local, encName), copy)
    const wrong = await cli(['verify', copy], { BACKUP_PASSPHRASE_FILE: wrongFile })
    assert.equal(wrong.code, 1)
    assert.match(wrong.out, /wrong passphrase|corrupted/)
    const buf = fs.readFileSync(copy)
    buf[buf.length - 40] = buf[buf.length - 40]! ^ 1
    fs.writeFileSync(copy, buf)
    assert.equal((await cli(['verify', copy], { BACKUP_PASSPHRASE_FILE: passFile })).code, 1, 'tampered')
    fs.writeFileSync(copy, fs.readFileSync(path.join(dirs.local, encName)).subarray(0, 100_000))
    assert.equal((await cli(['verify', copy], { BACKUP_PASSPHRASE_FILE: passFile })).code, 1, 'truncated')
  })

  it('an encrypted package restores with the passphrase', async () => {
    const target = `${DB}_enc`
    restoreDbs.add(target)
    const r = await cli(['restore', '--package', encName.replace('.zip.fvenc', ''), '--files-dir', path.join(TMP, 'restore-enc')], { BACKUP_PASSPHRASE_FILE: passFile, ...restoreEnv(target) })
    assert.equal(r.code, 0, r.out)
    assert.match(r.out, /all checks passed/)
  })
})

function restoreEnv(name: string): Env {
  return { RESTORE_DB_HOST: HOST, RESTORE_DB_PORT: String(PORT), RESTORE_DB_USER: ROOT_USER, RESTORE_DB_PASS: ROOT_PASS, RESTORE_DB_NAME: name }
}

describe('restore', () => {
  const target = `${DB}_restore`
  const filesDir = path.join(TMP, 'restored-files')

  it('into an isolated database: data, views, files and every document-to-file link check out', async () => {
    restoreDbs.add(target)
    const sourceBefore = await root.query(`CHECKSUM TABLE \`${DB}\`.documents, \`${DB}\`.document_files, \`${DB}\`.file_blobs EXTENDED`)
    const r = await cli(['restore', '--package', firstPackage.replace('.zip', ''), '--files-dir', filesDir], restoreEnv(target))
    assert.equal(r.code, 0, r.out)
    assert.match(r.out, /all checks passed/)
    assert.match(r.out, /5 file\(s\) restored to the files folder and checked, 1 in the database/)
    noSecrets(r.out)
    for (const f of Object.values(files)) assert.ok(fs.readFileSync(path.join(filesDir, ...f.key.split('/'))).equals(f.data), f.key)
    const [[blob]] = (await root.query(`SELECT SUM(size) AS n FROM \`${target}\`.file_blobs WHERE file_url = ?`, [blobKey])) as any
    assert.equal(Number(blob.n), 6 * 3 * 1024 * 1024)
    const [[view]] = (await root.query(`SELECT COUNT(*) AS n FROM \`${target}\`.active_documents_by_office`)) as any
    assert.ok(Number(view.n) >= 0, 'views work')
    assert.deepEqual(await root.query(`CHECKSUM TABLE \`${DB}\`.documents, \`${DB}\`.document_files, \`${DB}\`.file_blobs EXTENDED`), sourceBefore, 'the source database is untouched')
  })

  it('the post-restore check notices a lost or changed file', async () => {
    const { verifyRestore } = await import('../server/lib/backup/restore.ts')
    const zip = await unzipper.Open.file(path.join(dirs.local, firstPackage))
    const manifest = JSON.parse((await zip.files.find((e) => e.path === 'manifest.json')!.buffer()).toString())
    const t = { host: HOST, port: PORT, user: ROOT_USER, password: ROOT_PASS, name: target }
    assert.equal((await verifyRestore(manifest, t, filesDir)).ok, true)
    const p = path.join(filesDir, ...files.docx.key.split('/'))
    fs.appendFileSync(p, 'x')
    const changed = await verifyRestore(manifest, t, filesDir)
    assert.equal(changed.ok, false)
    assert.ok(changed.errors.some((e) => /checksum/.test(e)))
    // A different file is deleted: Windows can keep a just-modified file "delete pending" while an
    // antivirus scanner still has it open.
    const gone = path.join(filesDir, ...files.knowledge.key.split('/'))
    fs.rmSync(gone)
    for (let i = 0; i < 50 && fs.existsSync(gone); i++) await new Promise((r) => setTimeout(r, 100))
    const lost = await verifyRestore(manifest, t, filesDir)
    assert.ok(lost.errors.some((e) => /knowledge_files .* is missing after the restore/.test(e)), JSON.stringify(lost.errors))
  })

  it('refuses: a non-empty database, a non-empty files folder, a remote server, the live database, and --replace without a terminal', async () => {
    const pkg = firstPackage.replace('.zip', '')
    assert.match((await cli(['restore', '--package', pkg, '--files-dir', path.join(TMP, 'r2')], restoreEnv(target))).out, /TARGET_NOT_EMPTY/)
    const other = `${DB}_restore2`
    restoreDbs.add(other)
    fs.mkdirSync(path.join(TMP, 'r3'))
    fs.writeFileSync(path.join(TMP, 'r3', 'keep.txt'), 'x')
    assert.match((await cli(['restore', '--package', pkg, '--files-dir', path.join(TMP, 'r3')], restoreEnv(other))).out, /not empty/)
    assert.equal(fs.readFileSync(path.join(TMP, 'r3', 'keep.txt'), 'utf8'), 'x')
    assert.match((await cli(['restore', '--package', pkg, '--files-dir', path.join(TMP, 'r4')], { ...restoreEnv(other), RESTORE_DB_HOST: 'db.example.invalid' })).out, /REMOTE_TARGET/)
    assert.match((await cli(['restore', '--package', pkg, '--files-dir', path.join(TMP, 'r5')], { ...restoreEnv(DB) })).out, /LIVE_TARGET/)
    assert.match((await cli(['restore', '--package', pkg, '--files-dir', path.join(TMP, 'r6'), '--replace'], restoreEnv(target))).out, /CONFIRM/)
    const [[still]] = (await root.query(`SELECT COUNT(*) AS n FROM \`${DB}\`.documents`)) as any
    assert.equal(Number(still.n), 3, 'the source database still has its documents')
  })
})

describe('versioned snapshots (Restic)', { skip: !RESTIC_BIN && 'set FV_TEST_RESTIC_BIN to run' }, () => {
  const repoEnv = (): Env => ({ BACKUP_RESTIC_BIN: RESTIC_BIN, RESTIC_REPOSITORY: path.join(dirs.external, 'restic-repo'), RESTIC_PASSWORD_FILE: path.join(TMP, 'restic-pass.txt') })
  let first = ''

  it('a missing repository drive is an error', { skip: process.platform !== 'win32' }, async () => {
    fs.writeFileSync(path.join(TMP, 'restic-pass.txt'), crypto.randomBytes(24).toString('base64url'))
    const free = 'QRSTUVWXYZ'.split('').find((l) => !fs.existsSync(`${l}:\\`))
    if (!free) return
    const r = await cli(['snapshot'], { ...repoEnv(), RESTIC_REPOSITORY: `${free}:\\restic` })
    assert.equal(r.code, 1)
    assert.match(r.out, /DRIVE_MISSING/)
  })

  it('daily snapshots are verified logical full backups; later ones store only what changed', async () => {
    fs.writeFileSync(path.join(TMP, 'restic-pass.txt'), crypto.randomBytes(24).toString('base64url'))
    assert.equal((await cli(['init'], repoEnv())).code, 0)
    const a = await cli(['snapshot'], repoEnv())
    assert.equal(a.code, 0, a.out)
    assert.match(a.out, /restore-tested: yes/)
    first = /snapshot ([0-9a-f]{8}) saved/.exec(a.out)![1]!
    await root.query(`INSERT INTO \`${DB}\`.organization_holidays (id, org_id, holiday_date, name) VALUES (?, ?, '2026-12-30', 'Added after the first snapshot')`, [uuid(), ids.org])
    const b = await cli(['snapshot'], repoEnv())
    assert.equal(b.code, 0, b.out)
    const [, logical, added] = /logical size ([\d.]+) MB; added to the repository: ([\d.]+) MB/.exec(b.out)!
    assert.ok(Number(added) < Number(logical) / 2, `the second snapshot stores much less than a full copy (${added} of ${logical} MB)`)
  })

  it('an earlier version can be restored and is the earlier data', async () => {
    const dir = path.join(TMP, 'snap-old')
    const r = await cli(['restore-snapshot', '--snapshot', first, '--target', dir], repoEnv())
    assert.equal(r.code, 0, r.out)
    const sql = fs.readFileSync(path.join(dir, 'database', 'flowvision.sql'), 'latin1')
    assert.ok(!sql.includes('Added after the first snapshot'))
    const target = `${DB}_snap`
    restoreDbs.add(target)
    const restored = await cli(['restore', '--package', dir, '--files-dir', path.join(TMP, 'snap-files')], restoreEnv(target))
    assert.equal(restored.code, 0, restored.out)
  })

  it('retention never removes the newest snapshot, and is refused until the newest passed its restore test', async () => {
    const ok = await cli(['forget'], { ...repoEnv(), BACKUP_RETAIN_DAILY: '1', BACKUP_RETAIN_WEEKLY: '1', BACKUP_RETAIN_MONTHLY: '1' })
    assert.equal(ok.code, 0, ok.out)
    const list = await cli(['snapshots'], repoEnv())
    assert.ok(list.out.trim().split('\n').length >= 1)
    const statusFile = path.join(dirs.local, 'restic-status.json')
    const status = JSON.parse(fs.readFileSync(statusFile, 'utf8'))
    status.verified = {}
    fs.writeFileSync(statusFile, JSON.stringify(status))
    const refused = await cli(['forget'], repoEnv())
    assert.equal(refused.code, 1)
    assert.match(refused.out, /NOT_VERIFIED/)
    assert.equal((await cli(['check'], repoEnv())).code, 0)
  })
})
