import crypto from 'node:crypto'
import bcrypt from 'bcryptjs'
import { Op } from 'sequelize'
import { AuthSession, Liaison, Office, Organization, User, type Row } from './models.ts'
import { liaisonDto, officeDto } from './serializers.ts'
import { env } from './env.ts'

/** A signed-in user with `office` and `organization` loaded. */
export type Actor = Row

export interface RequestMeta {
  user?: Actor | null
  ip?: string | null
  userAgent?: string | null
}

export const SESSION_COOKIE = 'fv_session'
const BCRYPT_ROUNDS = 12
const DAY_MS = 24 * 60 * 60 * 1000
// Extend a sliding session at most this often, so every request isn't a write.
const RENEW_AFTER_MS = 60 * 60 * 1000

export const hashPassword = (plain: string) => bcrypt.hash(plain, BCRYPT_ROUNDS)
export const verifyPassword = (plain: string, hash: string) => bcrypt.compare(plain, hash)

// Compared against when an email is unknown, so login timing doesn't reveal which accounts exist.
let dummyHash: string | null = null
export async function getDummyHash() {
  dummyHash ??= await bcrypt.hash(crypto.randomBytes(16).toString('hex'), BCRYPT_ROUNDS)
  return dummyHash
}

export function generateTempPassword() {
  // 12 chars from an unambiguous alphabet — easy to read aloud to a new team member.
  const alphabet = 'ABCDEFGHJKMNPQRSTUVWXYZabcdefghjkmnpqrstuvwxyz23456789'
  return Array.from(crypto.randomBytes(12), (b) => alphabet[b % alphabet.length]).join('')
}

const sha256 = (value: string) => crypto.createHash('sha256').update(value).digest('hex')
const sessionExpiry = () => new Date(Date.now() + env.sessionDays * DAY_MS)

export const fullNameOf = (first?: string | null, last?: string | null) => [first, last].filter(Boolean).join(' ')

/**
 * Loads a user with office + organization. Role, office and status always come
 * from the database row, so admin changes apply on the very next request.
 * users.status: active · pending (temporary password) may sign in; inactive may not.
 */
export async function loadActor(userId: string): Promise<Actor | null> {
  const user = await User.findByPk(userId, {
    include: [
      { model: Office, as: 'office' },
      { model: Organization, as: 'organization', attributes: ['id', 'name', 'status'] },
    ],
  })
  if (!user || user.status === 'inactive') return null
  return user
}

export function hasApprovalAuthority(user: Actor) {
  return user.account_type === 'STAFF' && Boolean(user.office?.is_final_checkpoint) && user.office?.status !== 'inactive'
}

/** Start a session. The raw token goes into an httpOnly cookie; only its hash is stored. */
export async function createSession(userId: string, meta: RequestMeta) {
  const token = crypto.randomBytes(32).toString('base64url')
  const expiresAt = sessionExpiry()
  await AuthSession.create({
    user_id: userId,
    token: sha256(token),
    user_agent: meta.userAgent?.slice(0, 500) ?? null,
    ip_address: meta.ip?.slice(0, 45) ?? null,
    expires_at: expiresAt,
  })
  return { token, expiresAt }
}

/**
 * Resolve a session token to its user. Returns `renewedUntil` when the sliding
 * expiry was extended, so the caller can refresh the cookie.
 */
export async function resolveSession(token: string | undefined | null) {
  if (!token || token.length > 128) return null
  const session = await AuthSession.findOne({ where: { token: sha256(token), expires_at: { [Op.gt]: new Date() } } })
  if (!session) return null

  const actor = await loadActor(session.user_id)
  if (!actor) return null

  // No last-used column: renew once the session is more than an hour into its window.
  let renewedUntil: Date | null = null
  const remaining = new Date(session.expires_at).getTime() - Date.now()
  if (remaining < env.sessionDays * DAY_MS - RENEW_AFTER_MS) {
    renewedUntil = sessionExpiry()
    await session.update({ expires_at: renewedUntil })
  }
  return { actor, sessionId: session.id as string, renewedUntil }
}

export async function revokeSessionToken(token: string | undefined | null) {
  if (token) await AuthSession.destroy({ where: { token: sha256(token) } })
}

export async function revokeAllSessions(userId: string, exceptSessionId?: string) {
  await AuthSession.destroy({ where: { user_id: userId, ...(exceptSessionId ? { id: { [Op.ne]: exceptSessionId } } : {}) } })
}

/** The shape every client receives for "the current user". */
export async function serializeActor(user: Actor) {
  const liaison = user.account_type === 'LIAISON' ? await Liaison.findOne({ where: { user_id: user.id } }) : null
  const [first = '', ...rest] = user.first_name || user.last_name ? [] : String(user.full_name ?? '').split(/\s+/)
  return {
    id: user.id,
    email: user.email,
    first_name: user.first_name ?? first,
    last_name: user.last_name ?? rest.join(' '),
    phone: user.phone ?? null,
    account_type: user.account_type,
    status: user.status === 'inactive' ? 'SUSPENDED' : 'ACTIVE',
    must_change_password: user.status === 'pending',
    organization: user.organization ? { id: user.organization.id, name: user.organization.name } : null,
    office: officeDto(user.office),
    has_approval_authority: hasApprovalAuthority(user),
    liaison: liaisonDto(liaison),
  }
}
