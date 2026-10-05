import { SESSION_COOKIE, revokeSessionToken } from '~~/server/lib/auth.ts'

export default defineApiHandler(async (event) => {
  await revokeSessionToken(getCookie(event, SESSION_COOKIE))
  clearSessionCookie(event)
  return { ok: true }
})
