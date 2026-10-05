// Applies additive schema changes to an existing FlowVision database without dropping data.
// Each step checks first, so it is safe to run more than once. Refuses remote hosts unless --remote.
//   npm run db:migrate
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
assertSafeTarget('migrate', { host: env.db.host, port: env.db.port, name: env.db.name })

const connection = await mysql.createConnection({ host: env.db.host, port: env.db.port, user: env.db.user, password: env.db.password, database: env.db.name })

async function hasColumn(table: string, column: string) {
  const [rows] = await connection.query('SELECT 1 FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = ? AND TABLE_NAME = ? AND COLUMN_NAME = ?', [env.db.name, table, column])
  return (rows as unknown[]).length > 0
}

async function hasTable(table: string) {
  const [rows] = await connection.query('SELECT 1 FROM information_schema.TABLES WHERE TABLE_SCHEMA = ? AND TABLE_NAME = ?', [env.db.name, table])
  return (rows as unknown[]).length > 0
}

async function hasIndex(table: string, index: string) {
  const [rows] = await connection.query('SELECT 1 FROM information_schema.STATISTICS WHERE TABLE_SCHEMA = ? AND TABLE_NAME = ? AND INDEX_NAME = ?', [env.db.name, table, index])
  return (rows as unknown[]).length > 0
}

/**
 * Every document carries one permanent routing code ({ORIGIN_CODE}-{8 digits}) from upload on.
 * The origin is the uploader's assigned office, or their organization for accounts without one
 * (CLIENT). Documents without a code in that format get one now, and documents uploaded by an
 * account without an office get the organization prefix if they carry an office's.
 */
async function backfillRoutingCodes() {
  const { ROUTING_CODE_RE, buildRoutingCode, organizationCode } = await import('../server/lib/qr.ts')
  const [orgRows] = await connection.query('SELECT g.id, g.name, o.code FROM organizations g LEFT JOIN offices o ON o.org_id = g.id')
  const orgCodes = new Map<string, string>()
  const byOrg = new Map<string, { name: string; codes: string[] }>()
  for (const r of orgRows as Array<{ id: string; name: string; code: string | null }>) {
    const entry = byOrg.get(r.id) ?? { name: r.name, codes: [] }
    if (r.code) entry.codes.push(r.code)
    byOrg.set(r.id, entry)
  }
  for (const [id, { name, codes }] of byOrg) orgCodes.set(id, organizationCode(name, codes))

  const [rows] = await connection.query(`
    SELECT d.id, d.org_id, q.id AS qr_id, q.qr_code_data AS code, q.office_code AS qr_prefix, uo.code AS uploader_office_code
    FROM documents d
    JOIN users u ON u.id = d.submitted_by
    LEFT JOIN offices uo ON uo.id = u.office_id
    LEFT JOIN qr_codes q ON q.document_id = d.id`)
  const docs = rows as Array<{ id: string; org_id: string; qr_id: string | null; code: string | null; qr_prefix: string | null; uploader_office_code: string | null }>
  const taken = new Set(docs.map((d) => d.code).filter(Boolean))
  let issued = 0
  for (const doc of docs) {
    const prefix = doc.uploader_office_code ?? orgCodes.get(doc.org_id) ?? 'ORG'
    const valid = Boolean(doc.code && ROUTING_CODE_RE.test(doc.code))
    // Office uploads keep a valid code; organization uploads must carry the organization prefix.
    if (valid && (doc.uploader_office_code || doc.qr_prefix === prefix)) continue
    let code = buildRoutingCode(prefix)
    while (taken.has(code)) code = buildRoutingCode(prefix)
    taken.add(code)
    if (doc.qr_id) {
      await connection.query('UPDATE qr_codes SET qr_code_data = ?, office_code = ? WHERE id = ?', [code, prefix, doc.qr_id])
    } else {
      await connection.query('INSERT INTO qr_codes (id, document_id, qr_code_data, office_code) VALUES (UUID(), ?, ?, ?)', [doc.id, code, prefix])
    }
    issued++
  }
  console.log(`[migrate] routing codes: ${issued} issued or corrected (reprint those labels)`)
}

try {
  // Route steps take days + hours to process (total = sla_days * 24 + sla_hours).
  if (!(await hasColumn('route_steps', 'sla_hours'))) {
    await connection.query("ALTER TABLE `route_steps` ADD COLUMN `sla_hours` int(11) NOT NULL DEFAULT 0 COMMENT 'Service level agreement hours (added to sla_days)' AFTER `sla_days`")
    console.log('[migrate] route_steps.sla_hours added')
  } else {
    console.log('[migrate] route_steps.sla_hours already present')
  }

  // Step 0 (the origin) of a CLIENT upload is the organization itself, not an office.
  const [trackingOffice] = await connection.query(
    "SELECT IS_NULLABLE FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = ? AND TABLE_NAME = 'document_tracking' AND COLUMN_NAME = 'office_id'",
    [env.db.name],
  )
  if ((trackingOffice as Array<{ IS_NULLABLE: string }>)[0]?.IS_NULLABLE === 'NO') {
    await connection.query("ALTER TABLE `document_tracking` MODIFY `office_id` char(36) DEFAULT NULL COMMENT 'Office location (NULL = the organization itself, for step 0 of a CLIENT upload)'")
    console.log('[migrate] document_tracking.office_id made nullable')
  } else {
    console.log('[migrate] document_tracking.office_id already nullable')
  }

  await backfillRoutingCodes()

  // Organization Settings: document types and AI knowledge files. The DDL comes straight from the
  // schema file, so the two can't drift apart.
  const schemaSql = await fs.readFile(path.resolve(import.meta.dirname, '../database/flowvision-complete-schema.sql'), 'utf8')
  // …plus AI Assistant chat history (conversations before their messages, for the foreign key).
  for (const table of ['document_types', 'knowledge_files', 'document_files', 'ai_conversations', 'ai_messages']) {
    if (await hasTable(table)) {
      console.log(`[migrate] ${table} already present`)
      continue
    }
    // The statement ends at the end of its ENGINE=… line (a comment there may itself contain ";").
    const ddl = schemaSql.match(new RegExp(`CREATE TABLE \`${table}\` \\([\\s\\S]*?\\) ENGINE=[^\\n]*;`))?.[0]
    if (!ddl) throw new Error(`CREATE TABLE ${table} not found in the schema file`)
    await connection.query(ddl)
    console.log(`[migrate] ${table} created`)
  }
  // Document types carry the processing time (it used to be set per office on each route).
  const { DEFAULT_DOCUMENT_TYPES } = await import('../server/lib/knowledge.ts')
  if (!(await hasColumn('document_types', 'processing_days'))) {
    await connection.query(
      "ALTER TABLE `document_types` ADD COLUMN `processing_days` int(11) NOT NULL DEFAULT 0 COMMENT 'How long a document of this type may take: days' AFTER `description`, " +
        "ADD COLUMN `processing_hours` int(11) NOT NULL DEFAULT 0 COMMENT '… plus hours (0–23); 0 + 0 = no deadline' AFTER `processing_days`",
    )
    // Give the starter types their starting times (the CLIENT can change them in Organization Settings).
    for (const t of DEFAULT_DOCUMENT_TYPES) {
      await connection.query('UPDATE document_types SET processing_days = ? WHERE name = ? AND processing_days = 0 AND processing_hours = 0', [t.days, t.name])
    }
    console.log('[migrate] document_types.processing_days / processing_hours added')
  } else {
    console.log('[migrate] document_types processing time already present')
  }

  // Every organization starts with the default document types (only those that have none yet).
  const [orgsWithout] = await connection.query('SELECT g.id, g.created_by FROM organizations g WHERE NOT EXISTS (SELECT 1 FROM document_types t WHERE t.org_id = g.id)')
  for (const org of orgsWithout as Array<{ id: string; created_by: string | null }>) {
    for (const [i, t] of DEFAULT_DOCUMENT_TYPES.entries()) {
      await connection.query('INSERT INTO document_types (id, org_id, name, processing_days, sort_order, created_by) VALUES (UUID(), ?, ?, ?, ?, ?)', [org.id, t.name, t.days, i, org.created_by])
    }
  }
  console.log(`[migrate] default document types added for ${(orgsWithout as unknown[]).length} organization(s)`)
  // A scanned code must point at exactly one document.
  if (!(await hasIndex('qr_codes', 'uq_qr_codes_data'))) {
    await connection.query('ALTER TABLE `qr_codes` ADD UNIQUE KEY `uq_qr_codes_data` (`qr_code_data`)')
    console.log('[migrate] qr_codes.qr_code_data made unique')
  } else {
    console.log('[migrate] qr_codes.qr_code_data already unique')
  }
} finally {
  await connection.end()
}
