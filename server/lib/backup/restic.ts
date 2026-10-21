import fs from 'node:fs'
import fsp from 'node:fs/promises'
import path from 'node:path'
import { spawn } from 'node:child_process'
import { assertSpace, BackupError, labelOf, readConfig, type BackupConfig } from './config.ts'
import { buildBackup } from './full.ts'
import { verifyPackage } from './package.ts'
import type { DbTarget } from './database.ts'

/**
 * Versioned backups with Restic (https://restic.net): each snapshot is a complete, verified,
 * unpacked full backup (uncompressed dump + uploaded files + manifest + checksums), so any
 * snapshot is a logical full recovery point; Restic stores only what changed (deduplication).
 * Repository and password use Restic's own settings: RESTIC_REPOSITORY (a folder on the external
 * drive) and RESTIC_PASSWORD_FILE. Forgetting old snapshots is refused until the newest one has
 * passed a restore test and the repository check passes.
 */

const HOST = 'flowvision'
const TAG = 'flowvision'

function resticBin(cfg: BackupConfig) {
  if (cfg.resticBin) {
    if (!fs.existsSync(cfg.resticBin)) throw new BackupError('TOOL_MISSING', 'BACKUP_RESTIC_BIN does not exist')
    return cfg.resticBin
  }
  for (const dir of (process.env.PATH ?? '').split(path.delimiter)) {
    for (const n of ['restic.exe', 'restic']) if (dir && fs.existsSync(path.join(dir, n))) return path.join(dir, n)
  }
  throw new BackupError('TOOL_MISSING', 'Restic not found: install it and set BACKUP_RESTIC_BIN to restic.exe')
}

function repoSettings() {
  const repo = process.env.RESTIC_REPOSITORY?.trim()
  if (!repo) throw new BackupError('NOT_CONFIGURED', 'RESTIC_REPOSITORY is not set (e.g. a folder on the external drive)')
  if (!process.env.RESTIC_PASSWORD_FILE?.trim()) throw new BackupError('NOT_CONFIGURED', 'RESTIC_PASSWORD_FILE is not set (a file holding the repository password, kept off the backup drive too)')
  if (!fs.existsSync(process.env.RESTIC_PASSWORD_FILE)) throw new BackupError('NOT_CONFIGURED', 'RESTIC_PASSWORD_FILE does not exist')
  const local = path.isAbsolute(repo)
  if (local && !fs.existsSync(path.parse(repo).root)) throw new BackupError('DRIVE_MISSING', `The Restic repository's drive ${path.parse(repo).root} is not connected`)
  return { repo, local }
}

function restic(cfg: BackupConfig, args: string[], { json = false } = {}) {
  return new Promise<string>((resolve, reject) => {
    const child = spawn(resticBin(cfg), [...args, ...(json ? ['--json'] : [])], { windowsHide: true, env: process.env })
    let out = ''
    let err = ''
    child.stdout.on('data', (d) => (out += d))
    child.stderr.on('data', (d) => (err = (err + d).slice(-8000)))
    child.on('error', reject)
    child.on('close', (code) => {
      if (code === 0) resolve(out)
      else reject(new BackupError('RESTIC_FAILED', `restic ${args[0]} failed (exit ${code}): ${err.trim().split(/\r?\n/).slice(-4).join(' | ') || 'no message'}`))
    })
  })
}

const statusFile = (cfg: BackupConfig) => path.join(cfg.dir!, 'restic-status.json')
type Status = { verified: Record<string, string>; last_snapshot: string | null }
async function readStatus(cfg: BackupConfig): Promise<Status> {
  return JSON.parse((await fsp.readFile(statusFile(cfg), 'utf8').catch(() => null)) ?? '{"verified":{},"last_snapshot":null}')
}
async function writeStatus(cfg: BackupConfig, s: Status) {
  await fsp.writeFile(`${statusFile(cfg)}.tmp`, JSON.stringify(s, null, 2))
  await fsp.rename(`${statusFile(cfg)}.tmp`, statusFile(cfg))
}

/** Create the repository if it does not exist yet (part of `npm run backup -- init`). */
export async function initRepository(cfg = readConfig()) {
  const { repo, local } = repoSettings()
  try {
    await restic(cfg, ['cat', 'config'])
    return { created: false, label: local ? labelOf(repo) : 'remote repository' }
  } catch {
    if (local) await fsp.mkdir(path.dirname(repo), { recursive: true })
    await restic(cfg, ['init'])
    return { created: true, label: local ? labelOf(repo) : 'remote repository' }
  }
}

export interface Snapshot {
  id: string
  short_id: string
  time: string
  paths: string[]
  tags?: string[]
}

export async function snapshots(cfg = readConfig()): Promise<Snapshot[]> {
  repoSettings()
  return JSON.parse(await restic(cfg, ['snapshots', '--host', HOST, '--tag', TAG], { json: true })) as Snapshot[]
}

export async function check(cfg = readConfig(), { readData = false } = {}) {
  repoSettings()
  await restic(cfg, ['check', ...(readData ? ['--read-data'] : [])])
}

/** The path a snapshot stores its folder under: "C:\x\y" → "/C/x/y". */
const treePath = (p: string) => (/^[a-zA-Z]:/.test(p) ? `/${p[0]!.toUpperCase()}${p.slice(2).replace(/\\/g, '/')}` : p)

export async function restoreSnapshot(cfg: BackupConfig, which: string, target: string) {
  const list = await snapshots(cfg)
  const snap = which === 'latest' ? list.at(-1) : list.find((s) => s.id === which || s.short_id === which)
  if (!snap) throw new BackupError('NOT_FOUND', `No FlowVision snapshot ${which}`)
  const existing = await fsp.readdir(target).catch(() => null)
  if (existing?.length) throw new BackupError('TARGET_NOT_EMPTY', 'The restore folder must be empty or not exist')
  await restic(cfg, ['restore', `${snap.id}:${treePath(snap.paths[0]!)}`, '--target', target])
  const v = await verifyPackage(target)
  if (!v.ok) throw new BackupError('VERIFY_FAILED', `The restored snapshot failed verification: ${v.errors.slice(0, 5).join('; ')}`)
  return { snapshot: snap.short_id, dir: target, verify: v }
}

/**
 * Daily snapshot: build and verify a full backup folder, store it in the repository (tagged daily;
 * weekly on Sundays, monthly on the 1st), check the repository, then restore the snapshot into a
 * scratch folder and verify every checksum — the snapshot counts as verified only after that.
 */
export async function snapshot(opts: { db: DbTarget; cfg?: BackupConfig; onStep?: (s: string) => void }) {
  const cfg = opts.cfg ?? readConfig()
  const step = opts.onStep ?? (() => {})
  if (!cfg.dir) throw new BackupError('NOT_CONFIGURED', 'BACKUP_DIR is not set')
  const { repo, local } = repoSettings()
  resticBin(cfg)
  await restic(cfg, ['cat', 'config']).catch(() => {
    throw new BackupError('REPO_MISSING', `No Restic repository at ${local ? labelOf(repo) : 'RESTIC_REPOSITORY'}: run \`npm run backup -- init\` once (and check the drive is connected)`)
  })
  const staging = path.join(cfg.dir, 'restic-staging')
  const built = await buildBackup({ db: opts.db, cfg, form: 'dir', dirTarget: staging, onStep: step })
  if (built.kind !== 'dir') throw new Error('unexpected')
  const verifyDir = path.join(cfg.dir, `.restic-verify-${Date.now()}`)
  try {
    const logical = built.verify.bytes
    if (local) await assertSpace(path.parse(repo).root, logical, cfg.reserveBytes, 'Restic repository drive')
    const now = new Date()
    const tags = ['daily', ...(now.getDay() === 0 ? ['weekly'] : []), ...(now.getDate() === 1 ? ['monthly'] : [])]
    step('Storing the snapshot')
    const out = await restic(cfg, ['backup', staging, '--host', HOST, '--tag', TAG, ...tags.flatMap((t) => ['--tag', t])], { json: true })
    const summary = out
      .split(/\r?\n/)
      .map((l) => {
        try {
          return JSON.parse(l)
        } catch {
          return null
        }
      })
      .find((m) => m?.message_type === 'summary')
    if (!summary?.snapshot_id) throw new BackupError('RESTIC_FAILED', 'restic backup reported no snapshot')
    step('Checking the repository')
    await restic(cfg, ['check'])
    step('Restore-testing the snapshot')
    const r = await restoreSnapshot(cfg, summary.snapshot_id, verifyDir)
    const status = await readStatus(cfg)
    status.verified[summary.snapshot_id] = new Date().toISOString()
    status.last_snapshot = summary.snapshot_id
    await writeStatus(cfg, status)
    return { snapshot: String(summary.snapshot_id).slice(0, 8), tags, verified: r.verify.ok, logicalBytes: logical, addedBytes: Number(summary.data_added ?? 0) }
  } finally {
    await fsp.rm(verifyDir, { recursive: true, force: true }).catch(() => {})
    await fsp.rm(staging, { recursive: true, force: true }).catch(() => {})
  }
}

/** Retention (BACKUP_RETAIN_DAILY / WEEKLY / MONTHLY, each at least 1, so the newest snapshot always stays). */
export async function forget(cfg = readConfig()) {
  const list = await snapshots(cfg)
  if (!list.length) throw new BackupError('NOTHING', 'No snapshots yet')
  const newest = list.at(-1)!
  const status = await readStatus(cfg)
  if (!status.verified[newest.id]) throw new BackupError('NOT_VERIFIED', 'The newest snapshot has not passed a restore test; nothing is removed until it has (run a new snapshot)')
  await restic(cfg, ['check'])
  const { daily, weekly, monthly } = cfg.retain
  const out = await restic(cfg, ['forget', '--host', HOST, '--tag', TAG, '--keep-daily', String(daily), '--keep-weekly', String(weekly), '--keep-monthly', String(monthly), '--prune'], { json: true })
  const groups = (() => {
    for (const line of out.split(/\r?\n/)) {
      try {
        const v = JSON.parse(line)
        if (Array.isArray(v)) return v as Array<{ keep?: unknown[]; remove?: unknown[] | null }>
      } catch {
        /* progress lines */
      }
    }
    return []
  })()
  const after = await snapshots(cfg)
  if (!after.some((s) => s.id === newest.id)) throw new BackupError('RETENTION', 'The newest snapshot is gone after forget: check the retention settings')
  return { kept: groups.reduce((n, g) => n + (g.keep?.length ?? 0), 0), removed: groups.reduce((n, g) => n + (g.remove?.length ?? 0), 0) }
}
