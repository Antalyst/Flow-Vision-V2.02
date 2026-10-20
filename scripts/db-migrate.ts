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
 * Every document carries one permanent routing code ({ORIGIN_CODE}{MMDDYY}{6 digits}) from upload on.
 * The origin is the uploader's assigned office, or their organization for accounts without one
 * (ADMIN). Documents without a code in that format get one now, and documents uploaded by an
 * account without an office get the organization prefix if they carry an office's.
 */
async function backfillRoutingCodes() {
  const { isRoutingCode, buildRoutingCode, organizationCode } = await import('../server/lib/qr.ts')
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
    SELECT d.id, d.org_id, d.created_at, q.id AS qr_id, q.qr_code_data AS code, q.office_code AS qr_prefix, uo.code AS uploader_office_code
    FROM documents d
    JOIN users u ON u.id = d.submitted_by
    LEFT JOIN offices uo ON uo.id = u.office_id
    LEFT JOIN qr_codes q ON q.document_id = d.id`)
  const docs = rows as Array<{ id: string; org_id: string; created_at: Date; qr_id: string | null; code: string | null; qr_prefix: string | null; uploader_office_code: string | null }>
  const taken = new Set(docs.map((d) => d.code).filter(Boolean))
  let issued = 0
  for (const doc of docs) {
    const prefix = doc.uploader_office_code ?? orgCodes.get(doc.org_id) ?? 'ORG'
    // Labels in the older {CODE}-{8 digits} format are already printed, so they stay valid.
    const valid = Boolean(doc.code && isRoutingCode(doc.code))
    // Office uploads keep a valid code; organization uploads must carry the organization prefix.
    if (valid && (doc.uploader_office_code || doc.qr_prefix === prefix)) continue
    let code = buildRoutingCode(prefix, new Date(doc.created_at))
    while (taken.has(code)) code = buildRoutingCode(prefix, new Date(doc.created_at))
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

  // Whoever creates an account chooses which pages it may open (NULL = every page of its role).
  if (!(await hasColumn('users', 'page_access'))) {
    await connection.query("ALTER TABLE `users` ADD COLUMN `page_access` text DEFAULT NULL COMMENT 'JSON list of pages the account may open (NULL = every page of its role)' AFTER `two_factor_enabled`")
    console.log('[migrate] users.page_access added')
  } else {
    console.log('[migrate] users.page_access already present')
  }

  // Step 0 (the origin) of an admin upload is the organization itself, not an office.
  const [trackingOffice] = await connection.query(
    "SELECT IS_NULLABLE FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = ? AND TABLE_NAME = 'document_tracking' AND COLUMN_NAME = 'office_id'",
    [env.db.name],
  )
  if ((trackingOffice as Array<{ IS_NULLABLE: string }>)[0]?.IS_NULLABLE === 'NO') {
    await connection.query("ALTER TABLE `document_tracking` MODIFY `office_id` char(36) DEFAULT NULL COMMENT 'Office location (NULL = the organization itself, for step 0 of an admin upload)'")
    console.log('[migrate] document_tracking.office_id made nullable')
  } else {
    console.log('[migrate] document_tracking.office_id already nullable')
  }

  await backfillRoutingCodes()

  // Organization Settings: document types and AI knowledge files. The DDL comes straight from the
  // schema file, so the two can't drift apart.
  const schemaSql = await fs.readFile(path.resolve(import.meta.dirname, '../database/flowvision-complete-schema.sql'), 'utf8')
  // file_blobs first came out as one row per file; it holds files in parts now. Only an empty one is replaced.
  if ((await hasTable('file_blobs')) && !(await hasColumn('file_blobs', 'part'))) {
    const [[{ n }]] = (await connection.query('SELECT COUNT(*) AS n FROM file_blobs')) as unknown as [[{ n: number }]]
    if (Number(n) === 0) {
      await connection.query('DROP TABLE `file_blobs`')
      console.log('[migrate] empty file_blobs dropped, to be created in parts')
    }
  }
  // …plus AI Assistant chat history (conversations before their messages, for the foreign key),
  // file_blobs, where uploads are kept on hosts with a read-only disk (Vercel), and Organization
  // Settings' working hours, holidays and document templates (also: scripts/db-add-settings.ts).
  for (const table of ['document_types', 'knowledge_files', 'document_files', 'ai_conversations', 'ai_messages', 'file_blobs', 'organization_settings', 'organization_holidays', 'document_templates', 'department_head_assignments', 'internal_routes', 'internal_route_steps', 'document_internal_transactions']) {
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
  // Office-aware AI knowledge (database/migrations/2026-10-19-knowledge-office-scope.sql).
  // Every existing file stays organization-wide and GENERAL; nothing widens.
  if (!(await hasColumn('knowledge_files', 'office_id'))) {
    await connection.query("ALTER TABLE `knowledge_files` ADD COLUMN `office_id` char(36) DEFAULT NULL COMMENT 'NULL = organization-wide; set = only this office (and ADMIN)' AFTER `org_id`")
    console.log('[migrate] knowledge_files.office_id added')
  } else {
    console.log('[migrate] knowledge_files.office_id already present')
  }
  if (!(await hasColumn('knowledge_files', 'kind'))) {
    await connection.query(
      "ALTER TABLE `knowledge_files` ADD COLUMN `kind` enum('GENERAL','CITIZENS_CHARTER') NOT NULL DEFAULT 'GENERAL' COMMENT 'Citizen''s Charter files get service-aware answers' AFTER `description`",
    )
    console.log('[migrate] knowledge_files.kind added')
  } else {
    console.log('[migrate] knowledge_files.kind already present')
  }
  if (!(await hasColumn('knowledge_files', 'index_version'))) {
    await connection.query(
      "ALTER TABLE `knowledge_files` ADD COLUMN `index_version` tinyint(4) NOT NULL DEFAULT 0 COMMENT '0 = flattened text (re-read to keep pages), 1 = lines and pages kept' AFTER `char_count`",
    )
    console.log('[migrate] knowledge_files.index_version added')
  } else {
    console.log('[migrate] knowledge_files.index_version already present')
  }
  if (!(await hasIndex('knowledge_files', 'idx_knowledge_files_scope'))) {
    await connection.query('CREATE INDEX `idx_knowledge_files_scope` ON `knowledge_files` (`org_id`, `office_id`, `is_active`)')
    console.log('[migrate] knowledge_files scope index added')
  }
  const [officeFk] = await connection.query(
    "SELECT 1 FROM information_schema.TABLE_CONSTRAINTS WHERE TABLE_SCHEMA = ? AND TABLE_NAME = 'knowledge_files' AND CONSTRAINT_NAME = 'fk_knowledge_files_office'",
    [env.db.name],
  )
  if (!(officeFk as unknown[]).length) {
    // No ON DELETE SET NULL: that would turn an office's private file into an organization-wide one.
    await connection.query('ALTER TABLE `knowledge_files` ADD CONSTRAINT `fk_knowledge_files_office` FOREIGN KEY (`office_id`) REFERENCES `offices` (`id`)')
    console.log('[migrate] knowledge_files office foreign key added')
  }

  // Document types carry the processing time (it used to be set per office on each route).
  const { DEFAULT_DOCUMENT_TYPES } = await import('../server/lib/knowledge.ts')
  if (!(await hasColumn('document_types', 'processing_days'))) {
    await connection.query(
      "ALTER TABLE `document_types` ADD COLUMN `processing_days` int(11) NOT NULL DEFAULT 0 COMMENT 'How long a document of this type may take: days' AFTER `description`, " +
        "ADD COLUMN `processing_hours` int(11) NOT NULL DEFAULT 0 COMMENT '… plus hours (0–23); 0 + 0 = no deadline' AFTER `processing_days`",
    )
    // Give the starter types their starting times (the ADMIN can change them in Organization Settings).
    for (const t of DEFAULT_DOCUMENT_TYPES) {
      await connection.query('UPDATE document_types SET processing_days = ? WHERE name = ? AND processing_days = 0 AND processing_hours = 0', [t.days, t.name])
    }
    console.log('[migrate] document_types.processing_days / processing_hours added')
  } else {
    console.log('[migrate] document_types processing time already present')
  }

  // Umbrella offices and document types by office (database/migrations/2026-10-20-umbrella-offices-and-document-types.sql).
  const hasConstraint = async (table: string, name: string) => {
    const [rows] = await connection.query('SELECT 1 FROM information_schema.TABLE_CONSTRAINTS WHERE TABLE_SCHEMA = ? AND TABLE_NAME = ? AND CONSTRAINT_NAME = ?', [env.db.name, table, name])
    return (rows as unknown[]).length > 0
  }
  if (!(await hasColumn('offices', 'parent_office_id'))) {
    await connection.query("ALTER TABLE `offices` ADD COLUMN `parent_office_id` char(36) DEFAULT NULL COMMENT 'NULL = office; set = umbrella office under that office' AFTER `org_id`")
    console.log('[migrate] offices.parent_office_id added')
  }
  if (!(await hasIndex('offices', 'idx_offices_parent'))) await connection.query('CREATE INDEX `idx_offices_parent` ON `offices` (`parent_office_id`)')
  if (!(await hasConstraint('offices', 'fk_offices_parent'))) {
    await connection.query('ALTER TABLE `offices` ADD CONSTRAINT `fk_offices_parent` FOREIGN KEY (`parent_office_id`) REFERENCES `offices` (`id`)')
  }
  const typeColumns: Array<[string, string]> = [
    ['office_id', "char(36) DEFAULT NULL COMMENT 'NULL = Global (every office); set = only this office' AFTER `org_id`"],
    ['processing_minutes', "int(11) NOT NULL DEFAULT 0 COMMENT '… plus minutes (0–59)' AFTER `processing_hours`"],
    ['service_category', "enum('INTERNAL','EXTERNAL') DEFAULT NULL COMMENT 'As labelled in the Citizen''s Charter' AFTER `processing_minutes`"],
    ['source_file_id', "char(36) DEFAULT NULL COMMENT 'Citizen''s Charter file it was imported from' AFTER `service_category`"],
    ['source_page', "int(11) DEFAULT NULL COMMENT 'Page of that charter' AFTER `source_file_id`"],
  ]
  for (const [column, definition] of typeColumns) {
    if (!(await hasColumn('document_types', column))) {
      await connection.query(`ALTER TABLE \`document_types\` ADD COLUMN \`${column}\` ${definition}`)
      console.log(`[migrate] document_types.${column} added`)
    }
  }
  if (!(await hasConstraint('document_types', 'fk_document_types_office'))) {
    await connection.query('ALTER TABLE `document_types` ADD CONSTRAINT `fk_document_types_office` FOREIGN KEY (`office_id`) REFERENCES `offices` (`id`)')
  }
  if (!(await hasIndex('document_types', 'idx_document_types_source'))) await connection.query('CREATE INDEX `idx_document_types_source` ON `document_types` (`source_file_id`)')
  if (!(await hasIndex('document_types', 'uq_document_types_org_office_name'))) {
    // New key first, so the organization foreign key always keeps an index.
    await connection.query('CREATE UNIQUE INDEX `uq_document_types_org_office_name` ON `document_types` (`org_id`, `office_id`, `name`)')
    console.log('[migrate] document type names are now unique per office')
  }
  if (await hasIndex('document_types', 'uq_document_types_org_name')) await connection.query('DROP INDEX `uq_document_types_org_name` ON `document_types`')

  // Delegated Department Heads (database/migrations/2026-10-21-delegated-department-heads.sql).
  // Every existing Department Head stays a managing one (assigned_by NULL).
  const userColumns: Array<[string, string]> = [
    ['assigned_by', "char(36) DEFAULT NULL COMMENT 'Set = delegated Department Head, assigned by this user' AFTER `page_access`"],
    ['assigned_at', "datetime DEFAULT NULL COMMENT 'When the delegation was made' AFTER `assigned_by`"],
    ['permissions', "text DEFAULT NULL COMMENT 'Delegated Department Head: JSON list of granted permissions' AFTER `assigned_at`"],
  ]
  for (const [column, definition] of userColumns) {
    if (!(await hasColumn('users', column))) {
      await connection.query(`ALTER TABLE \`users\` ADD COLUMN \`${column}\` ${definition}`)
      console.log(`[migrate] users.${column} added`)
    }
  }
  if (!(await hasIndex('users', 'idx_users_assigned_by'))) await connection.query('CREATE INDEX `idx_users_assigned_by` ON `users` (`assigned_by`)')
  if (!(await hasConstraint('users', 'fk_users_assigned_by'))) {
    await connection.query('ALTER TABLE `users` ADD CONSTRAINT `fk_users_assigned_by` FOREIGN KEY (`assigned_by`) REFERENCES `users` (`id`)')
  }

  // Millisecond visit times and history notes (database/migrations/2026-10-22-tracking-precision-and-history-notes.sql).
  const [precision] = await connection.query(
    "SELECT COLUMN_NAME AS c, DATETIME_PRECISION AS p FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = ? AND TABLE_NAME = 'document_tracking' AND COLUMN_NAME IN ('created_at','updated_at','arrived_at','completed_at')",
    [env.db.name],
  )
  if ((precision as Array<{ p: number }>).some((r) => Number(r.p) !== 3)) {
    await connection.query(
      "ALTER TABLE `document_tracking` MODIFY `arrived_at` timestamp(3) NULL DEFAULT NULL COMMENT 'Arrival time at office', " +
        "MODIFY `completed_at` timestamp(3) NULL DEFAULT NULL COMMENT 'Completion time', " +
        'MODIFY `created_at` timestamp(3) NOT NULL DEFAULT current_timestamp(3), ' +
        'MODIFY `updated_at` timestamp(3) NOT NULL DEFAULT current_timestamp(3) ON UPDATE current_timestamp(3)',
    )
    console.log('[migrate] document_tracking times now keep milliseconds')
  }
  if (!(await hasColumn('department_head_assignments', 'note'))) {
    await connection.query("ALTER TABLE `department_head_assignments` ADD COLUMN `note` varchar(500) DEFAULT NULL COMMENT 'Why: e.g. removed because the grantor lost the permission' AFTER `changed_by`")
    console.log('[migrate] department_head_assignments.note added')
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
