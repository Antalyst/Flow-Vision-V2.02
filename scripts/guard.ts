// Shared safety check for the database scripts: never touch a remote database by accident.
const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1', '::1', 'host.docker.internal'])

export function assertSafeTarget(action: string, db: { host: string; port: number; name: string }) {
  const target = `${db.host}:${db.port}/${db.name}`
  if (LOCAL_HOSTS.has(db.host)) {
    console.log(`[${action}] target ${target}`)
    return
  }
  if (!process.argv.includes('--remote')) {
    console.error(`[${action}] refusing to run against the remote database ${target}.`)
    console.error(`[${action}] Point DB_HOST at a local database, or re-run with --remote if you really mean it.`)
    process.exit(1)
  }
  console.warn(`[${action}] --remote given: running against ${target}`)
}
