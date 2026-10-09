// Adds only the Organization Settings tables — working hours (organization_settings), holidays
// (organization_holidays) and document templates (document_templates) — to an existing database.
// Creates what's missing and touches nothing else (no existing table or row is changed), so it's
// safe on the hosted database. Refuses remote hosts unless --remote.
//   node scripts/db-add-settings.ts [--remote]
import fs from 'node:fs/promises'
import path from 'node:path'
import mysql from 'mysql2/promise'
import { assertSafeTarget } from './guard.ts'

try {
  process.loadEnvFile('.env')
} catch {
  /* no .env — rely on the environment */
}
const { env } = await import('../server/lib/env.ts')
assertSafeTarget('settings', { host: env.db.host, port: env.db.port, name: env.db.name })

const connection = await mysql.createConnection({ host: env.db.host, port: env.db.port, user: env.db.user, password: env.db.password, database: env.db.name })
const schemaSql = await fs.readFile(path.resolve(import.meta.dirname, '../database/flowvision-complete-schema.sql'), 'utf8')

try {
  for (const table of ['organization_settings', 'organization_holidays', 'document_templates']) {
    const [rows] = await connection.query('SELECT 1 FROM information_schema.TABLES WHERE TABLE_SCHEMA = ? AND TABLE_NAME = ?', [env.db.name, table])
    if ((rows as unknown[]).length) {
      console.log(`[settings] ${table} already present`)
      continue
    }
    const ddl = schemaSql.match(new RegExp(`CREATE TABLE \`${table}\` \\([\\s\\S]*?\\) ENGINE=[^\\n]*;`))?.[0]
    if (!ddl) throw new Error(`CREATE TABLE ${table} not found in the schema file`)
    await connection.query(ddl)
    console.log(`[settings] ${table} created`)
  }
} finally {
  await connection.end()
}
