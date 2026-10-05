import { env } from '../lib/env.ts'
import { forbidden, httpError } from '../lib/errors.ts'

const MUTATING = new Set(['POST', 'PUT', 'PATCH', 'DELETE'])
const MAX_JSON_BYTES = 1024 * 1024

export default defineEventHandler((event) => {
  setResponseHeaders(event, {
    'X-Content-Type-Options': 'nosniff',
    'X-Frame-Options': 'SAMEORIGIN',
    'Referrer-Policy': 'strict-origin-when-cross-origin',
    // The QR scanner needs the camera on our own origin only.
    'Permissions-Policy': 'camera=(self), microphone=(), geolocation=()',
  })

  if (!event.path.startsWith('/api/') || !MUTATING.has(event.method)) return

  // CSRF: the session cookie is SameSite=Lax, and mutating API calls must also come
  // from our own origin. Requests without an Origin header (server-side, curl) pass.
  const origin = getRequestHeader(event, 'origin')
  if (origin) {
    const host = getRequestHeader(event, 'x-forwarded-host') ?? getRequestHeader(event, 'host')
    let originHost: string | null = null
    try {
      originHost = new URL(origin).host
    } catch {
      /* malformed origin */
    }
    if (!originHost || originHost !== host) throw forbidden('Cross-origin request rejected')
  }

  // Uploads have their own limit (MAX_UPLOAD_MB); everything else is small JSON.
  const length = Number(getRequestHeader(event, 'content-length') || 0)
  const isMultipart = getRequestHeader(event, 'content-type')?.includes('multipart/form-data')
  const fileLimit = event.path.startsWith('/api/org/knowledge') ? env.maxKnowledgeBytes : env.maxUploadBytes
  const limit = isMultipart ? fileLimit + 64 * 1024 : MAX_JSON_BYTES
  if (length > limit) throw httpError(413, isMultipart ? 'File is too large' : 'Request body is too large', 'PAYLOAD_TOO_LARGE')
})
