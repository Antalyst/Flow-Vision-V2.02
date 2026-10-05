/**
 * In-memory counter of failed attempts per key (IP). Only failures count, so a whole
 * office signing in from behind one NAT address is never locked out by successful logins.
 * Per-process: a multi-instance deployment would move this to Redis.
 */
const WINDOW_MS = 15 * 60 * 1000
const LIMIT = 20

const failures = new Map<string, { count: number; resetAt: number }>()

export function isBlocked(key: string) {
  const entry = failures.get(key)
  if (!entry) return false
  if (entry.resetAt < Date.now()) {
    failures.delete(key)
    return false
  }
  return entry.count >= LIMIT
}

export function recordFailure(key: string) {
  const now = Date.now()
  const entry = failures.get(key)
  if (!entry || entry.resetAt < now) failures.set(key, { count: 1, resetAt: now + WINDOW_MS })
  else entry.count += 1
  // Keep the map from growing without bound under attack.
  if (failures.size > 10_000) {
    for (const [k, v] of failures) if (v.resetAt < now) failures.delete(k)
  }
}
