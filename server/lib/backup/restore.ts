import crypto from 'node:crypto'
import fs from 'node:fs'
import fsp from 'node:fs/promises'
import path from 'node:path'
import zlib from 'node:zlib'
import { Writable } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import { BackupError } from './config.ts'
import { blobIndex, clientTool, connect, fileReferences, rowCounts, runSql, serverInfo, type DbTarget } from './database.ts'
import { hasher, isStorageKey, openPackage, safeEntry, verifyReader, type Manifest } from './package.ts'

/**
 * Restore a package into a database and a files folder, then prove it worked. Refuses, unless told
 * otherwise explicitly: a non-empty target database, a non-empty files folder, a remote target, and
 * the live database (DB_*). The caller (scripts/backup.ts) asks the operator to confirm.
 */

const LOCAL = new Set(['localhost', '127.0.0.1', '::1'])

export interface RestoreOptions {
  location: string
  passphrase: string | null
  scratchDir: string
  target: DbTarget
  filesDir: string | null
  /** Drop everything in the target database first (confirmed by the operator). */
  replace: boolean
  allowRemote: boolean
  /** The target is the live database and the operator confirmed it. */
  liveConfirmed: boolean
  live: DbTarget
  clientBin: string | null
  dumpBin: string | null
  onStep?: (s: string) => void
}

const sameDb = (a: DbTarget, b: DbTarget) => a.host.toLowerCase() === b.host.toLowerCase() && Number(a.port) === Number(b.port) && a.name === b.name

/** Magic bytes of common document types: a restored file of that type must start with them. */
const MAGIC: Array<[RegExp, number[]]> = [
  [/\.pdf$/i, [0x25, 0x50, 0x44, 0x46]],
  [/\.png$/i, [0x89, 0x50, 0x4e, 0x47]],
  [/\.jpe?g$/i, [0xff, 0xd8, 0xff]],
  [/\.(docx|xlsx|pptx|zip)$/i, [0x50, 0x4b]],
]

async function looksOpenable(file: string) {
  const rule = MAGIC.find(([re]) => re.test(file))
  if (!rule) return true
  const fd = await fsp.open(file, 'r')
  const head = Buffer.alloc(rule[1].length)
  await fd.read(head, 0, head.length, 0)
  await fd.close()
  return rule[1].every((b, i) => head[i] === b)
}

export async function restoreBackup(o: RestoreOptions) {
  const step = o.onStep ?? (() => {})
  if (!LOCAL.has(o.target.host) && !o.allowRemote) throw new BackupError('REMOTE_TARGET', `Refusing to restore into the remote server ${o.target.host}. Restore into a local, isolated database first; add --remote only for a real recovery.`)
  if (sameDb(o.target, o.live) && !o.liveConfirmed) throw new BackupError('LIVE_TARGET', 'The restore target is the live database (DB_*). That needs --replace and the typed confirmation.')

  step('Verifying the package')
  const reader = await openPackage(o.location, { passphrase: o.passphrase, scratchDir: o.scratchDir })
  try {
    const v = await verifyReader(reader)
    if (!v.ok || !v.manifest) throw new BackupError('VERIFY_FAILED', `The package failed verification: ${v.errors.slice(0, 5).join('; ')}`)
    const m = v.manifest

    step('Checking the target')
    const admin = await connect(o.target, { database: false }).catch((err) => {
      throw new BackupError('DB_CONNECT', `Cannot connect to the restore target (${(err as { code?: string }).code ?? 'error'}). Check RESTORE_DB_*.`)
    })
    let tableCount = 0
    try {
      const server = await serverInfo(admin)
      if (server.engine !== m.database.engine) throw new BackupError('INCOMPATIBLE', `The backup is from ${m.database.engine} but the target is ${server.engine} ${server.version}`)
      if (server.major < Number(m.database.server_version.split('.')[0])) {
        throw new BackupError('INCOMPATIBLE', `The target (${server.version}) is older than the backup's server (${m.database.server_version}); restore onto ${m.database.engine} ${m.database.server_version.split('.')[0]}.x or newer`)
      }
      const [exists] = (await admin.query('SELECT SCHEMA_NAME FROM information_schema.SCHEMATA WHERE SCHEMA_NAME = ?', [o.target.name])) as unknown as [unknown[]]
      if (exists.length) {
        const [objs] = (await admin.query('SELECT TABLE_NAME AS t, TABLE_TYPE AS k FROM information_schema.TABLES WHERE TABLE_SCHEMA = ?', [o.target.name])) as unknown as [Array<{ t: string; k: string }>]
        tableCount = objs.length
        if (objs.length && !o.replace) throw new BackupError('TARGET_NOT_EMPTY', `The target database ${o.target.name} is not empty (${objs.length} tables/views). Use an empty one, or --replace with confirmation.`)
        if (objs.length) {
          step(`Removing the ${objs.length} existing tables and views of ${o.target.name}`)
          await admin.query(`USE \`${o.target.name.replace(/`/g, '``')}\``)
          await admin.query('SET FOREIGN_KEY_CHECKS = 0')
          for (const x of objs) await admin.query(`DROP ${x.k === 'VIEW' ? 'VIEW' : 'TABLE'} IF EXISTS \`${x.t.replace(/`/g, '``')}\``)
          await admin.query('SET FOREIGN_KEY_CHECKS = 1')
        }
      } else {
        await admin.query(`CREATE DATABASE \`${o.target.name.replace(/`/g, '``')}\` CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci`)
      }
    } finally {
      await admin.end().catch(() => {})
    }

    // Files first into a hidden folder, renamed into place once complete.
    let filesStaging: string | null = null
    if (m.files.in_package.length) {
      if (!o.filesDir) throw new BackupError('FILES_DIR', `This backup holds ${m.files.in_package.length} uploaded file(s): give an empty folder with --files-dir`)
      const existing = await fsp.readdir(o.filesDir).catch(() => null)
      if (existing && existing.length) throw new BackupError('FILES_DIR', 'The --files-dir folder is not empty; files are never restored over existing ones')
      filesStaging = path.join(path.dirname(path.resolve(o.filesDir)), `.restore-${crypto.randomUUID()}`)
      step(`Extracting ${m.files.in_package.length} file(s)`)
      try {
        for (const f of m.files.in_package) {
          if (!safeEntry(f.path) || !isStorageKey(f.key)) throw new BackupError('BAD_PACKAGE', 'Unsafe file path in the package')
          const dst = path.join(filesStaging, ...f.key.split('/'))
          if (!path.resolve(dst).startsWith(path.resolve(filesStaging) + path.sep)) throw new BackupError('BAD_PACKAGE', 'Unsafe file path in the package')
          await fsp.mkdir(path.dirname(dst), { recursive: true })
          const h = hasher()
          await pipeline(await reader.open(f.path), h.stream, fs.createWriteStream(dst))
          if (h.result().sha256 !== f.sha256) throw new BackupError('CHECKSUM', `A restored file does not match its checksum (${f.referenced_by[0]?.table} ${f.referenced_by[0]?.id})`)
        }
        if (existing) await fsp.rmdir(o.filesDir)
        await fsp.rename(filesStaging, o.filesDir)
        filesStaging = null
      } finally {
        if (filesStaging) await fsp.rm(filesStaging, { recursive: true, force: true }).catch(() => {})
      }
    }

    step('Loading the database')
    const tool = await clientTool(o.clientBin, o.dumpBin, m.database.engine)
    const dump = await reader.open(m.database.dump_file)
    await runSql(tool, o.target, m.database.compression === 'gzip' ? dump.pipe(zlib.createGunzip()) : dump)

    step('Checking the restored data')
    const check = await verifyRestore(m, o.target, o.filesDir)
    return { manifest: m, replacedObjects: tableCount, check }
  } finally {
    await reader.close()
  }
}

/**
 * After a restore: every table and view is there with the row counts of the backup, the schema
 * matches, every document/knowledge/logo record still finds its file (on disk with the same
 * SHA-256 and a valid file signature, or in file_blobs with the same size), and the tracking
 * history is complete.
 */
export async function verifyRestore(m: Manifest, target: DbTarget, filesDir: string | null) {
  const errors: string[] = []
  const notes: string[] = []
  const c = await connect(target)
  try {
    const [objs] = (await c.query('SELECT TABLE_NAME AS t, TABLE_TYPE AS k FROM information_schema.TABLES WHERE TABLE_SCHEMA = ?', [target.name])) as unknown as [Array<{ t: string; k: string }>]
    const tables = objs.filter((x) => x.k === 'BASE TABLE').map((x) => x.t)
    const views = objs.filter((x) => x.k === 'VIEW').map((x) => x.t)
    for (const t of m.database.tables) if (!tables.includes(t)) errors.push(`Table missing after restore: ${t}`)
    for (const v of m.database.views) if (!views.includes(v)) errors.push(`View missing after restore: ${v}`)
    for (const v of views) {
      try {
        await c.query(`SELECT 1 FROM \`${v.replace(/`/g, '``')}\` LIMIT 1`)
      } catch (err) {
        errors.push(`View ${v} does not work: ${(err as Error).message}`)
      }
    }
    const [cols] = await c.query(
      'SELECT TABLE_NAME, COLUMN_NAME, COLUMN_TYPE, IS_NULLABLE FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = ? ORDER BY TABLE_NAME, ORDINAL_POSITION',
      [target.name],
    )
    if (crypto.createHash('sha256').update(JSON.stringify(cols)).digest('hex') !== m.database.schema_fingerprint) errors.push('The restored schema differs from the backed-up one (column fingerprint)')

    const counts = await rowCounts(c, m.database.tables.filter((t) => tables.includes(t)))
    let rows = 0
    for (const [t, { before, after }] of Object.entries(m.database.row_counts)) {
      const n = counts[t]
      if (n === undefined) continue
      rows += n
      const lo = Math.min(before, after)
      const hi = Math.max(before, after)
      if (n < lo || n > hi) errors.push(`Row count of ${t}: ${n}, expected ${before === after ? before : `${lo}–${hi}`}`)
    }
    notes.push(`${tables.length} tables, ${views.length} views, ${rows} rows`)

    // Document-to-file links, from the restored database itself.
    const refs = await fileReferences(c, tables)
    const blobs = await blobIndex(c, tables)
    const inPackage = new Map(m.files.in_package.map((f) => [f.key, f]))
    const knownMissing = new Set(m.files.missing.map((f) => f.key))
    let onDisk = 0
    let inDb = 0
    const checked = new Set<string>()
    for (const r of refs) {
      if (!isStorageKey(r.key) || checked.has(r.key)) continue
      checked.add(r.key)
      const f = inPackage.get(r.key)
      const file = filesDir ? path.join(filesDir, ...r.key.split('/')) : null
      if (f && file && fs.existsSync(file)) {
        const h = hasher()
        await pipeline(fs.createReadStream(file), h.stream, new Writable({ write: (_c, _e, cb) => cb() }))
        if (h.result().sha256 !== f.sha256) errors.push(`File of ${r.table} ${r.id} does not match its checksum`)
        else if (!(await looksOpenable(file))) errors.push(`File of ${r.table} ${r.id} is not a valid ${path.extname(file)} file`)
        else onDisk++
      } else if (blobs.has(r.key)) {
        const expect = m.files.in_database.find((x) => x.key === r.key)
        if (expect && (expect.bytes !== blobs.get(r.key)!.bytes || expect.parts !== blobs.get(r.key)!.parts)) errors.push(`Stored file of ${r.table} ${r.id} (file_blobs) has a different size than at backup time`)
        else inDb++
      } else if (knownMissing.has(r.key)) {
        notes.push(`File of ${r.table} ${r.id} was already missing when the backup was made`)
      } else {
        errors.push(`File of ${r.table} ${r.id} is missing after the restore`)
      }
    }
    notes.push(`${onDisk} file(s) restored to the files folder and checked, ${inDb} in the database (file_blobs)`)

    if (tables.includes('document_tracking') && tables.includes('documents')) {
      const [[{ orphans }]] = (await c.query('SELECT COUNT(*) AS orphans FROM document_tracking t LEFT JOIN documents d ON d.id = t.document_id WHERE d.id IS NULL')) as unknown as [[{ orphans: number }]]
      if (Number(orphans)) errors.push(`${orphans} tracking rows point at no document`)
      notes.push(`Tracking history: ${counts.document_tracking ?? 0} visit rows for ${counts.documents ?? 0} documents`)
    }
    return { ok: !errors.length, errors, notes }
  } finally {
    await c.end().catch(() => {})
  }
}
