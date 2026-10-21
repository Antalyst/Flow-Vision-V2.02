import fs from 'node:fs'
import fsp from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { spawn, execFile } from 'node:child_process'
import { Transform, type Readable, type Writable } from 'node:stream'
import { pipeline } from 'node:stream/promises'
// The callback module with .promise(): mysql2/promise does not survive the Nitro bundle (db.ts uses mysql2 too).
import mysql from 'mysql2'
import { BackupError } from './config.ts'

/**
 * The database half of a backup: what the server is, what it holds, and a consistent export made
 * with the engine's own dump utility (mariadb-dump for MariaDB, mysqldump for MySQL).
 * Credentials reach the utilities only through a temporary option file in this Windows account's
 * private temp folder, deleted right after — never on a command line, in a log or in the package.
 */

export interface DbTarget {
  host: string
  port: number
  user: string
  password: string
  name: string
}

export async function connect(db: DbTarget, { database = true } = {}) {
  const c = mysql.createConnection({ host: db.host, port: db.port, user: db.user, password: db.password, ...(database && { database: db.name }), connectTimeout: 15_000, multipleStatements: false }).promise()
  await c.connect()
  return c
}

export type Conn = Awaited<ReturnType<typeof connect>>

const rows = async <T>(c: Conn, sql: string, params: unknown[] = []) => (await c.query(sql, params))[0] as T[]

export interface ServerInfo {
  engine: 'MariaDB' | 'MySQL'
  version: string
  major: number
  minor: number
}

export async function serverInfo(c: Conn): Promise<ServerInfo> {
  const v = (await rows<{ v: string }>(c, 'SELECT VERSION() AS v'))[0]?.v ?? '0.0.0'
  const [major = 0, minor = 0] = v.split(/[.-]/).map(Number)
  return { engine: /mariadb/i.test(v) ? 'MariaDB' : 'MySQL', version: v, major, minor }
}

export interface Inventory {
  tables: Array<{ name: string; engine: string | null }>
  views: string[]
  routines: number
  triggers: number
  events: number
  /** Rough size (data + indexes) for the free-space check. */
  bytes: number
}

export async function inventory(c: Conn, db: string): Promise<Inventory> {
  const objects = await rows<{ name: string; type: string; engine: string | null; bytes: number | null }>(
    c,
    'SELECT TABLE_NAME AS name, TABLE_TYPE AS type, ENGINE AS engine, DATA_LENGTH + INDEX_LENGTH AS bytes FROM information_schema.TABLES WHERE TABLE_SCHEMA = ? ORDER BY TABLE_NAME',
    [db],
  )
  const count = async (sql: string) => Number((await rows<{ n: number }>(c, sql, [db]))[0]?.n ?? 0)
  return {
    tables: objects.filter((o) => o.type === 'BASE TABLE').map((o) => ({ name: o.name, engine: o.engine })),
    views: objects.filter((o) => o.type === 'VIEW').map((o) => o.name),
    routines: await count('SELECT COUNT(*) AS n FROM information_schema.ROUTINES WHERE ROUTINE_SCHEMA = ?'),
    triggers: await count('SELECT COUNT(*) AS n FROM information_schema.TRIGGERS WHERE TRIGGER_SCHEMA = ?'),
    events: await count('SELECT COUNT(*) AS n FROM information_schema.EVENTS WHERE EVENT_SCHEMA = ?'),
    bytes: objects.reduce((n, o) => n + Number(o.bytes ?? 0), 0),
  }
}

export async function rowCounts(c: Conn, tables: string[]) {
  const out: Record<string, number> = {}
  for (const t of tables) out[t] = Number((await rows<{ n: number }>(c, `SELECT COUNT(*) AS n FROM \`${t.replace(/`/g, '``')}\``))[0]!.n)
  return out
}

/** Where the database points at stored files: table, column and the rows' keys. */
const FILE_COLUMNS: Array<{ table: string; column: string }> = [
  { table: 'documents', column: 'file_url' },
  { table: 'document_files', column: 'file_url' },
  { table: 'knowledge_files', column: 'file_url' },
  { table: 'organizations', column: 'logo_url' },
  // Legacy (feature removed): signature images of document templates, while the table exists.
  { table: 'document_templates', column: 'signature_url' },
]

export interface FileRef {
  key: string
  table: string
  id: string
}

export async function fileReferences(c: Conn, tables: string[]): Promise<FileRef[]> {
  const out: FileRef[] = []
  for (const { table, column } of FILE_COLUMNS) {
    if (!tables.includes(table)) continue
    const list = await rows<{ id: string; k: string }>(c, `SELECT id, \`${column}\` AS k FROM \`${table}\` WHERE \`${column}\` IS NOT NULL AND \`${column}\` <> ''`)
    for (const r of list) out.push({ key: r.k, table, id: r.id })
  }
  return out
}

/** Files kept in the database (file_blobs, complete ones only): key → parts and bytes. */
export async function blobIndex(c: Conn, tables: string[]) {
  const map = new Map<string, { parts: number; bytes: number }>()
  if (!tables.includes('file_blobs')) return map
  const list = await rows<{ k: string; parts: number; bytes: number }>(c, 'SELECT file_url AS k, COUNT(*) AS parts, SUM(size) AS bytes FROM file_blobs WHERE complete = 1 GROUP BY file_url')
  for (const r of list) map.set(r.k, { parts: Number(r.parts), bytes: Number(r.bytes) })
  return map
}

// ---------------------------------------------------------------------------
// The utilities
// ---------------------------------------------------------------------------

const run = (bin: string, args: string[]) =>
  new Promise<string>((resolve, reject) => execFile(bin, args, { windowsHide: true, timeout: 20_000 }, (err, stdout) => (err ? reject(err) : resolve(String(stdout)))))

function onPath(names: string[]) {
  for (const dir of (process.env.PATH ?? '').split(path.delimiter)) {
    for (const n of names) {
      for (const ext of process.platform === 'win32' ? ['.exe', ''] : ['']) {
        const p = path.join(dir, n + ext)
        if (dir && fs.existsSync(p)) return p
      }
    }
  }
  return null
}

export interface Tool {
  bin: string
  flavor: 'MariaDB' | 'MySQL'
  version: string
  major: number
}

async function describe(bin: string): Promise<Tool> {
  if (!fs.existsSync(bin)) throw new BackupError('TOOL_MISSING', `Database utility not found: ${bin}`)
  const text = await run(bin, ['--version']).catch(() => {
    throw new BackupError('TOOL_BROKEN', `Could not run ${path.basename(bin)} --version`)
  })
  const maria = /mariadb/i.test(text)
  // "from 11.8.3-MariaDB" / "Distrib 10.4.32-MariaDB" / "Ver 9.1.0 for Win64"
  const v = /(?:from|Distrib)\s+(\d+\.\d+\.\d+)/.exec(text)?.[1] ?? /Ver\s+(\d+\.\d+\.\d+)/.exec(text)?.[1] ?? '0.0.0'
  return { bin, flavor: maria ? 'MariaDB' : 'MySQL', version: v, major: Number(v.split('.')[0]) }
}

/** The dump utility: BACKUP_DUMP_BIN, else mariadb-dump / mysqldump on PATH. Must match the server's engine. */
export async function dumpTool(configured: string | null, server: ServerInfo) {
  const bin = configured ?? onPath(server.engine === 'MariaDB' ? ['mariadb-dump', 'mysqldump'] : ['mysqldump'])
  if (!bin) throw new BackupError('TOOL_MISSING', `No ${server.engine === 'MariaDB' ? 'mariadb-dump' : 'mysqldump'} found. Install the ${server.engine} client tools and set BACKUP_DUMP_BIN to the utility's full path.`)
  const tool = await describe(bin)
  const warnings: string[] = []
  if (tool.flavor !== server.engine) {
    throw new BackupError('TOOL_MISMATCH', `${path.basename(bin)} is a ${tool.flavor} ${tool.version} utility but the server is ${server.engine} ${server.version}. Use the ${server.engine} client tools (BACKUP_DUMP_BIN).`)
  }
  if (tool.major < server.major) warnings.push(`The dump utility (${tool.flavor} ${tool.version}) is older than the server (${server.version}); a matching ${server.engine} ${server.major}.x client is recommended.`)
  return { tool, warnings }
}

/** The command-line client (for restores): BACKUP_MYSQL_BIN, else the one next to the dump utility, else PATH. */
export async function clientTool(configured: string | null, dumpBin: string | null, engine: 'MariaDB' | 'MySQL') {
  const ext = process.platform === 'win32' ? '.exe' : ''
  const sibling = dumpBin ? [path.join(path.dirname(dumpBin), `mariadb${ext}`), path.join(path.dirname(dumpBin), `mysql${ext}`)].find((p) => fs.existsSync(p)) : null
  const bin = configured ?? sibling ?? onPath(engine === 'MariaDB' ? ['mariadb', 'mysql'] : ['mysql'])
  if (!bin) throw new BackupError('TOOL_MISSING', 'No mariadb / mysql client found. Set BACKUP_MYSQL_BIN to its full path.')
  return describe(bin)
}

/** Option-file value: quoted, with backslashes escaped (the option-file syntax). */
function optionValue(v: string) {
  if (/[\r\n]/.test(v)) throw new BackupError('CONFIG', 'Database credentials may not contain line breaks')
  const q = v.includes('"') ? "'" : '"'
  if (v.includes(q)) throw new BackupError('CONFIG', 'The database password contains both kinds of quote, which the option file cannot hold')
  return `${q}${v.replace(/\\/g, '\\\\')}${q}`
}

/** A temporary [client] option file with the credentials, in a private temp folder; removed by `cleanup`. */
async function optionFile(db: DbTarget) {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'fv-db-'))
  const file = path.join(dir, 'client.cnf')
  await fsp.writeFile(file, `[client]\nhost=${optionValue(db.host)}\nport=${db.port}\nuser=${optionValue(db.user)}\npassword=${optionValue(db.password)}\n`, { mode: 0o600 })
  return { file, cleanup: () => fsp.rm(dir, { recursive: true, force: true }) }
}

/** Keep stderr short and free of anything that looks like a credential. */
const clean = (text: string, db: DbTarget) =>
  text
    .split(db.password || '\u0000')
    .join('***')
    .split(/\r?\n/)
    .filter((l) => l.trim() && !/Using a password on the command line/i.test(l))
    .slice(-8)
    .join('\n')
    .slice(0, 2000)

/**
 * Watches the SQL as it streams by: the tables and views it contains (from the utility's own
 * "-- Table structure for table `x`" comments) and whether it ends with "-- Dump completed".
 */
export function dumpScanner() {
  const seen = { tables: new Set<string>(), views: new Set<string>(), completed: false, bytes: 0 }
  let line = ''
  let tail = ''
  const take = (s: string) => {
    const t = /^-- Table structure for table `(.+)`$/.exec(s)
    if (t) seen.tables.add(t[1]!.replace(/``/g, '`'))
    const v = /^-- Final view structure for view `(.+)`$/.exec(s)
    if (v) seen.views.add(v[1]!.replace(/``/g, '`'))
  }
  const stream = new Transform({
    transform(chunk: Buffer, _e, done) {
      seen.bytes += chunk.length
      const text = chunk.toString('latin1')
      let start = 0
      for (let i = text.indexOf('\n'); i !== -1; i = text.indexOf('\n', start)) {
        // Only the start of a line matters; long data lines are not kept whole.
        take((line + text.slice(start, Math.min(i, start + 300))).replace(/\r$/, ''))
        line = ''
        start = i + 1
      }
      if (line.length < 300) line += text.slice(start, start + 300 - line.length)
      tail = (tail + text).slice(-200)
      done(null, chunk)
    },
    flush(done) {
      if (line) take(line)
      seen.completed = /-- Dump completed/.test(tail)
      done()
    },
  })
  return { stream, seen }
}

export async function runDump(tool: Tool, db: DbTarget, opts: { events: boolean; routines: boolean }, output: Writable) {
  const cnf = await optionFile(db)
  try {
    const args = [
      `--defaults-extra-file=${cnf.file}`,
      '--single-transaction',
      '--quick',
      '--hex-blob',
      '--default-character-set=utf8mb4',
      '--triggers',
      opts.routines ? '--routines' : '--skip-routines',
      opts.events ? '--events' : '--skip-events',
      '--no-tablespaces',
      ...(tool.flavor === 'MySQL' ? ['--set-gtid-purged=OFF'] : []),
      db.name,
    ]
    const child = spawn(tool.bin, args, { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] })
    let stderr = ''
    child.stderr.on('data', (d) => (stderr = (stderr + d).slice(-20_000)))
    const exited = new Promise<number>((resolve, reject) => {
      child.on('error', reject)
      child.on('close', (code) => resolve(code ?? -1))
    })
    const scan = dumpScanner()
    try {
      await pipeline(child.stdout as Readable, scan.stream, output)
    } catch (err) {
      child.kill()
      throw err
    }
    const code = await exited
    if (code !== 0) throw new BackupError('DUMP_FAILED', `${path.basename(tool.bin)} failed (exit ${code}): ${clean(stderr, db) || 'no message'}`)
    return { ...scan.seen, warnings: clean(stderr, db) }
  } finally {
    await cnf.cleanup()
  }
}

/**
 * Rewrites the few lines that name a DEFINER (views, triggers, routines) so a dump restores under
 * any account: the objects are then owned by the account doing the restore. Data lines pass as is.
 */
export function stripDefiners() {
  let carry = ''
  // Only DDL lines (versioned comments, CREATE …): a data row may contain the text DEFINER= itself.
  const fix = (s: string) =>
    (s.startsWith('/*!') || s.startsWith('CREATE ')) && s.includes('DEFINER=`')
      ? s.replace(/\/\*!50013 DEFINER=`(?:[^`]|``)*`@`(?:[^`]|``)*` SQL SECURITY DEFINER \*\/\s*/g, '').replace(/ DEFINER=`(?:[^`]|``)*`@`(?:[^`]|``)*`/g, '')
      : s
  return new Transform({
    transform(chunk: Buffer, _e, done) {
      const text = carry + chunk.toString('latin1')
      const cut = text.lastIndexOf('\n')
      if (cut === -1) {
        carry = text
        return done()
      }
      carry = text.slice(cut + 1)
      const body = text.slice(0, cut + 1)
      // Fast path: no DEFINER in this block.
      done(null, Buffer.from(body.includes('DEFINER=') ? body.split('\n').map(fix).join('\n') : body, 'latin1'))
    },
    flush(done) {
      done(null, carry ? Buffer.from(fix(carry), 'latin1') : undefined)
    },
  })
}

/** Load SQL into a database with the client utility. */
export async function runSql(tool: Tool, db: DbTarget, input: Readable) {
  const cnf = await optionFile(db)
  try {
    const child = spawn(tool.bin, [`--defaults-extra-file=${cnf.file}`, '--default-character-set=utf8mb4', '--max-allowed-packet=1G', '--batch', db.name], { windowsHide: true, stdio: ['pipe', 'ignore', 'pipe'] })
    let stderr = ''
    child.stderr.on('data', (d) => (stderr = (stderr + d).slice(-20_000)))
    const exited = new Promise<number>((resolve, reject) => {
      child.on('error', reject)
      child.on('close', (code) => resolve(code ?? -1))
    })
    let piped: unknown = null
    try {
      await pipeline(input, stripDefiners(), child.stdin)
    } catch (err) {
      // The client may have stopped on an SQL error (its message is the useful one), or the input failed.
      piped = err
      child.kill()
    }
    const code = await exited.catch(() => -1)
    if (piped && code === 0) throw piped
    if (code !== 0) throw new BackupError('RESTORE_SQL_FAILED', `${path.basename(tool.bin)} failed (exit ${code}): ${clean(stderr, db) || 'no message'}`)
  } finally {
    await cnf.cleanup()
  }
}
