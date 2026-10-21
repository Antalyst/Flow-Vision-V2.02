import crypto from 'node:crypto'
import fs from 'node:fs'
import fsp from 'node:fs/promises'
import path from 'node:path'
import zlib from 'node:zlib'
import { PassThrough } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import archiver from 'archiver'
import { acquireLock, assertSpace, BackupError, checkDestination, labelOf, NAME_RE, readConfig, readPassphrase, type BackupConfig } from './config.ts'
import { encryptStream } from './crypto.ts'
import { blobIndex, connect, dumpTool, fileReferences, inventory, rowCounts, runDump, serverInfo, type DbTarget, type FileRef } from './database.ts'
import { FORMAT, FORMAT_VERSION, hasher, isStorageKey, openPackage, restoreGuide, sha256File, verifyPackage, verifyReader, type Manifest, type ManifestFile } from './package.ts'

/**
 * Full backups: a consistent database dump plus every uploaded file the database points at, packed,
 * checksummed, verified, and only then given its final name. A failed run leaves the previous
 * backups untouched and removes its own temporary files.
 */

export type Status = 'VERIFIED' | 'VERIFIED_WITH_WARNINGS' | 'FAILED'

export interface Sidecar {
  format: typeof FORMAT
  name: string
  backup_id: string
  type: 'full'
  created_at: string
  package_file: string
  package_bytes: number
  package_sha256: string
  encrypted: boolean
  status: Status
  warnings: string[]
  summary: { engine: string; server_version: string; tables: number; rows: number; files_in_package: number; files_in_database: number; files_missing: number }
  last_verify: { at: string; ok: boolean; deep: boolean; errors: string[] }
  copies: Array<{ destination: string; verified_at: string; sha256: string }>
}

export interface FullResult {
  name: string
  file: string
  sidecar: Sidecar
  copy: { attempted: boolean; ok: boolean; destination: string | null; error: string | null }
}

const pad = (n: number) => String(n).padStart(2, '0')
const stamp = (d: Date) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}_${pad(d.getHours())}-${pad(d.getMinutes())}-${pad(d.getSeconds())}`

async function uniqueName(dir: string, at: Date) {
  const base = `flowvision_full_${stamp(at)}`
  for (let i = 1; i < 100; i++) {
    const name = i === 1 ? base : `${base}-${i}`
    const taken = ['.zip', '.zip.fvenc', '.json'].some((ext) => fs.existsSync(path.join(dir, name + ext)))
    if (!taken) return name
  }
  throw new BackupError('NAME', 'Could not choose a unique backup name')
}

/** Leftovers of a run that crashed (only our own temporary names; called while holding the lock). */
async function removeLeftovers(dir: string) {
  for (const e of await fsp.readdir(dir)) {
    if (/^\.work-[0-9a-f-]{36}$/.test(e) || /^\.flowvision_full_.+\.partial$/.test(e) || /^\.decrypt-[0-9a-f-]{36}\.zip$/.test(e)) {
      await fsp.rm(path.join(dir, e), { recursive: true, force: true })
    }
  }
}

function gitCommit() {
  try {
    const head = fs.readFileSync(path.join(process.cwd(), '.git', 'HEAD'), 'utf8').trim()
    if (!head.startsWith('ref: ')) return head.slice(0, 40)
    const ref = head.slice(5)
    const loose = path.join(process.cwd(), '.git', ...ref.split('/'))
    if (fs.existsSync(loose)) return fs.readFileSync(loose, 'utf8').trim()
    const packed = fs.readFileSync(path.join(process.cwd(), '.git', 'packed-refs'), 'utf8')
    return packed.split('\n').find((l) => l.endsWith(` ${ref}`))?.split(' ')[0] ?? null
  } catch {
    return null
  }
}

function latestMigration() {
  try {
    const files = fs.readdirSync(path.join(process.cwd(), 'database', 'migrations')).filter((f) => f.endsWith('.sql') && !f.includes('.rollback.'))
    return files.sort().at(-1)?.replace(/\.sql$/, '') ?? null
  } catch {
    return null
  }
}

async function schemaFingerprint(conn: Awaited<ReturnType<typeof connect>>, db: string) {
  const [cols] = await conn.query(
    'SELECT TABLE_NAME, COLUMN_NAME, COLUMN_TYPE, IS_NULLABLE FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = ? ORDER BY TABLE_NAME, ORDINAL_POSITION',
    [db],
  )
  return crypto.createHash('sha256').update(JSON.stringify(cols)).digest('hex')
}

/** Copy a file, hashing it; retried once if the source changed while being read. */
async function copyStable(src: string, dst: string) {
  for (let attempt = 0; attempt < 2; attempt++) {
    const before = await fsp.stat(src)
    await fsp.mkdir(path.dirname(dst), { recursive: true })
    const h = hasher()
    await pipeline(fs.createReadStream(src), h.stream, fs.createWriteStream(dst))
    const after = await fsp.stat(src)
    const r = h.result()
    if (before.size === after.size && before.mtimeMs === after.mtimeMs && r.bytes === after.size) return { ...r, stable: true }
    if (attempt === 1) return { ...r, stable: false }
  }
  throw new Error('unreachable')
}

const groupRefs = (refs: FileRef[]) => {
  const map = new Map<string, Array<{ table: string; id: string }>>()
  for (const r of refs) {
    const list = map.get(r.key) ?? []
    if (!list.some((x) => x.table === r.table && x.id === r.id)) list.push({ table: r.table, id: r.id })
    map.set(r.key, list)
  }
  return map
}

async function writeJsonAtomic(file: string, data: unknown) {
  const tmp = `${file}.tmp-${process.pid}`
  await fsp.writeFile(tmp, JSON.stringify(data, null, 2))
  await fsp.rename(tmp, file)
}

async function fsyncFile(file: string) {
  const fd = await fsp.open(file, 'r+')
  try {
    await fd.sync()
  } finally {
    await fd.close()
  }
}

export interface BuildOptions {
  db: DbTarget
  cfg?: BackupConfig
  /** 'zip' = a package file in BACKUP_DIR; 'dir' = an unpacked folder for Restic (uncompressed dump). */
  form?: 'zip' | 'dir'
  /** For form 'dir': the folder to create (must not exist). */
  dirTarget?: string
  copy?: boolean
  strict?: boolean
  onStep?: (step: string) => void
}

/**
 * Consistency: the dump is one transaction (--single-transaction; every table is InnoDB). Files are
 * written once under a new key and never changed in place, so a file read later is the file the
 * dump points at. The file list is read before AND after the dump and both are copied, so a row
 * added during the dump still gets its file; a file deleted meanwhile is reported as missing.
 */
export async function buildBackup(opts: BuildOptions) {
  const cfg = opts.cfg ?? readConfig()
  const form = opts.form ?? 'zip'
  const step = opts.onStep ?? (() => {})
  if (!cfg.dir) throw new BackupError('NOT_CONFIGURED', 'BACKUP_DIR is not set: choose a backup folder (see docs/BACKUP_AND_RECOVERY.md)')
  await checkDestination(cfg.dir, 'Backup folder (BACKUP_DIR)')
  const release = await acquireLock(cfg.dir, form === 'zip' ? 'full backup' : 'snapshot')
  const id = crypto.randomUUID()
  const createdAt = new Date()
  const work = path.join(cfg.dir, `.work-${id}`)
  let partial: string | null = null
  let conn: Awaited<ReturnType<typeof connect>> | null = null
  let finished = false
  try {
    await removeLeftovers(cfg.dir)
    const name = await uniqueName(cfg.dir, createdAt)
    const passphrase = form === 'zip' ? await readPassphrase(cfg) : null
    const warnings: string[] = []

    step('Connecting to the database')
    conn = await connect(opts.db).catch((err) => {
      throw new BackupError('DB_CONNECT', `Cannot connect to the database (${(err as { code?: string }).code ?? 'error'}). Check DB_HOST, DB_PORT, DB_USER, DB_PASS and DB_NAME.`)
    })
    const server = await serverInfo(conn)
    const { tool, warnings: toolWarnings } = await dumpTool(cfg.dumpBin, server)
    warnings.push(...toolWarnings)
    const inv = await inventory(conn, opts.db.name)
    const tables = inv.tables.map((t) => t.name)
    if (!tables.length) throw new BackupError('EMPTY_DB', 'The database has no tables: is DB_NAME right?')
    const nonTx = inv.tables.filter((t) => t.engine && !['InnoDB', 'Aria'].includes(t.engine))
    if (nonTx.length) warnings.push(`Tables not covered by the transactional snapshot: ${nonTx.map((t) => `${t.name} (${t.engine})`).join(', ')}`)
    if (inv.routines && !cfg.dumpRoutines) warnings.push(`${inv.routines} stored routine(s) not included (BACKUP_DUMP_ROUTINES=false)`)
    if (inv.events && !cfg.dumpEvents) warnings.push(`${inv.events} event(s) not included (set BACKUP_DUMP_EVENTS=true)`)

    const refsBefore = await fileReferences(conn, tables)
    const countsBefore = await rowCounts(conn, tables)
    let diskBytes = 0
    for (const r of refsBefore) {
      if (!isStorageKey(r.key)) continue
      const s = await fsp.stat(path.join(cfg.uploadDir, ...r.key.split('/'))).catch(() => null)
      if (s?.isFile()) diskBytes += s.size
    }
    // Work folder + package (+ encrypted copy), next to each other on the backup drive.
    await assertSpace(cfg.dir, (inv.bytes + diskBytes) * (passphrase ? 3 : 2), cfg.reserveBytes, 'Backup folder')

    step('Exporting the database')
    await fsp.mkdir(path.join(work, 'database'), { recursive: true })
    const dumpFile = form === 'zip' ? 'database/flowvision.sql.gz' : 'database/flowvision.sql'
    const pass = new PassThrough()
    const written = form === 'zip' ? pipeline(pass, zlib.createGzip({ level: 6 }), fs.createWriteStream(path.join(work, dumpFile))) : pipeline(pass, fs.createWriteStream(path.join(work, dumpFile)))
    const opts2 = { events: cfg.dumpEvents, routines: cfg.dumpRoutines }
    const [dump] = await Promise.all([runDump(tool, opts.db, opts2, pass), written])
    if (!dump.completed) throw new BackupError('DUMP_INCOMPLETE', 'The database dump did not finish ("Dump completed" missing)')
    const missingTables = tables.filter((t) => !dump.tables.has(t))
    const missingViews = inv.views.filter((v) => !dump.views.has(v))
    if (missingTables.length || missingViews.length) throw new BackupError('DUMP_INCOMPLETE', `The dump lacks ${[...missingTables, ...missingViews].join(', ')}`)
    if (dump.warnings) warnings.push(`Dump utility said: ${dump.warnings}`)

    step('Copying uploaded files')
    const refsAfter = await fileReferences(conn, tables)
    const countsAfter = await rowCounts(conn, tables)
    const blobs = await blobIndex(conn, tables)
    const fingerprint = await schemaFingerprint(conn, opts.db.name)
    const groups = groupRefs([...refsBefore, ...refsAfter])
    const files: Manifest['files'] = { storage: 'none', upload_dir_included: false, in_package: [], in_database: [], missing: [], skipped: [] }
    for (const [key, referencedBy] of groups) {
      if (!isStorageKey(key)) {
        files.skipped.push({ value_kind: /^https?:\/\//i.test(key) ? 'external URL' : 'unrecognized value', referenced_by: referencedBy })
        continue
      }
      const onDisk = path.join(cfg.uploadDir, ...key.split('/'))
      const stat = await fsp.stat(onDisk).catch(() => null)
      if (stat?.isFile()) {
        const rel = `files/${key}`
        const r = await copyStable(onDisk, path.join(work, ...rel.split('/')))
        if (!r.stable) warnings.push(`A file changed while it was copied (${referencedBy[0]!.table} ${referencedBy[0]!.id}); the copy may not match the database`)
        files.in_package.push({ key, path: rel, bytes: r.bytes, sha256: r.sha256, referenced_by: referencedBy } satisfies ManifestFile)
      } else if (blobs.has(key)) {
        files.in_database.push({ key, ...blobs.get(key)!, referenced_by: referencedBy })
      } else {
        const stillReferenced = refsAfter.some((r) => r.key === key)
        files.missing.push({ key, referenced_by: referencedBy, reason: stillReferenced ? 'not on disk (UPLOAD_DIR) and not in file_blobs' : 'deleted while the backup ran' })
      }
    }
    files.upload_dir_included = files.in_package.length > 0
    files.storage = files.in_package.length && files.in_database.length ? 'mixed' : files.in_package.length ? 'disk' : files.in_database.length ? 'db' : 'none'
    if (files.missing.length) {
      const byTable = files.missing.reduce<Record<string, number>>((m, f) => ((m[f.referenced_by[0]!.table] = (m[f.referenced_by[0]!.table] ?? 0) + 1), m), {})
      warnings.push(`${files.missing.length} referenced file(s) not found anywhere: ${Object.entries(byTable).map(([t, n]) => `${t} ${n}`).join(', ')} (record ids in the manifest)`)
    }
    const changed = tables.filter((t) => countsBefore[t] !== countsAfter[t])
    if (changed.length) warnings.push(`Rows changed while the backup ran (the dump is still one consistent snapshot): ${changed.join(', ')}`)

    step('Writing the manifest and checksums')
    const manifest: Manifest = {
      format: FORMAT,
      format_version: FORMAT_VERSION,
      backup_id: id,
      name,
      type: 'full',
      created_at: createdAt.toISOString(),
      completed_at: new Date().toISOString(),
      application: { name: 'flowvision', git_commit: gitCommit(), latest_migration: latestMigration(), node: process.version },
      database: {
        engine: server.engine,
        server_version: server.version,
        name: opts.db.name,
        dump_tool: path.basename(tool.bin),
        dump_tool_version: `${tool.flavor} ${tool.version}`,
        dump_file: dumpFile,
        compression: form === 'zip' ? 'gzip' : 'none',
        options: ['--single-transaction', '--quick', '--hex-blob', '--default-character-set=utf8mb4', '--triggers', opts2.routines ? '--routines' : '--skip-routines', opts2.events ? '--events' : '--skip-events', '--no-tablespaces'],
        tables,
        views: inv.views,
        routines: inv.routines,
        triggers: inv.triggers,
        events: inv.events,
        schema_fingerprint: fingerprint,
        row_counts: Object.fromEntries(tables.map((t) => [t, { before: countsBefore[t]!, after: countsAfter[t]! }])),
        consistency: 'One InnoDB transaction (--single-transaction). Files are immutable per key; the file list is read before and after the dump.',
      },
      files,
      components: ['manifest.json', 'RESTORE.md', dumpFile],
      checksums: { algorithm: 'sha256', file: 'CHECKSUMS.sha256' },
      encryption: passphrase ? { method: 'aes-256-gcm/scrypt', note: 'The whole package file is encrypted; the passphrase is kept outside the backup (BACKUP_PASSPHRASE_FILE).' } : { method: 'none' },
      warnings,
    }
    await fsp.writeFile(path.join(work, 'manifest.json'), JSON.stringify(manifest, null, 2))
    await fsp.writeFile(path.join(work, 'RESTORE.md'), restoreGuide(manifest))
    const sums: string[] = []
    for (const rel of ['manifest.json', 'RESTORE.md', dumpFile, ...files.in_package.map((f) => f.path)]) {
      const sha = rel.startsWith('files/') ? files.in_package.find((f) => f.path === rel)!.sha256 : await sha256File(path.join(work, ...rel.split('/')))
      sums.push(`${sha} *${rel}`)
    }
    await fsp.writeFile(path.join(work, 'CHECKSUMS.sha256'), `${sums.join('\n')}\n`)

    if (form === 'dir') {
      step('Verifying')
      const reader = await openPackage(work)
      const v = await verifyReader(reader)
      if (!v.ok) throw new BackupError('VERIFY_FAILED', `The snapshot folder failed verification: ${v.errors.slice(0, 5).join('; ')}`)
      if (!opts.dirTarget) throw new BackupError('CONFIG', 'No target folder for the snapshot')
      await fsp.rm(opts.dirTarget, { recursive: true, force: true })
      await fsp.rename(work, opts.dirTarget)
      finished = true
      return { kind: 'dir' as const, name, dir: opts.dirTarget, manifest, verify: v }
    }

    step('Packing')
    const zipPartial = path.join(cfg.dir, `.${name}.zip.partial`)
    partial = zipPartial
    await new Promise<void>((resolve, reject) => {
      const out = fs.createWriteStream(zipPartial)
      const archive = archiver('zip', { store: true })
      out.on('close', () => resolve())
      out.on('error', reject)
      archive.on('error', reject)
      archive.on('warning', reject)
      archive.pipe(out)
      for (const line of sums) {
        const rel = line.slice(line.indexOf('*') + 1)
        archive.file(path.join(work, ...rel.split('/')), { name: rel })
      }
      archive.file(path.join(work, 'CHECKSUMS.sha256'), { name: 'CHECKSUMS.sha256' })
      void archive.finalize()
    })
    await fsyncFile(zipPartial)
    await fsp.rm(work, { recursive: true, force: true })
    let finalExt = '.zip'
    if (passphrase) {
      step('Encrypting')
      const encPartial = path.join(cfg.dir, `.${name}.zip.fvenc.partial`)
      partial = encPartial
      await pipeline(fs.createReadStream(zipPartial), encryptStream(passphrase), fs.createWriteStream(encPartial))
      await fsyncFile(encPartial)
      await fsp.rm(zipPartial, { force: true })
      finalExt = '.zip.fvenc'
    }

    step('Verifying the package')
    const v = await verifyPackage(partial, { passphrase, scratchDir: cfg.dir })
    if (!v.ok) throw new BackupError('VERIFY_FAILED', `The new package failed verification: ${v.errors.slice(0, 5).join('; ')}`)
    if (opts.strict && v.warnings.length) throw new BackupError('WARNINGS', `Strict mode: ${v.warnings.join('; ')}`)

    const finalFile = path.join(cfg.dir, name + finalExt)
    const packageSha = await sha256File(partial)
    const bytes = (await fsp.stat(partial)).size
    await fsp.rename(partial, finalFile)
    partial = null
    const now = new Date().toISOString()
    const sidecar: Sidecar = {
      format: FORMAT,
      name,
      backup_id: id,
      type: 'full',
      created_at: manifest.created_at,
      package_file: path.basename(finalFile),
      package_bytes: bytes,
      package_sha256: packageSha,
      encrypted: Boolean(passphrase),
      status: v.warnings.length ? 'VERIFIED_WITH_WARNINGS' : 'VERIFIED',
      warnings: v.warnings,
      summary: {
        engine: server.engine,
        server_version: server.version,
        tables: tables.length,
        rows: Object.values(countsAfter).reduce((a, b) => a + b, 0),
        files_in_package: files.in_package.length,
        files_in_database: files.in_database.length,
        files_missing: files.missing.length,
      },
      last_verify: { at: now, ok: true, deep: true, errors: [] },
      copies: [],
    }
    await writeJsonAtomic(path.join(cfg.dir, `${name}.json`), sidecar)
    finished = true

    const copy: FullResult['copy'] = { attempted: false, ok: false, destination: null, error: null }
    if (opts.copy !== false && cfg.copyDir) {
      step('Copying to the second destination')
      copy.attempted = true
      copy.destination = labelOf(cfg.copyDir)
      try {
        await copyToDestination(cfg, name, { locked: true })
        copy.ok = true
      } catch (err) {
        copy.error = (err as Error).message
      }
    }
    const result: FullResult = { name, file: finalFile, sidecar: (await readSidecar(cfg, name))!, copy }
    return { kind: 'zip' as const, ...result }
  } finally {
    await conn?.end().catch(() => {})
    if (!finished || form === 'zip') await fsp.rm(work, { recursive: true, force: true }).catch(() => {})
    if (partial) await fsp.rm(partial, { force: true }).catch(() => {})
    await release()
  }
}

export async function createFullBackup(opts: Omit<BuildOptions, 'form' | 'dirTarget'>): Promise<FullResult> {
  const r = await buildBackup({ ...opts, form: 'zip' })
  if (r.kind !== 'zip') throw new Error('unexpected')
  return r
}

// ---------------------------------------------------------------------------
// Stored backups
// ---------------------------------------------------------------------------

export async function readSidecar(cfg: BackupConfig, name: string): Promise<Sidecar | null> {
  if (!cfg.dir || !NAME_RE.test(name)) return null
  const text = await fsp.readFile(path.join(cfg.dir, `${name}.json`), 'utf8').catch(() => null)
  return text ? (JSON.parse(text) as Sidecar) : null
}

/** The package file of a backup by name (validated; never a path from the caller). */
export function packagePath(cfg: BackupConfig, name: string) {
  if (!cfg.dir || !NAME_RE.test(name)) return null
  for (const ext of ['.zip', '.zip.fvenc']) {
    const p = path.join(cfg.dir, name + ext)
    if (fs.existsSync(p)) return p
  }
  return null
}

export async function listBackups(cfg: BackupConfig) {
  if (!cfg.dir) return []
  const names = new Set<string>()
  for (const e of await fsp.readdir(cfg.dir).catch(() => [] as string[])) {
    const m = /^(flowvision_full_[^.]+)\.(?:json|zip|zip\.fvenc)$/.exec(e)
    if (m && NAME_RE.test(m[1]!)) names.add(m[1]!)
  }
  const out = []
  for (const name of [...names].sort().reverse()) {
    const sidecar = await readSidecar(cfg, name).catch(() => null)
    const file = packagePath(cfg, name)
    const stat = file ? await fsp.stat(file).catch(() => null) : null
    out.push({
      name,
      present: Boolean(stat),
      bytes: stat?.size ?? null,
      created_at: sidecar?.created_at ?? null,
      status: !stat ? ('PACKAGE_MISSING' as const) : sidecar ? sidecar.status : ('NO_RECORD' as const),
      encrypted: sidecar?.encrypted ?? Boolean(file?.endsWith('.fvenc')),
      warnings: sidecar?.warnings ?? [],
      summary: sidecar?.summary ?? null,
      last_verify: sidecar?.last_verify ?? null,
      copies: sidecar?.copies ?? [],
    })
  }
  return out
}

/** Re-verify a stored backup: its file hash against the record, then (with the passphrase if encrypted) every entry. */
export async function verifyStored(cfg: BackupConfig, name: string) {
  const file = packagePath(cfg, name)
  if (!cfg.dir || !file) throw new BackupError('NOT_FOUND', 'No such backup')
  const sidecar = await readSidecar(cfg, name)
  const errors: string[] = []
  const sha = await sha256File(file)
  if (sidecar && sha !== sidecar.package_sha256) errors.push('The package file changed since it was made (SHA-256 differs from its record)')
  const encrypted = file.endsWith('.fvenc')
  const passphrase = encrypted ? await readPassphrase(cfg).catch(() => null) : null
  let deep = false
  let warnings: string[] = []
  if (!encrypted || passphrase) {
    const v = await verifyPackage(file, { passphrase, scratchDir: cfg.dir }).catch((err) => ({ ok: false, errors: [(err as Error).message], warnings: [] as string[] }))
    errors.push(...v.errors)
    warnings = v.warnings
    deep = true
  }
  if (sidecar) {
    sidecar.last_verify = { at: new Date().toISOString(), ok: !errors.length, deep, errors }
    if (errors.length) sidecar.status = 'FAILED'
    else if (deep) sidecar.status = warnings.length ? 'VERIFIED_WITH_WARNINGS' : 'VERIFIED'
    await writeJsonAtomic(path.join(cfg.dir, `${name}.json`), sidecar)
  }
  return { ok: !errors.length, deep, errors, warnings, sha256: sha }
}

/**
 * Copy a backup to BACKUP_COPY_DIR (e.g. the external drive): to a hidden partial file first,
 * flushed to disk, read back and compared by SHA-256, and only then renamed into place. Existing
 * files there are never deleted or overwritten.
 */
export async function copyToDestination(cfg: BackupConfig, name: string, { locked = false } = {}) {
  if (!cfg.dir || !cfg.copyDir) throw new BackupError('NOT_CONFIGURED', 'BACKUP_COPY_DIR is not set')
  const src = packagePath(cfg, name)
  const sidecar = await readSidecar(cfg, name)
  if (!src || !sidecar) throw new BackupError('NOT_FOUND', 'No such backup (or its record is missing)')
  if (sidecar.status === 'FAILED') throw new BackupError('NOT_VERIFIED', 'This backup failed verification; it is not copied')
  const dest = await checkDestination(cfg.copyDir, 'Second destination (BACKUP_COPY_DIR)')
  const release = locked ? async () => {} : await acquireLock(cfg.dir, 'copy')
  const target = path.join(cfg.copyDir, path.basename(src))
  const partialFile = path.join(cfg.copyDir, `.${path.basename(src)}.partial`)
  try {
    const srcSha = await sha256File(src)
    if (srcSha !== sidecar.package_sha256) throw new BackupError('SOURCE_CHANGED', 'The local package no longer matches its record; verify it before copying')
    if (fs.existsSync(target)) {
      if ((await sha256File(target)) !== srcSha) throw new BackupError('DEST_CONFLICT', `${path.basename(target)} already exists at the destination with different content; nothing was overwritten`)
    } else {
      await assertSpace(cfg.copyDir, sidecar.package_bytes, cfg.reserveBytes, 'Second destination')
      try {
        await pipeline(fs.createReadStream(src), fs.createWriteStream(partialFile))
        await fsyncFile(partialFile)
        const copied = await sha256File(partialFile)
        if (copied !== srcSha) throw new BackupError('COPY_CORRUPTED', 'The copy on the destination does not match the original (checksum differs)')
        await fsp.rename(partialFile, target)
      } catch (err) {
        await fsp.rm(partialFile, { force: true }).catch(() => {})
        const code = (err as NodeJS.ErrnoException).code
        if (err instanceof BackupError) throw err
        throw new BackupError(code === 'ENOSPC' ? 'NO_SPACE' : 'COPY_FAILED', `Copy to ${dest.label} failed (${code ?? (err as Error).message}); the destination keeps only complete backups`)
      }
    }
    const entry = { destination: dest.label, verified_at: new Date().toISOString(), sha256: srcSha }
    sidecar.copies = [...sidecar.copies.filter((c) => c.destination !== dest.label), entry]
    await writeJsonAtomic(path.join(cfg.dir, `${name}.json`), sidecar)
    await writeJsonAtomic(path.join(cfg.copyDir, `${name}.json`), sidecar)
    return entry
  } finally {
    await release()
  }
}
