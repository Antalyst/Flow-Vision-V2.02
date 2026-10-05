import type { H3Event } from 'h3'
import { SESSION_COOKIE, resolveSession, type Actor, type RequestMeta } from '../lib/auth.ts'
import { badRequest, forbidden, toHttpError, unauthorized } from '../lib/errors.ts'
import { env } from '../lib/env.ts'
import type { AccountType } from '../lib/models.ts'

// Auto-imported into every server handler.

/** defineEventHandler that turns database errors into proper 4xx responses. */
export function defineApiHandler<T>(handler: (event: H3Event) => Promise<T>) {
  return defineEventHandler(async (event) => {
    try {
      return await handler(event)
    } catch (err) {
      throw toHttpError(err)
    }
  })
}

export function setSessionCookie(event: H3Event, token: string, expires: Date) {
  setCookie(event, SESSION_COOKIE, token, {
    httpOnly: true,
    sameSite: 'lax',
    secure: env.isProduction,
    path: '/',
    expires,
  })
}

export function clearSessionCookie(event: H3Event) {
  deleteCookie(event, SESSION_COOKIE, { path: '/' })
}

/** The signed-in user for this request, or null. Resolved once per request. */
export async function getActor(event: H3Event): Promise<Actor | null> {
  if (event.context.actorResolved) return event.context.actor ?? null
  event.context.actorResolved = true

  const token = getCookie(event, SESSION_COOKIE)
  if (!token) return null
  const session = await resolveSession(token)
  if (!session) {
    clearSessionCookie(event)
    return null
  }
  if (session.renewedUntil) setSessionCookie(event, token, session.renewedUntil)
  event.context.actor = session.actor
  event.context.sessionId = session.sessionId
  return session.actor
}

/** Require a signed-in user, optionally of specific account types. */
export async function requireUser(event: H3Event, ...accountTypes: AccountType[]): Promise<Actor> {
  const actor = await getActor(event)
  if (!actor) throw unauthorized()
  if (accountTypes.length && !accountTypes.includes(actor.account_type)) {
    throw forbidden(`This action requires a ${accountTypes.join(' or ')} account`)
  }
  return actor
}

/** Like requireUser, but the account must also be attached to an office. */
export async function requireOfficeUser(event: H3Event, ...accountTypes: AccountType[]): Promise<Actor> {
  const actor = await requireUser(event, ...accountTypes)
  if (!actor.office_id) throw forbidden('Your account is not assigned to an office yet')
  return actor
}

export function requestMeta(event: H3Event, user?: Actor | null): RequestMeta {
  return {
    user: user ?? event.context.actor ?? null,
    ip: getRequestIP(event, { xForwardedFor: true }) ?? null,
    userAgent: getRequestHeader(event, 'user-agent') ?? null,
  }
}

/** JSON body as a plain object (never null), so validators can index into it. */
export async function readJson(event: H3Event): Promise<Record<string, unknown>> {
  const body = await readBody(event).catch(() => {
    throw badRequest('Request body is not valid JSON')
  })
  return body && typeof body === 'object' && !Array.isArray(body) ? (body as Record<string, unknown>) : {}
}

/** Route param that must be present. */
export function routeParam(event: H3Event, name: string): string {
  const value = getRouterParam(event, name, { decode: true })
  if (!value) throw badRequest(`Missing ${name}`)
  return value
}
