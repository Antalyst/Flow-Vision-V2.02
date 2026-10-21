import fs from 'node:fs'
import fsp from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { env } from '../env.ts'

/**
 * Backup configuration, from the environment only (never from a request). See
 * docs/BACKUP_AND_RECOVERY.md for every name. Paths must be absolute, and the tool never falls
 * back to another folder: a missing drive or folder is an error.
 */

export class BackupError extends Error {
  readonly code: string
  constructor(code: string, message: string) {
    super(message)
    this.name = 'BackupError'
    this.code = code
  }
}

/** Marks a folder as a FlowVision backup destination (`npm run backup -- init`). */
export const MARKER = '.flowvision-backup-destination'
export const LOCK = '.flowvision-backup.lock'
export const NAME_RE = /^flowvision_full_\d{4}-\d{2}-\d{2}_\d{2}-\d{2}-\d{2}(?:-\d{1,2})?$/

const absolute = (name: string) => {
  const raw = process.env[name]?.trim()
  if (!raw) return null
  if (!path.isAbsolute(raw)) throw new BackupError('CONFIG', `${name} must be an absolute path (e.g. D:\\FlowVisionBackups)`)
  return path.resolve(raw)
}
const int = (name: string, fallback: number, min = 0) => {
  const raw = process.env[name]?.trim()
  if (!raw) return fallback
  const n = Number(raw)
  if (!Number.isInteger(n) || n < min) throw new BackupError('CONFIG', `${name} must be a whole number of at least ${min}`)
  return n
}

export interface BackupConfig {
  /** Where full backups are made and kept (on this computer). */
  dir: string | null
  /** A second destination, e.g. a folder on an external drive; every backup is copied and verified there. */
  copyDir: string | null
  dumpBin: string | null
  clientBin: string | null
  /** A file holding the encryption passphrase; set = packages are encrypted. */
  passphraseFile: string | null
  reserveBytes: number
  dumpEvents: boolean
  dumpRoutines: boolean
  uploadDir: string
  resticBin: string | null
  retain: { daily: number; weekly: number; monthly: number }
}

export function readConfig(): BackupConfig {
  return {
    dir: absolute('BACKUP_DIR'),
    copyDir: absolute('BACKUP_COPY_DIR'),
    dumpBin: absolute('BACKUP_DUMP_BIN'),
    clientBin: absolute('BACKUP_MYSQL_BIN'),
    passphraseFile: absolute('BACKUP_PASSPHRASE_FILE'),
    reserveBytes: int('BACKUP_RESERVE_MB', 1024) * 1024 * 1024,
    dumpEvents: process.env.BACKUP_DUMP_EVENTS === 'true',
    dumpRoutines: process.env.BACKUP_DUMP_ROUTINES !== 'false',
    uploadDir: env.uploadDir,
    resticBin: absolute('BACKUP_RESTIC_BIN'),
    retain: { daily: int('BACKUP_RETAIN_DAILY', 7, 1), weekly: int('BACKUP_RETAIN_WEEKLY', 4, 1), monthly: int('BACKUP_RETAIN_MONTHLY', 6, 1) },
  }
}

export async function readPassphrase(cfg: BackupConfig) {
  if (!cfg.passphraseFile) return null
  const text = await fsp.readFile(cfg.passphraseFile, 'utf8').catch(() => {
    throw new BackupError('PASSPHRASE', 'BACKUP_PASSPHRASE_FILE is set but cannot be read')
  })
  const pass = text.replace(/\r?\n$/, '')
  if (pass.trim().length < 16) throw new BackupError('PASSPHRASE', 'The backup passphrase (BACKUP_PASSPHRASE_FILE) must be at least 16 characters')
  return pass
}

const inside = (child: string, parent: string) => {
  const rel = path.relative(parent, child)
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel))
}

/** A short, non-revealing label for a destination: drive and last folder, e.g. "E:\…\FlowVisionBackups". */
export const labelOf = (dir: string) => {
  const root = path.parse(dir).root
  const base = path.basename(dir)
  return dir === root ? root : `${root}…${path.sep}${base}`
}

export async function freeBytes(dir: string) {
  const s = await fsp.statfs(dir)
  return Number(s.bavail) * Number(s.bsize)
}

/**
 * The destination exists (its drive is connected), is a FlowVision backup folder (marker file),
 * is writable, and is not inside the app's own data. Never creates anything (see `initDestination`).
 */
export async function checkDestination(dir: string, what: string, { requireMarker = true } = {}) {
  const root = path.parse(dir).root
  if (!fs.existsSync(root)) throw new BackupError('DRIVE_MISSING', `${what}: drive ${root} is not connected. Connect the backup drive (or fix the path) and try again; nothing was written anywhere else.`)
  const stat = await fsp.stat(dir).catch(() => null)
  if (!stat) throw new BackupError('DEST_MISSING', `${what}: the folder ${labelOf(dir)} does not exist. Create it with \`npm run backup -- init\`.`)
  if (!stat.isDirectory()) throw new BackupError('DEST_NOT_DIR', `${what}: ${labelOf(dir)} is not a folder`)
  const cfg = readConfig()
  for (const forbidden of [cfg.uploadDir, process.cwd()]) {
    if (inside(dir, forbidden) || inside(forbidden, dir)) throw new BackupError('DEST_UNSAFE', `${what}: ${labelOf(dir)} overlaps the application or its uploads. Use a dedicated backup folder.`)
  }
  if (requireMarker && !fs.existsSync(path.join(dir, MARKER))) {
    throw new BackupError('DEST_UNMARKED', `${what}: ${labelOf(dir)} is not marked as a FlowVision backup folder (a different drive may have taken its letter). Run \`npm run backup -- init\` once if it is the right folder.`)
  }
  const probe = path.join(dir, `.write-test-${process.pid}-${Date.now()}`)
  try {
    await fsp.writeFile(probe, 'ok')
    await fsp.rm(probe)
  } catch (err) {
    throw new BackupError('DEST_NOT_WRITABLE', `${what}: cannot write to ${labelOf(dir)} (${(err as NodeJS.ErrnoException).code ?? 'error'}). Check the drive is not read-only and this Windows account may write there.`)
  }
  return { dir, label: labelOf(dir), free: await freeBytes(dir) }
}

/** Create the destination folders (only where the drive exists) and their marker files. */
export async function initDestination(dir: string, what: string) {
  const root = path.parse(dir).root
  if (!fs.existsSync(root)) throw new BackupError('DRIVE_MISSING', `${what}: drive ${root} is not connected`)
  await fsp.mkdir(dir, { recursive: true })
  const marker = path.join(dir, MARKER)
  if (!fs.existsSync(marker)) {
    await fsp.writeFile(marker, `FlowVision backup destination (${what}). Created ${new Date().toISOString()} on ${os.hostname()}.\nDo not delete: backups refuse folders without it.\n`)
  }
  return checkDestination(dir, what)
}

export async function assertSpace(dir: string, needed: number, reserve: number, what: string) {
  const free = await freeBytes(dir)
  if (free < needed + reserve) {
    const mb = (n: number) => `${Math.ceil(n / 1024 / 1024)} MB`
    throw new BackupError('NO_SPACE', `${what}: not enough free space on ${labelOf(dir)} (${mb(free)} free, about ${mb(needed)} needed plus ${mb(reserve)} kept free). Nothing was deleted.`)
  }
  return free
}

// ---------------------------------------------------------------------------
// One backup at a time: a lock file in the backup folder, shared by the CLI and the server
// ---------------------------------------------------------------------------

const alive = (pid: number) => {
  try {
    process.kill(pid, 0)
    return true
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === 'EPERM'
  }
}

export async function acquireLock(dir: string, what: string) {
  const file = path.join(dir, LOCK)
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const handle = await fsp.open(file, 'wx')
      await handle.writeFile(JSON.stringify({ pid: process.pid, host: os.hostname(), what, started_at: new Date().toISOString() }))
      await handle.close()
      return async () => {
        await fsp.rm(file, { force: true })
      }
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'EEXIST') throw err
      const held = JSON.parse(await fsp.readFile(file, 'utf8').catch(() => '{}')) as { pid?: number; host?: string; what?: string; started_at?: string }
      // A lock left behind by a process on this computer that no longer runs is stale.
      if (attempt === 0 && held.host === os.hostname() && held.pid && !alive(held.pid)) {
        await fsp.rm(file, { force: true })
        continue
      }
      throw new BackupError('BUSY', `Another backup job is running (${held.what ?? 'unknown'}, started ${held.started_at ?? 'at an unknown time'}). Try again when it has finished.`)
    }
  }
  throw new BackupError('BUSY', 'Another backup job is running')
}

export async function lockInfo(dir: string) {
  const text = await fsp.readFile(path.join(dir, LOCK), 'utf8').catch(() => null)
  if (!text) return null
  try {
    const held = JSON.parse(text) as { pid?: number; host?: string; what?: string; started_at?: string }
    if (held.host === os.hostname() && held.pid && !alive(held.pid)) return null
    return { what: held.what ?? null, started_at: held.started_at ?? null }
  } catch {
    return null
  }
}
