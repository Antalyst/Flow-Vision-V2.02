import { QueryTypes } from 'sequelize'
import { sequelize, Organization, User } from './models.ts'
import { fullNameOf, hashPassword } from './auth.ts'
import { audit } from './audit.ts'
import { createDefaultDocumentTypes } from './knowledge.ts'
import * as v from './validate.ts'

/**
 * The one-time initial administrator (scripts/admin-bootstrap.ts, `npm run admin:bootstrap`).
 * There is no public registration: a new installation gets exactly one first ADMIN this way, and
 * that ADMIN creates every other account in the app (Accounts page, POST /api/users).
 *
 * Never reachable over HTTP — only the command line, by someone who already holds the database
 * credentials. Exactly once, enforced by the database rather than by a check that could race:
 *   1. the transaction first inserts the only row `system_bootstrap` can hold (id = 1). A second
 *      run — even one started at the same moment — waits on that key and then fails on it;
 *   2. it also refuses when any ADMIN account exists (an installation from before the bootstrap);
 *   3. the organization (created when there is none), the account, its document types, the marker
 *      and the audit entry are written in that one transaction: a failure leaves nothing behind.
 */

export type BootstrapErrorCode = 'ALREADY_DONE' | 'INVALID_INPUT' | 'NOT_MIGRATED' | 'EMAIL_TAKEN' | 'ORGANIZATION_REQUIRED'

export class BootstrapError extends Error {
  readonly code: BootstrapErrorCode
  constructor(code: BootstrapErrorCode, message: string) {
    super(message)
    this.name = 'BootstrapError'
    this.code = code
  }
}

export interface BootstrapInput {
  email: unknown
  firstName: unknown
  lastName: unknown
  password: unknown
  /** Name of the organization to create — only used when the database has none yet. */
  organizationName?: unknown
  /** The existing organization to put the administrator in, when there are several. */
  organizationId?: unknown
  /** The account must set its own password at first sign-in (the password came from configuration). */
  mustChangePassword?: boolean
}

export interface BootstrapResult {
  userId: string
  orgId: string
  organizationName: string
  organizationCreated: boolean
  email: string
}

const MIN_ADMIN_PASSWORD = 12
// Fragments that make a password guessable for this system in particular.
const WEAK_FRAGMENTS = ['password', 'flowvision', 'qwerty', '123456', 'admin123', 'letmein', 'demo@1234', 'changeme']

/**
 * The initial administrator holds every permission, so it gets a stricter rule than an ordinary
 * account: 12+ characters from at least three of lower case, upper case, digits and symbols, and
 * nothing guessable (the email name, the organization, common fragments).
 */
export function adminPasswordProblem(password: string, context: { email: string; organizationName?: string | null }): string | null {
  if (password.length < MIN_ADMIN_PASSWORD) return `The administrator password must be at least ${MIN_ADMIN_PASSWORD} characters`
  if (password.length > 128) return 'The administrator password must be at most 128 characters'
  const classes = [/[a-z]/, /[A-Z]/, /\d/, /[^A-Za-z0-9]/].filter((re) => re.test(password)).length
  if (classes < 3) return 'The administrator password needs at least three of: lower-case letters, upper-case letters, digits, symbols'
  const lower = password.toLowerCase()
  const local = context.email.split('@')[0]!.toLowerCase()
  if (local.length >= 4 && lower.includes(local)) return 'The administrator password must not contain the email name'
  const org = context.organizationName?.toLowerCase().replace(/\s+/g, '')
  if (org && org.length >= 4 && lower.replace(/\s+/g, '').includes(org)) return 'The administrator password must not contain the organization name'
  if (WEAK_FRAGMENTS.some((f) => lower.includes(f))) return 'The administrator password is too easy to guess'
  if (/^(.)\1+$/.test(password)) return 'The administrator password is too easy to guess'
  return null
}

/** The bootstrap's input, checked; the same rules as the app's own forms (validate.ts). */
export function readBootstrapInput(input: BootstrapInput) {
  const field = <T>(read: () => T) => {
    try {
      return read()
    } catch (err) {
      throw new BootstrapError('INVALID_INPUT', (err as Error).message)
    }
  }
  const body = { email: input.email, first_name: input.firstName, last_name: input.lastName, organization_name: input.organizationName, organization_id: input.organizationId }
  const email = field(() => v.email(body))
  const firstName = field(() => v.reqStr(body, 'first_name', { max: 100, label: 'First name' }))
  const lastName = field(() => v.reqStr(body, 'last_name', { max: 100, label: 'Last name' }))
  const organizationName = field(() => v.str(body, 'organization_name', { max: 255, label: 'Organization name' }))
  const organizationId = field(() => v.str(body, 'organization_id', { max: 36, label: 'Organization id' }))
  if (organizationId && !/^[0-9a-f-]{36}$/i.test(organizationId)) throw new BootstrapError('INVALID_INPUT', 'Organization id is not valid')
  const password = typeof input.password === 'string' ? input.password : ''
  const problem = adminPasswordProblem(password, { email, organizationName })
  if (problem) throw new BootstrapError('INVALID_INPUT', problem)
  return { email, firstName, lastName, organizationName, organizationId, password, mustChangePassword: Boolean(input.mustChangePassword) }
}

const errno = (err: unknown) => {
  const e = err as { parent?: { errno?: number; code?: string }; original?: { errno?: number }; name?: string }
  return e?.parent?.errno ?? e?.original?.errno ?? (e?.name === 'SequelizeUniqueConstraintError' ? 1062 : undefined)
}
const isMissingTable = (err: unknown) => errno(err) === 1146

/** Whether the bootstrap already ran (or isn't needed): for `--status`, and to fail fast before asking for a password. */
export async function bootstrapStatus() {
  try {
    const [marker] = await sequelize.query<{ method: string; completed_at: Date }>('SELECT `method`, `completed_at` FROM `system_bootstrap` WHERE `id` = 1', { type: QueryTypes.SELECT })
    const [admins, organizations] = await Promise.all([User.count({ where: { account_type: 'ADMIN' } }), Organization.count()])
    return { migrated: true, done: Boolean(marker) || admins > 0, marker: marker ?? null, admins, organizations }
  } catch (err) {
    if (isMissingTable(err)) return { migrated: false, done: false, marker: null, admins: 0, organizations: 0 }
    throw err
  }
}

const ALREADY_DONE = () =>
  new BootstrapError('ALREADY_DONE', 'This installation already has its initial administrator. Sign in as an administrator and create further accounts on the Accounts page.')

/** Create the initial administrator, once. Hashes the password before the transaction (bcrypt is slow). */
export async function bootstrapAdmin(raw: BootstrapInput): Promise<BootstrapResult> {
  const input = readBootstrapInput(raw)
  const passwordHash = await hashPassword(input.password)

  return sequelize.transaction(async (transaction) => {
    // 1. Claim the one-time slot. Its primary key admits one row: a concurrent run blocks here
    //    until this transaction ends, then fails with a duplicate key (or proceeds if this one failed).
    try {
      await sequelize.query("INSERT INTO `system_bootstrap` (`id`, `method`) VALUES (1, 'CLI')", { transaction })
    } catch (err) {
      if (errno(err) === 1062) throw ALREADY_DONE()
      if (isMissingTable(err)) throw new BootstrapError('NOT_MIGRATED', 'The system_bootstrap table is missing. Run the database migration first (npm run db:migrate, or database/migrations/2026-10-24-admin-bootstrap.sql).')
      throw err
    }

    // 2. An installation that already has an administrator is bootstrapped, marker or not.
    if (await User.count({ where: { account_type: 'ADMIN' }, transaction })) throw ALREADY_DONE()
    if (await User.count({ where: { email: input.email }, transaction })) throw new BootstrapError('EMAIL_TAKEN', 'An account with that email already exists')

    // 3. The organization: the one there is, the one named by id, or a new one on an empty installation.
    const organizations = await Organization.findAll({ attributes: ['id', 'name', 'created_by'], order: [['created_at', 'ASC']], transaction })
    let org = input.organizationId ? organizations.find((o) => o.id === input.organizationId) : organizations.length === 1 ? organizations[0] : undefined
    let organizationCreated = false
    if (input.organizationId && !org) throw new BootstrapError('ORGANIZATION_REQUIRED', 'No organization has that id')
    if (!org && organizations.length > 1) {
      throw new BootstrapError('ORGANIZATION_REQUIRED', `This database has ${organizations.length} organizations: give the id of the one the administrator belongs to (FV_BOOTSTRAP_ORG_ID).`)
    }
    if (!org) {
      if (!input.organizationName) throw new BootstrapError('ORGANIZATION_REQUIRED', 'Give the organization name (FV_BOOTSTRAP_ORG_NAME): this installation has no organization yet.')
      org = await Organization.create({ name: input.organizationName, status: 'active' }, { transaction })
      organizationCreated = true
    }

    // 4. The account: an ordinary ADMIN, exactly like one created in the app.
    const user = await User.create(
      {
        org_id: org.id,
        account_type: 'ADMIN',
        email: input.email,
        password_hash: passwordHash,
        first_name: input.firstName,
        last_name: input.lastName,
        full_name: fullNameOf(input.firstName, input.lastName),
        // pending = must choose a new password at first sign-in (as with a temporary password).
        status: input.mustChangePassword ? 'pending' : 'active',
      },
      { transaction },
    )
    if (!org.created_by) await org.update({ created_by: user.id }, { transaction })
    // A starting set of document types; the ADMIN edits them in Organization Settings.
    if (organizationCreated) await createDefaultDocumentTypes(org.id, user.id, transaction)

    await sequelize.query('UPDATE `system_bootstrap` SET `org_id` = ?, `admin_user_id` = ? WHERE `id` = 1', { replacements: [org.id, user.id], transaction })
    await audit(
      null,
      { action: 'ADMIN_BOOTSTRAP', entityType: 'user', entityId: user.id, userId: user.id, after: { email: input.email, account_type: 'ADMIN', org_id: org.id, organization_created: organizationCreated } },
      transaction,
    )
    return { userId: user.id as string, orgId: org.id as string, organizationName: org.name as string, organizationCreated, email: input.email }
  })
}
