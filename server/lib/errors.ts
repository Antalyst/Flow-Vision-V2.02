import { createError, isError } from 'h3'

/**
 * API errors are h3 errors so Nitro serialises them as
 * `{ statusCode, message, data: { code, details } }`.
 */
export function httpError(statusCode: number, message: string, code: string, details?: unknown) {
  return createError({ statusCode, statusMessage: code, message, data: { code, details } })
}

export const badRequest = (message: string, details?: unknown) => httpError(400, message, 'BAD_REQUEST', details)
export const unauthorized = (message = 'Authentication required') => httpError(401, message, 'UNAUTHORIZED')
export const forbidden = (message = 'You do not have permission to do this') => httpError(403, message, 'FORBIDDEN')
export const notFound = (what = 'Resource') => httpError(404, `${what} not found`, 'NOT_FOUND')
export const conflict = (message: string, code = 'CONFLICT') => httpError(409, message, code)
export const tooMany = (message: string) => httpError(429, message, 'RATE_LIMITED')

/** Map database errors to client errors; anything unknown stays a 500. */
export function toHttpError(err: unknown) {
  if (isError(err)) return err
  const e = err as { name?: string; reltype?: string; errors?: Array<{ path?: string; message?: string }> }
  switch (e?.name) {
    case 'SequelizeUniqueConstraintError': {
      const field = e.errors?.[0]?.path
      return httpError(409, `${field || 'Value'} is already in use`, 'DUPLICATE', { field })
    }
    case 'SequelizeValidationError':
      return httpError(400, (e.errors ?? []).map((x) => x.message).join('; '), 'VALIDATION')
    case 'SequelizeForeignKeyConstraintError':
      // 'parent': deleting a record others still point at (an office that is a document's origin, …).
      if (e.reltype === 'parent') return httpError(409, 'This record is still in use (for example as a document’s origin office), so it can’t be deleted. Deactivate it instead.', 'IN_USE')
      return httpError(400, 'A referenced record does not exist', 'INVALID_REFERENCE')
    default:
      return err
  }
}
