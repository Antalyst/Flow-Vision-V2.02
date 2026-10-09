import { ACTIVITY_CATEGORIES, ACTIVITY_SCOPES, activityLog, scopesFor, type ActivityCategory, type ActivityScope } from '~~/server/lib/activity.ts'
import { badRequest } from '~~/server/lib/errors.ts'
import * as v from '~~/server/lib/validate.ts'

const DAY_MS = 24 * 60 * 60 * 1000

function pick<T extends string>(raw: string, allowed: readonly T[], fallback: T, field: string): T {
  const value = (raw || fallback).toLowerCase() as T
  if (!allowed.includes(value)) throw badRequest(`${field} must be one of: ${allowed.join(', ')}`, { field })
  return value
}

/**
 * The activity log (who did what, when). Query: `scope` (mine · office · organization — what the
 * account may see, see activity.ts), `category` (all · documents · messengers · approvals · admin),
 * `days` (1–365, default 30), `q` (document, code, person, office), `office` (CLIENT only: one
 * office — what happened there or was done by its people), `before` (cursor), `limit`.
 */
export default defineApiHandler(async (event) => {
  const user = await requireUser(event)
  const query = getQuery(event)
  const days = Math.min(Math.max(Number(query.days) || 30, 1), 365)
  const before = v.q(query, 'before', 40)
  return activityLog(user, {
    scope: pick<ActivityScope>(v.q(query, 'scope'), ACTIVITY_SCOPES, scopesFor(user)[0]!, 'scope'),
    category: pick<ActivityCategory>(v.q(query, 'category'), ACTIVITY_CATEGORIES, 'all', 'category'),
    since: new Date(Date.now() - days * DAY_MS),
    before: before && !Number.isNaN(Date.parse(before)) ? new Date(before).toISOString() : null,
    q: v.q(query, 'q', 100),
    limit: Math.min(Math.max(Number(query.limit) || 50, 1), 200),
    officeId: v.q(query, 'office', 36) || null,
  })
})
