import { badRequest } from './errors.ts'

type Input = Record<string, unknown> | null | undefined

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/

/** Trimmed string or null. Throws if `required` and missing, or longer than `max`. */
export function str(body: Input, field: string, { required = false, max = 255, label = field } = {}): string | null {
  const raw = body?.[field]
  const value = typeof raw === 'string' ? raw.trim() : raw == null ? '' : String(raw).trim()
  if (!value) {
    if (required) throw badRequest(`${label} is required`, { field })
    return null
  }
  if (value.length > max) throw badRequest(`${label} must be at most ${max} characters`, { field })
  return value
}

/** Like `str` with `required: true`, typed as always returning a string. */
export function reqStr(body: Input, field: string, opts: { max?: number; label?: string } = {}): string {
  return str(body, field, { ...opts, required: true }) as string
}

export function email(body: Input, field = 'email'): string {
  const value = reqStr(body, field, { max: 191, label: 'Email' }).toLowerCase()
  if (!EMAIL_RE.test(value)) throw badRequest('Email address is not valid', { field })
  return value
}

export function password(body: Input, field = 'password'): string {
  const raw = body?.[field]
  const value = typeof raw === 'string' ? raw : ''
  if (value.length < 8) throw badRequest('Password must be at least 8 characters', { field })
  if (value.length > 128) throw badRequest('Password must be at most 128 characters', { field })
  return value
}

export function oneOf<T extends string>(body: Input, field: string, allowed: readonly T[], { required = false, fallback = null as T | null } = {}): T | null {
  const value = body?.[field]
  if (value == null || value === '') {
    if (required) throw badRequest(`${field} is required`, { field })
    return fallback
  }
  const normalized = String(value).toUpperCase() as T
  if (!allowed.includes(normalized)) throw badRequest(`${field} must be one of: ${allowed.join(', ')}`, { field })
  return normalized
}

export function code(body: Input, field: string, { required = true, label = field } = {}): string | null {
  const value = str(body, field, { required, max: 16, label })
  if (value == null) return null
  const upper = value.toUpperCase()
  if (!/^[A-Z0-9]{2,16}$/.test(upper)) throw badRequest(`${label} must be 2–16 letters or digits`, { field })
  return upper
}

export function dateOnly(body: Input, field: string): string | null {
  const value = str(body, field, { max: 10 })
  if (!value) return null
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value) || Number.isNaN(Date.parse(value))) {
    throw badRequest(`${field} must be a date (YYYY-MM-DD)`, { field })
  }
  return value
}

export function pagination(query: Input, { defaultLimit = 25, maxLimit = 100 } = {}) {
  const limit = Math.min(Math.max(Number(query?.limit) || defaultLimit, 1), maxLimit)
  const page = Math.max(Number(query?.page) || 1, 1)
  return { limit, offset: (page - 1) * limit, page }
}

/** A query-string value as a single trimmed string (h3 can give arrays). */
export function q(query: Input, field: string, max = 100): string {
  const raw = query?.[field]
  const value = Array.isArray(raw) ? raw[0] : raw
  return typeof value === 'string' ? value.trim().slice(0, max) : ''
}
