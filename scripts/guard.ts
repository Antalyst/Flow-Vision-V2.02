// Shared safety check for the database scripts: never touch a remote database by accident.
const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1', '::1', 'host.docker.internal'])

/**
 * Exits on refusal; with `exit: false` it returns false instead (exit code 1 already set), for a
 * script that must not call process.exit() (scripts/admin-bootstrap.ts).
 */
export function assertSafeTarget(action: string, db: { host: string; port: number; name: string }, { exit = true } = {}) {
  const target = `${db.host}:${db.port}/${db.name}`
  if (LOCAL_HOSTS.has(db.host)) {
    console.log(`[${action}] target ${target}`)
    return true
  }
  if (!process.argv.includes('--remote')) {
    console.error(`[${action}] refusing to run against the remote database ${target}.`)
    console.error(`[${action}] Point DB_HOST at a local database, or re-run with --remote if you really mean it.`)
    if (exit) process.exit(1)
    process.exitCode = 1
    return false
  }
  console.warn(`[${action}] --remote given: running against ${target}`)
  return true
}
