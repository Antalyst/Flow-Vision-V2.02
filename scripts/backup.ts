// FlowVision backups — see docs/BACKUP_AND_RECOVERY.md.
//
//   npm run backup -- init                         create/mark BACKUP_DIR (and BACKUP_COPY_DIR) as backup folders
//   npm run backup -- full [--no-copy] [--strict]  verified full backup; copied to BACKUP_COPY_DIR when set
//   npm run backup -- list                         backups in BACKUP_DIR and their status
//   npm run backup -- verify <name | path>         re-verify a backup (any package path, e.g. on the external drive)
//   npm run backup -- copy <name>                  copy a backup to BACKUP_COPY_DIR and verify the copy
//   npm run backup -- restore --package <name | path> [--files-dir <empty folder>] [--replace] [--remote]
//                                                  restore into RESTORE_DB_* (an isolated database by default)
//   npm run backup -- snapshot                     versioned snapshot into the Restic repository (RESTIC_REPOSITORY)
//   npm run backup -- snapshots | check [--read-data] | forget
//   npm run backup -- restore-snapshot --snapshot <id | latest> --target <empty folder>
//
// The source database is DB_* (from .env, like the app). Passwords are never printed or passed on a
// command line. Exit code 0 = done, 1 = failed, 2 = bad usage or configuration.
import os from 'node:os'
import path from 'node:path'
import readline from 'node:readline/promises'

try {
  process.loadEnvFile('.env')
} catch {
  /* no .env — rely on the environment */
}
const { env } = await import('../server/lib/env.ts')
const { BackupError, initDestination, readConfig, readPassphrase, labelOf } = await import('../server/lib/backup/config.ts')
const full = await import('../server/lib/backup/full.ts')
const { restoreBackup } = await import('../server/lib/backup/restore.ts')
const restic = await import('../server/lib/backup/restic.ts')

const [command = 'help', ...rest] = process.argv.slice(2)
const flags = new Map<string, string | true>()
const positional: string[] = []
for (let i = 0; i < rest.length; i++) {
  const a = rest[i]!
  if (!a.startsWith('--')) positional.push(a)
  else if (a.includes('=')) flags.set(a.slice(2, a.indexOf('=')), a.slice(a.indexOf('=') + 1))
  else if (rest[i + 1] && !rest[i + 1]!.startsWith('--') && ['package', 'files-dir', 'snapshot', 'target'].includes(a.slice(2))) flags.set(a.slice(2), rest[++i]!)
  else flags.set(a.slice(2), true)
}
const flag = (n: string) => (typeof flags.get(n) === 'string' ? (flags.get(n) as string) : null)

const log = (s: string) => console.log(`[backup] ${s}`)
const mb = (n: number | null | undefined) => (n == null ? '?' : `${(n / 1024 / 1024).toFixed(1)} MB`)
const source = { host: env.db.host, port: env.db.port, user: env.db.user, password: env.db.password, name: env.db.name }
// Read inside main(), so a configuration mistake is reported like any other error.
let cfg: ReturnType<typeof readConfig>

/** A backup by name in BACKUP_DIR, or a path to a package / folder. */
function locate(arg: string | null) {
  if (!arg) throw new BackupError('USAGE', 'Say which backup: a name from `npm run backup -- list`, or a path')
  const byName = full.packagePath(cfg, arg)
  return byName ?? path.resolve(arg)
}

async function confirm(question: string, expected: string) {
  if (!process.stdin.isTTY) throw new BackupError('CONFIRM', 'This needs a typed confirmation: run it in an interactive terminal')
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout })
  try {
    return (await rl.question(`${question}\nType ${expected} to continue: `)).trim() === expected
  } finally {
    rl.close()
  }
}

async function main() {
  cfg = readConfig()
  switch (command) {
    case 'init': {
      if (!cfg.dir) throw new BackupError('NOT_CONFIGURED', 'Set BACKUP_DIR (an absolute folder path) first')
      const a = await initDestination(cfg.dir, 'Backup folder (BACKUP_DIR)')
      log(`backup folder ready: ${a.label} (${mb(a.free)} free)`)
      if (cfg.copyDir) {
        const b = await initDestination(cfg.copyDir, 'Second destination (BACKUP_COPY_DIR)')
        log(`second destination ready: ${b.label} (${mb(b.free)} free)`)
      } else log('no BACKUP_COPY_DIR: backups will exist on this computer only')
      if (process.env.RESTIC_REPOSITORY) {
        const r = await restic.initRepository(cfg)
        log(`Restic repository ${r.created ? 'created' : 'already present'}: ${r.label}`)
      }
      return
    }
    case 'full': {
      const r = await full.createFullBackup({ db: source, cfg, copy: !flags.has('no-copy'), strict: flags.has('strict'), onStep: (s) => log(`${s}…`) })
      const s = r.sidecar
      log(`created ${path.basename(r.file)} (${mb(s.package_bytes)}${s.encrypted ? ', encrypted' : ''})`)
      log(`status ${s.status}: ${s.summary.tables} tables, ${s.summary.rows} rows, ${s.summary.files_in_package} files in the package, ${s.summary.files_in_database} in the database dump`)
      for (const w of s.warnings) log(`warning: ${w}`)
      log(`sha256 ${s.package_sha256}`)
      if (r.copy.ok) log(`copied and verified on ${r.copy.destination}: the backup now exists in two places`)
      else if (r.copy.attempted) {
        log(`NOT copied to ${r.copy.destination}: ${r.copy.error}`)
        log('the backup exists ON THIS COMPUTER ONLY; fix the drive and run: npm run backup -- copy ' + r.name)
        process.exitCode = 1
      } else log('the backup exists ON THIS COMPUTER ONLY (no BACKUP_COPY_DIR)')
      return
    }
    case 'list': {
      const list = await full.listBackups(cfg)
      if (!list.length) log(cfg.dir ? 'no backups yet' : 'BACKUP_DIR is not set')
      for (const b of list) {
        console.log(`${b.name}  ${b.status.padEnd(22)} ${mb(b.bytes).padStart(10)}  ${b.encrypted ? 'encrypted ' : ''}copies: ${b.copies.map((c) => c.destination).join(', ') || 'none'}`)
      }
      return
    }
    case 'verify': {
      const target = locate(positional[0] ?? flag('package'))
      const name = path.basename(target).replace(/\.zip(\.fvenc)?$/, '')
      if (full.packagePath(cfg, name) === target) {
        const v = await full.verifyStored(cfg, name)
        for (const e of v.errors) log(`error: ${e}`)
        for (const w of v.warnings) log(`warning: ${w}`)
        log(v.ok ? (v.deep ? 'verified: every checksum, the dump and every file' : 'file checksum verified; set BACKUP_PASSPHRASE_FILE for a full check of the encrypted contents') : 'VERIFICATION FAILED')
        if (!v.ok) process.exitCode = 1
        return
      }
      const { verifyPackage, sha256File } = await import('../server/lib/backup/package.ts')
      const v = await verifyPackage(target, { passphrase: await readPassphrase(cfg).catch(() => null), scratchDir: os.tmpdir() })
      for (const e of v.errors) log(`error: ${e}`)
      for (const w of v.warnings) log(`warning: ${w}`)
      log(v.ok ? `verified (${v.entries} entries, ${mb(v.bytes)}); package sha256 ${await sha256File(target).catch(() => '(folder)')}` : 'VERIFICATION FAILED')
      if (!v.ok) process.exitCode = 1
      return
    }
    case 'copy': {
      const name = positional[0]
      if (!name) throw new BackupError('USAGE', 'npm run backup -- copy <name>')
      const c = await full.copyToDestination(cfg, name)
      log(`copied and verified on ${c.destination} (sha256 ${c.sha256})`)
      return
    }
    case 'restore': {
      const location = locate(flag('package'))
      const name = process.env.RESTORE_DB_NAME?.trim()
      if (!name) throw new BackupError('USAGE', 'Set RESTORE_DB_HOST, RESTORE_DB_PORT, RESTORE_DB_USER, RESTORE_DB_PASS and RESTORE_DB_NAME (the database to restore into)')
      const target = {
        host: process.env.RESTORE_DB_HOST?.trim() || 'localhost',
        port: Number(process.env.RESTORE_DB_PORT || 3306),
        user: process.env.RESTORE_DB_USER?.trim() || 'root',
        password: process.env.RESTORE_DB_PASS ?? '',
        name,
      }
      const live = target.host.toLowerCase() === source.host.toLowerCase() && target.port === source.port && target.name === source.name
      const replace = flags.has('replace')
      if (replace) {
        log(`--replace: everything in ${target.host}:${target.port}/${target.name} will be DELETED and replaced by the backup.`)
        log('Make sure you have a current, verified backup of that database first.')
        if (!(await confirm('This cannot be undone.', target.name))) throw new BackupError('CANCELLED', 'Cancelled; nothing was changed')
        if (live && !(await confirm('This is the LIVE database the application uses (DB_*).', `REPLACE LIVE ${target.name}`))) throw new BackupError('CANCELLED', 'Cancelled; nothing was changed')
      }
      const filesDir = flag('files-dir') ? path.resolve(flag('files-dir')!) : null
      const r = await restoreBackup({
        location,
        passphrase: await readPassphrase(cfg).catch(() => null),
        scratchDir: cfg.dir ?? os.tmpdir(),
        target,
        filesDir,
        replace,
        allowRemote: flags.has('remote'),
        liveConfirmed: replace && live,
        live: source,
        clientBin: cfg.clientBin,
        dumpBin: cfg.dumpBin,
        onStep: (s) => log(`${s}…`),
      })
      for (const n of r.check.notes) log(n)
      for (const e of r.check.errors) log(`error: ${e}`)
      log(r.check.ok ? `restored ${r.manifest.name} into ${target.name}${filesDir ? ` and ${labelOf(filesDir)}` : ''}; all checks passed` : 'RESTORED, BUT THE CHECKS FOUND PROBLEMS (above)')
      if (filesDir) log(`to use it: point a FlowVision copy at RESTORE_DB_* and set UPLOAD_DIR=${filesDir}`)
      if (!r.check.ok) process.exitCode = 1
      return
    }
    case 'snapshot': {
      const r = await restic.snapshot({ db: source, cfg, onStep: (s) => log(`${s}…`) })
      log(`snapshot ${r.snapshot} saved (${r.tags.join(', ')}); restore-tested: ${r.verified ? 'yes' : 'NO'}`)
      log(`logical size ${mb(r.logicalBytes)}; added to the repository: ${mb(r.addedBytes)} (deduplicated)`)
      if (!r.verified) process.exitCode = 1
      return
    }
    case 'snapshots': {
      for (const s of await restic.snapshots(cfg)) console.log(`${s.short_id}  ${s.time}  ${(s.tags ?? []).join(',')}`)
      return
    }
    case 'check': {
      await restic.check(cfg, { readData: flags.has('read-data') })
      log('repository check passed')
      return
    }
    case 'forget': {
      const r = await restic.forget(cfg)
      log(`retention applied (daily ${cfg.retain.daily}, weekly ${cfg.retain.weekly}, monthly ${cfg.retain.monthly}): kept ${r.kept}, removed ${r.removed}`)
      return
    }
    case 'restore-snapshot': {
      const target = flag('target')
      if (!target) throw new BackupError('USAGE', '--target <empty folder>')
      const r = await restic.restoreSnapshot(cfg, flag('snapshot') ?? 'latest', path.resolve(target))
      log(`snapshot ${r.snapshot} restored to ${labelOf(r.dir)} and verified. Restore the database from it with:`)
      log(`npm run backup -- restore --package "${r.dir}" --files-dir <empty folder>`)
      return
    }
    default:
      console.log('Usage: npm run backup -- init | full | list | verify <name|path> | copy <name> | restore --package … | snapshot | snapshots | check | forget | restore-snapshot …')
      console.log('See docs/BACKUP_AND_RECOVERY.md')
      if (command !== 'help') process.exitCode = 2
  }
}

try {
  await main()
} catch (err) {
  if (err instanceof BackupError) {
    console.error(`[backup] ${err.code}: ${err.message}`)
    process.exitCode = ['USAGE', 'CONFIG', 'NOT_CONFIGURED', 'CANCELLED'].includes(err.code) ? 2 : 1
  } else {
    console.error(`[backup] failed: ${(err as Error).message}`)
    process.exitCode = 1
  }
}
