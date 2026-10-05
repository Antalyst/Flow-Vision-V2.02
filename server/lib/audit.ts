import type { Transaction } from 'sequelize'
import { AuditLog } from './models.ts'
import type { RequestMeta } from './auth.ts'

interface AuditEntry {
  action: string
  entityType: string
  entityId: string
  before?: unknown
  after?: unknown
  userId?: string | null
}

/** Append an audit entry: who did what to which record, with before/after JSON snapshots. */
export function audit(meta: RequestMeta | null, entry: AuditEntry, transaction?: Transaction) {
  return AuditLog.create(
    {
      user_id: entry.userId ?? meta?.user?.id ?? null,
      action: entry.action.slice(0, 100),
      entity_type: entry.entityType.slice(0, 50),
      entity_id: entry.entityId,
      old_values: entry.before ?? null,
      new_values: entry.after ?? null,
      ip_address: meta?.ip?.slice(0, 45) ?? null,
    },
    { transaction },
  )
}
