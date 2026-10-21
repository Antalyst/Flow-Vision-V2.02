import crypto from 'node:crypto'
import fs from 'node:fs'
import fsp from 'node:fs/promises'
import path from 'node:path'
import zlib from 'node:zlib'
import { Transform, Writable, type Readable } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import unzipper from 'unzipper'
import { BackupError } from './config.ts'
import { decryptStream, isEncryptedHeader } from './crypto.ts'
import { dumpScanner } from './database.ts'

/**
 * The backup package (format "flowvision-backup", version 1). As a .zip (optionally encrypted as
 * .zip.fvenc) or, for Restic snapshots, as a plain folder with the same layout:
 *
 *   manifest.json            what is inside: versions, tables, row counts, every stored file and its hash
 *   CHECKSUMS.sha256         SHA-256 of every other entry ("<hash> *<path>", sha256sum format)
 *   RESTORE.md               how to restore it
 *   database/flowvision.sql.gz   (folder form: database/flowvision.sql) the database dump
 *   files/<storage key>      uploaded files kept on disk (UPLOAD_DIR), under their storage keys
 *
 * Files kept in the database (file_blobs, the Vercel mode) are inside the dump.
 */

export const FORMAT = 'flowvision-backup'
export const FORMAT_VERSION = 1

export interface ManifestFile {
  key: string
  path: string
  bytes: number
  sha256: string
  referenced_by: Array<{ table: string; id: string }>
}

export interface Manifest {
  format: typeof FORMAT
  format_version: number
  backup_id: string
  name: string
  type: 'full'
  created_at: string
  completed_at: string
  application: { name: string; git_commit: string | null; latest_migration: string | null; node: string }
  database: {
    engine: 'MariaDB' | 'MySQL'
    server_version: string
    name: string
    dump_tool: string
    dump_tool_version: string
    dump_file: string
    compression: 'gzip' | 'none'
    options: string[]
    tables: string[]
    views: string[]
    routines: number
    triggers: number
    events: number
    schema_fingerprint: string
    /** Row counts read before and after the dump; equal = nothing changed during the backup. */
    row_counts: Record<string, { before: number; after: number }>
    consistency: string
  }
  files: {
    storage: 'disk' | 'db' | 'mixed' | 'none'
    upload_dir_included: boolean
    in_package: ManifestFile[]
    in_database: Array<{ key: string; parts: number; bytes: number; referenced_by: Array<{ table: string; id: string }> }>
    missing: Array<{ key: string; referenced_by: Array<{ table: string; id: string }>; reason: string }>
    skipped: Array<{ value_kind: string; referenced_by: Array<{ table: string; id: string }> }>
  }
  components: string[]
  checksums: { algorithm: 'sha256'; file: 'CHECKSUMS.sha256' }
  encryption: { method: 'none' } | { method: 'aes-256-gcm/scrypt'; note: string }
  warnings: string[]
}

// Storage keys the app writes (see uploads.ts, knowledge.ts, org-assets.ts); anything else is not copied.
const KEY_RES = [/^[0-9a-f-]{36}\/[^/\\]+$/, /^knowledge\/[0-9a-f-]{36}\/[^/\\]+$/, /^org\/[0-9a-f-]{36}\/logo\.(png|jpg)$/, /^templates\/[0-9a-f-]{36}\/signature\.(png|jpg)$/]
export const isStorageKey = (k: string) => KEY_RES.some((re) => re.test(k)) && !k.split('/').some((s) => s === '..' || s === '.' || s === '')

/** An entry path inside a package that is safe to extract (no "..", no absolute paths, known top level). */
export function safeEntry(p: string) {
  if (!p || p.includes('\\') || p.startsWith('/') || /^[a-zA-Z]:/.test(p)) return false
  const parts = p.split('/')
  if (parts.some((s) => s === '..' || s === '.' || s === '')) return false
  if (['manifest.json', 'CHECKSUMS.sha256', 'RESTORE.md'].includes(p)) return true
  if (parts[0] === 'database') return parts.length === 2
  if (parts[0] === 'files') return isStorageKey(parts.slice(1).join('/'))
  return false
}

export const sha256File = async (file: string) => {
  const h = crypto.createHash('sha256')
  await pipeline(fs.createReadStream(file), h)
  return h.digest('hex')
}

/** A hashing pass-through: `.digest()` once the stream has ended. */
export function hasher() {
  const h = crypto.createHash('sha256')
  let bytes = 0
  const stream = new Transform({
    transform(chunk: Buffer, _e, done) {
      h.update(chunk)
      bytes += chunk.length
      done(null, chunk)
    },
  })
  return { stream, result: () => ({ sha256: h.digest('hex'), bytes }) }
}

// ---------------------------------------------------------------------------
// Reading a package
// ---------------------------------------------------------------------------

export interface PackageReader {
  kind: 'zip' | 'dir'
  entries(): Promise<Array<{ path: string; bytes: number }>>
  open(p: string): Promise<Readable>
  close(): Promise<void>
}

async function zipReader(file: string, onClose?: () => Promise<void>): Promise<PackageReader> {
  let dir: Awaited<ReturnType<typeof unzipper.Open.file>>
  try {
    dir = await unzipper.Open.file(file)
  } catch {
    throw new BackupError('BAD_PACKAGE', 'The package is not a readable zip file (truncated or corrupted)')
  }
  const files = dir.files.filter((f) => f.type === 'File')
  return {
    kind: 'zip',
    async entries() {
      return files.map((f) => ({ path: f.path, bytes: Number(f.uncompressedSize) }))
    },
    async open(p) {
      const f = files.find((x) => x.path === p)
      if (!f) throw new BackupError('BAD_PACKAGE', `Missing entry: ${p}`)
      return f.stream() as unknown as Readable
    },
    async close() {
      await onClose?.()
    },
  }
}

async function walk(root: string, rel = ''): Promise<Array<{ path: string; bytes: number }>> {
  const out: Array<{ path: string; bytes: number }> = []
  for (const d of await fsp.readdir(path.join(root, rel), { withFileTypes: true })) {
    const r = rel ? `${rel}/${d.name}` : d.name
    if (d.isDirectory()) out.push(...(await walk(root, r)))
    else if (d.isFile()) out.push({ path: r, bytes: (await fsp.stat(path.join(root, r))).size })
  }
  return out
}

function dirReader(root: string): PackageReader {
  return {
    kind: 'dir',
    entries: () => walk(root),
    async open(p) {
      if (!safeEntry(p)) throw new BackupError('BAD_PACKAGE', `Unsafe entry path: ${p}`)
      return fs.createReadStream(path.join(root, ...p.split('/')))
    },
    async close() {},
  }
}

/** Open a package: a folder, a .zip, or an encrypted .zip.fvenc (decrypted to `scratchDir` first). */
export async function openPackage(location: string, { passphrase = null as string | null, scratchDir = null as string | null } = {}): Promise<PackageReader> {
  const stat = await fsp.stat(location).catch(() => null)
  if (!stat) throw new BackupError('NOT_FOUND', 'Backup package not found')
  if (stat.isDirectory()) return dirReader(location)
  const head = Buffer.alloc(8)
  const fd = await fsp.open(location, 'r')
  await fd.read(head, 0, 8, 0)
  await fd.close()
  if (!isEncryptedHeader(head)) return zipReader(location)
  if (!passphrase) throw new BackupError('PASSPHRASE', 'This backup is encrypted: set BACKUP_PASSPHRASE_FILE to the file holding its passphrase')
  if (!scratchDir) throw new BackupError('CONFIG', 'No scratch folder to decrypt into')
  const plain = path.join(scratchDir, `.decrypt-${crypto.randomUUID()}.zip`)
  try {
    await pipeline(fs.createReadStream(location), decryptStream(passphrase), fs.createWriteStream(plain))
  } catch (err) {
    await fsp.rm(plain, { force: true })
    throw err instanceof BackupError ? err : new BackupError('DECRYPT_FAILED', (err as Error).message)
  }
  return zipReader(plain, () => fsp.rm(plain, { force: true }))
}

const sink = () => new Writable({ write: (_c, _e, cb) => cb() })

async function readSmall(reader: PackageReader, p: string, max = 50 * 1024 * 1024) {
  const chunks: Buffer[] = []
  let n = 0
  for await (const c of await reader.open(p)) {
    n += (c as Buffer).length
    if (n > max) throw new BackupError('BAD_PACKAGE', `${p} is unexpectedly large`)
    chunks.push(c as Buffer)
  }
  return Buffer.concat(chunks).toString('utf8')
}

export const parseChecksums = (text: string) => {
  const map = new Map<string, string>()
  for (const line of text.split(/\r?\n/)) {
    if (!line.trim()) continue
    const m = /^([0-9a-f]{64}) [ *](.+)$/.exec(line)
    if (!m) throw new BackupError('BAD_PACKAGE', 'CHECKSUMS.sha256 has a malformed line')
    map.set(m[2]!, m[1]!)
  }
  return map
}

export interface VerifyResult {
  ok: boolean
  errors: string[]
  warnings: string[]
  manifest: Manifest | null
  entries: number
  bytes: number
}

/**
 * Full verification: format and version, every checksum, every component present, the dump
 * decompresses completely and contains every table and view, and every stored file matches its hash.
 */
export async function verifyReader(reader: PackageReader): Promise<VerifyResult> {
  const errors: string[] = []
  const warnings: string[] = []
  const entries = await reader.entries()
  const names = new Set(entries.map((e) => e.path))
  const res = (manifest: Manifest | null): VerifyResult => ({ ok: !errors.length, errors, warnings, manifest, entries: entries.length, bytes: entries.reduce((n, e) => n + e.bytes, 0) })

  for (const e of entries) if (!safeEntry(e.path)) errors.push(`Unexpected or unsafe entry: ${e.path.slice(0, 120)}`)
  for (const required of ['manifest.json', 'CHECKSUMS.sha256']) if (!names.has(required)) errors.push(`Missing ${required}`)
  if (errors.length) return res(null)

  let manifest: Manifest
  try {
    manifest = JSON.parse(await readSmall(reader, 'manifest.json'))
  } catch {
    errors.push('manifest.json is not valid JSON')
    return res(null)
  }
  if (manifest.format !== FORMAT) errors.push('Not a FlowVision backup (manifest format)')
  if (manifest.format_version !== FORMAT_VERSION) errors.push(`Unsupported backup format version ${manifest.format_version} (this tool reads ${FORMAT_VERSION})`)
  if (errors.length) return res(manifest)

  const sums = parseChecksums(await readSmall(reader, 'CHECKSUMS.sha256'))
  for (const p of sums.keys()) if (!names.has(p)) errors.push(`Missing component: ${p}`)
  for (const p of names) if (p !== 'CHECKSUMS.sha256' && !sums.has(p)) errors.push(`Entry not covered by the checksums: ${p.slice(0, 120)}`)
  for (const c of manifest.components) if (!names.has(c)) errors.push(`Missing component listed in the manifest: ${c}`)

  // Every entry against its checksum; the dump is also decompressed and scanned.
  for (const e of entries) {
    if (e.path === 'CHECKSUMS.sha256' || !sums.has(e.path)) continue
    const h = hasher()
    try {
      if (e.path === manifest.database.dump_file) {
        // Hash the stored bytes, then decompress and scan them in the same pass.
        const scan = dumpScanner()
        const src = await reader.open(e.path)
        if (manifest.database.compression === 'gzip') await pipeline(src, h.stream, zlib.createGunzip(), scan.stream, sink())
        else await pipeline(src, h.stream, scan.stream, sink())
        if (!scan.seen.completed) errors.push('The database dump is incomplete (no "Dump completed" trailer)')
        for (const t of manifest.database.tables) if (!scan.seen.tables.has(t)) errors.push(`The dump has no table ${t}`)
        for (const v of manifest.database.views) if (!scan.seen.views.has(v)) errors.push(`The dump has no view ${v}`)
      } else {
        await pipeline(await reader.open(e.path), h.stream, sink())
      }
    } catch (err) {
      errors.push(`Could not read ${e.path.slice(0, 120)}: ${(err as Error).message}`)
      continue
    }
    const r = h.result()
    if (r.sha256 !== sums.get(e.path)) errors.push(`Checksum mismatch: ${e.path.slice(0, 120)}`)
  }
  for (const f of manifest.files.in_package) {
    if (sums.get(f.path) && sums.get(f.path) !== f.sha256) errors.push(`Manifest and checksums disagree for ${f.path.slice(0, 120)}`)
    if (!names.has(f.path)) errors.push(`Stored file missing from the package (record ${f.referenced_by[0]?.table} ${f.referenced_by[0]?.id})`)
  }
  if (manifest.files.missing.length) warnings.push(`${manifest.files.missing.length} referenced file(s) were missing when the backup was made`)
  warnings.push(...manifest.warnings)
  return res(manifest)
}

export async function verifyPackage(location: string, opts: { passphrase?: string | null; scratchDir?: string | null } = {}) {
  const reader = await openPackage(location, { passphrase: opts.passphrase ?? null, scratchDir: opts.scratchDir ?? null })
  try {
    return await verifyReader(reader)
  } finally {
    await reader.close()
  }
}

export function restoreGuide(m: Pick<Manifest, 'name' | 'database' | 'encryption' | 'files'>) {
  return `# Restoring ${m.name}

This package was made by FlowVision's backup tool (format ${FORMAT} v${FORMAT_VERSION}).
Database: ${m.database.engine} ${m.database.server_version}, dumped with ${m.database.dump_tool} ${m.database.dump_tool_version}.
Uploaded files: ${m.files.in_package.length} in files/ (stored on disk), ${m.files.in_database.length} inside the database dump (file_blobs).

## With FlowVision's tool (recommended)

1. Verify it:   npm run backup -- verify <path to this package>
2. Restore into an EMPTY, isolated database first (set RESTORE_DB_HOST, RESTORE_DB_PORT, RESTORE_DB_USER,
   RESTORE_DB_PASS, RESTORE_DB_NAME), with an empty folder for the files:
       npm run backup -- restore --package <path> --files-dir <empty folder>
   It verifies the package, loads the dump, extracts the files, and checks tables, row counts and
   every document-to-file link. Point a test copy of FlowVision at it (DB_* and UPLOAD_DIR) and open documents.
3. Only then, if this is a real recovery, restore over the live database (--replace, typed confirmation).

## By hand (if the tool is unavailable)

1. Check: sha256sum -c CHECKSUMS.sha256   (or Get-FileHash in PowerShell, compare each line)
2. Create an empty database (utf8mb4) and load the dump with the ${m.database.engine} client:
       ${m.database.compression === 'gzip' ? 'gzip -dc database/flowvision.sql.gz | ' : ''}mariadb --default-character-set=utf8mb4 <database> ${m.database.compression === 'gzip' ? '' : '< database/flowvision.sql'}
   If view creation fails with "Access denied; you need the SUPER privilege", remove the
   "DEFINER=..." clauses from the dump first (the tool does this automatically).
3. Copy files/* into the new UPLOAD_DIR, keeping the folder structure (files/<key> -> UPLOAD_DIR/<key>).
${m.encryption.method !== 'none' ? '\nThe package was encrypted: decrypt it first with `npm run backup -- verify` / `restore`, which ask for BACKUP_PASSPHRASE_FILE.\n' : ''}`
}
