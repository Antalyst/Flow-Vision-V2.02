import { notFound } from '~~/server/lib/errors.ts'

/**
 * Any /api path no handler matches: a JSON 404 rather than the page renderer (which would redirect
 * to /login). Covers the removed endpoints too — public registration (/api/auth/register) and
 * document templates (/api/org/templates/…) — whatever the method, signed in or not.
 */
export default defineEventHandler(() => {
  throw notFound('API endpoint')
})
