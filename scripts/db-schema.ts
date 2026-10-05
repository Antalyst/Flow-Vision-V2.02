// (Re)creates the FlowVision schema from database/flowvision-complete-schema.sql.
// WARNING: drops every FlowVision table and view first. Refuses remote hosts unless --remote.
//   npm run db:schema
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
assertSafeTarget('schema', { host: env.db.host, port: env.db.port, name: env.db.name })

const VIEWS = ['active_documents_by_office', 'liaison_performance', 'pending_approvals']
const TABLES = [
  'approvals', 'audit_logs', 'auth_sessions', 'documents', 'document_files', 'document_tracking', 'document_types', 'issues', 'knowledge_files', 'liaisons', 'messages',
  'notifications', 'offices', 'organizations', 'organization_routes', 'qr_codes', 'route_steps', 'users',
]

const schemaPath = path.resolve(import.meta.dirname, '../database/flowvision-complete-schema.sql')
const connection = await mysql.createConnection({
  host: env.db.host,
  port: env.db.port,
  user: env.db.user,
  password: env.db.password,
  multipleStatements: true,
})

try {
  await connection.query(`CREATE DATABASE IF NOT EXISTS \`${env.db.name}\` CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci`)
  await connection.query(`USE \`${env.db.name}\``)
  // The export has no DROP statements, so clear the old objects first.
  await connection.query(
    `SET FOREIGN_KEY_CHECKS = 0;
     DROP VIEW IF EXISTS ${VIEWS.map((v) => `\`${v}\``).join(', ')};
     DROP TABLE IF EXISTS ${[...TABLES, ...VIEWS].map((t) => `\`${t}\``).join(', ')};
     SET FOREIGN_KEY_CHECKS = 1;`,
  )
  await connection.query(await fs.readFile(schemaPath, 'utf8'))
  const [rows] = await connection.query('SHOW FULL TABLES')
  const list = rows as Array<Record<string, string>>
  const tables = list.filter((r) => Object.values(r).includes('BASE TABLE')).length
  console.log(`[schema] applied to ${env.db.name}: ${tables} tables, ${list.length - tables} views`)
} finally {
  await connection.end()
}
