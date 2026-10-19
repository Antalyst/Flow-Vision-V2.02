import { Op, type WhereOptions } from 'sequelize'
import type { Actor } from './auth.ts'
import type { Row } from './models.ts'
import { forbidden } from './errors.ts'

/**
 * The AI's view of who is asking, from the signed-in actor only (auth.ts loadActor reads the user,
 * its office and organization from the database on every request). Nothing from the request
 * body, the chat or the conversation history can change it.
 *
 * Knowledge files (knowledge_files) are either organization-wide (office_id NULL) or belong to
 * one office. Who may read what:
 *   ADMIN                       every file of the organization
 *   DEPARTMENT_HEAD / STAFF     organization-wide files + their own office's files, when that office
 *                               is active and belongs to their organization
 *   anyone whose office is missing, inactive or in another organization: organization-wide only
 * Accounts outside these roles (LIAISON, unknown) get no context at all — never the admin view.
 */

export const KNOWLEDGE_READER_ROLES = ['ADMIN', 'DEPARTMENT_HEAD', 'STAFF'] as const

export interface AiUserContext {
  orgId: string
  userId: string
  role: (typeof KNOWLEDGE_READER_ROLES)[number]
  /** Reads every office's files. */
  allOffices: boolean
  /** The user's own office, only when it is verified (active, same organization). */
  office: { id: string; name: string; code: string | null } | null
  /** Why the user's office isn't used, when they have one on record but it can't be trusted. */
  officeIssue: 'NONE' | 'NO_OFFICE' | 'OFFICE_INACTIVE' | 'OFFICE_OTHER_ORG'
}

export function resolveAiContext(actor: Actor | null | undefined): AiUserContext {
  if (!actor?.id || !actor.org_id) throw forbidden('Your account could not be identified. Sign in again.')
  const role = actor.account_type as AiUserContext['role']
  if (!(KNOWLEDGE_READER_ROLES as readonly string[]).includes(role)) throw forbidden('The AI assistant is not available for this account')

  const office = actor.office as Row | null | undefined
  let officeIssue: AiUserContext['officeIssue'] = 'NONE'
  if (!actor.office_id || !office || office.id !== actor.office_id) officeIssue = 'NO_OFFICE'
  else if (office.org_id !== actor.org_id) officeIssue = 'OFFICE_OTHER_ORG'
  else if (office.status === 'inactive') officeIssue = 'OFFICE_INACTIVE'

  return {
    orgId: actor.org_id as string,
    userId: actor.id as string,
    role,
    allOffices: role === 'ADMIN',
    office: officeIssue === 'NONE' ? { id: office!.id as string, name: String(office!.name), code: (office!.code as string | null) ?? null } : null,
    officeIssue,
  }
}

/** The knowledge files this user may read: the SQL filter. Always pinned to their organization. */
export function knowledgeWhere(ctx: AiUserContext): WhereOptions {
  const base = { org_id: ctx.orgId, is_active: true, status: 'READY' }
  if (ctx.allOffices) return base
  if (ctx.office) return { ...base, [Op.or]: [{ office_id: null }, { office_id: ctx.office.id }] }
  return { ...base, office_id: null }
}

/** The same rule in code, applied again to every row the query returns (defense in depth). */
export function canReadKnowledge(file: Row | null | undefined, ctx: AiUserContext) {
  if (!file || file.org_id !== ctx.orgId) return false
  if (file.office_id == null) return true
  if (ctx.allOffices) return true
  return Boolean(ctx.office) && file.office_id === ctx.office!.id
}

/** One line for the AI and the chat page: what this user's knowledge searches cover. */
export function scopeDescription(ctx: AiUserContext) {
  if (ctx.allOffices) return 'every knowledge file of the organization (organization-wide and every office’s)'
  if (ctx.office) return `organization-wide knowledge files and the files of ${ctx.office.name}`
  return 'organization-wide knowledge files only (this account has no verified office)'
}
