import crypto from 'node:crypto'
import { Organization } from '../models.ts'
import { env } from '../env.ts'
import { audit } from '../audit.ts'
import type { Actor, RequestMeta } from '../auth.ts'
import { httpError } from '../errors.ts'
import { BackupError, checkDestination, lockInfo, readConfig, type BackupConfig } from './config.ts'
import { createFullBackup, listBackups } from './full.ts'

/**
 * The Backups page (ADMIN): available only where it makes sense — a FlowVision server running on
 * the computer that holds the backup folder (BACKUP_DIR set; not Vercel), and an installation with
 * a single organization, because a database backup holds every organization's data.
 * One job at a time per server; the lock file also keeps the command line out meanwhile.
 */

export interface Job {
  id: string
  state: 'running' | 'done' | 'failed'
  step: string
  started_at: string
  finished_at: string | null
  started_by: string
  result: { name: string; status: string; bytes: number; copy: { attempted: boolean; ok: boolean; destination: string | null; error: string | null } } | null
  error: string | null
}

let job: Job | null = null

export async function availability(): Promise<{ enabled: boolean; reason: string | null; cfg: BackupConfig | null }> {
  if (process.env.VERCEL) return { enabled: false, reason: 'This server runs on Vercel, which has no backup drive. Make backups on the backup computer with `npm run backup -- full`.', cfg: null }
  let cfg: BackupConfig
  try {
    cfg = readConfig()
  } catch (err) {
    return { enabled: false, reason: (err as Error).message, cfg: null }
  }
  if (!cfg.dir) return { enabled: false, reason: 'BACKUP_DIR is not set on this server. Backups are configured by whoever runs the server (see docs/BACKUP_AND_RECOVERY.md).', cfg }
  if ((await Organization.count()) > 1) {
    return { enabled: false, reason: 'This database holds several organizations, and a backup contains all of them. Backups are made from the command line by the server operator.', cfg }
  }
  return { enabled: true, reason: null, cfg }
}

export async function requireBackups() {
  const a = await availability()
  if (!a.enabled || !a.cfg) throw httpError(503, a.reason ?? 'Backups are not available', 'BACKUPS_UNAVAILABLE')
  return a.cfg
}

const describeDestination = async (dir: string | null, what: string) => {
  if (!dir) return null
  try {
    const d = await checkDestination(dir, what)
    return { label: d.label, ok: true, free_bytes: d.free, error: null as string | null }
  } catch (err) {
    return { label: null, ok: false, free_bytes: null, error: (err as Error).message }
  }
}

export async function overview() {
  const a = await availability()
  if (!a.enabled || !a.cfg) return { enabled: false, reason: a.reason, destination: null, copy: null, encrypted: false, job, busy: null, backups: [] }
  const cfg = a.cfg
  return {
    enabled: true,
    reason: null,
    destination: await describeDestination(cfg.dir, 'Backup folder'),
    copy: await describeDestination(cfg.copyDir, 'Second destination'),
    encrypted: Boolean(cfg.passphraseFile),
    job,
    busy: cfg.dir ? await lockInfo(cfg.dir) : null,
    backups: await listBackups(cfg),
  }
}

export async function startFullBackup(actor: Actor, meta: RequestMeta) {
  const cfg = await requireBackups()
  if (job?.state === 'running' || (cfg.dir && (await lockInfo(cfg.dir)))) throw httpError(409, 'A backup job is already running', 'BACKUP_RUNNING')
  const current: Job = {
    id: crypto.randomUUID(),
    state: 'running',
    step: 'Starting',
    started_at: new Date().toISOString(),
    finished_at: null,
    started_by: [actor.first_name, actor.last_name].filter(Boolean).join(' ') || actor.email,
    result: null,
    error: null,
  }
  job = current
  const db = { host: env.db.host, port: env.db.port, user: env.db.user, password: env.db.password, name: env.db.name }
  void createFullBackup({ db, cfg, onStep: (s) => (current.step = s) })
    .then(async (r) => {
      current.state = 'done'
      current.result = { name: r.name, status: r.sidecar.status, bytes: r.sidecar.package_bytes, copy: r.copy }
      await audit(meta, { action: 'BACKUP_CREATE', entityType: 'backup', entityId: r.sidecar.backup_id, after: { name: r.name, status: r.sidecar.status, copied: r.copy.ok } }).catch(() => {})
    })
    .catch(async (err) => {
      current.state = 'failed'
      current.error = err instanceof BackupError ? err.message : 'The backup failed unexpectedly; see the server log'
      if (!(err instanceof BackupError)) console.error('[backup] failed', err)
      await audit(meta, { action: 'BACKUP_FAILED', entityType: 'backup', entityId: current.id, after: { error: current.error } }).catch(() => {})
    })
    .finally(() => (current.finished_at = new Date().toISOString()))
  return current
}
