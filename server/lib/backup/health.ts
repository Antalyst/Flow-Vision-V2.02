import fsp from 'node:fs/promises'
import path from 'node:path'
import type { BackupConfig } from './config.ts'

/**
 * What the backup jobs actually did, kept in BACKUP_DIR/backup-health.json by the command line and the
 * Backups page, so the page can show the last successful run of each job and the last failure. A scheduled
 * task existing proves nothing; only these records (and the backups' own verification) do.
 */

export const HEALTH_JOBS = ['full', 'copy', 'snapshot', 'forget', 'check', 'check_read_data', 'restore_test'] as const
export type HealthJob = (typeof HEALTH_JOBS)[number]

/** ok = done and complete; incomplete = done, but referenced files are missing from it; failed = not done. */
export type RunStatus = 'ok' | 'incomplete' | 'failed'

export interface Run {
  at: string
  status: RunStatus
  /** A short machine code (BackupError code) and the tool's own message; never a password or a document's content. */
  code: string | null
  message: string | null
  detail: Record<string, string | number | boolean | null> | null
}

export interface JobHealth {
  last_run: Run | null
  last_ok: Run | null
  last_failure: Run | null
}

export type Health = Partial<Record<HealthJob, JobHealth>>

const file = (cfg: BackupConfig) => path.join(cfg.dir!, 'backup-health.json')

export async function readHealth(cfg: BackupConfig): Promise<Health> {
  if (!cfg.dir) return {}
  try {
    return JSON.parse(await fsp.readFile(file(cfg), 'utf8')) as Health
  } catch {
    return {}
  }
}

/** Record one run. Never throws: a backup's result must not depend on writing its health record. */
export async function recordRun(cfg: BackupConfig, job: HealthJob, run: Omit<Run, 'at'> & { at?: string }) {
  if (!cfg.dir) return
  try {
    const entry: Run = { at: run.at ?? new Date().toISOString(), status: run.status, code: run.code, message: run.message?.slice(0, 500) ?? null, detail: run.detail }
    const health = await readHealth(cfg)
    const prev = health[job] ?? { last_run: null, last_ok: null, last_failure: null }
    health[job] = {
      last_run: entry,
      last_ok: entry.status === 'ok' ? entry : prev.last_ok,
      last_failure: entry.status === 'ok' ? prev.last_failure : entry,
    }
    const tmp = `${file(cfg)}.tmp-${process.pid}`
    await fsp.writeFile(tmp, JSON.stringify(health, null, 2))
    await fsp.rename(tmp, file(cfg))
  } catch {
    /* the backup folder may be missing — that failure is reported by the job itself */
  }
}
