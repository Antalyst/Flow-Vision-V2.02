import type { Transaction } from 'sequelize'
import { Liaison } from './models.ts'

const MANILA_DAY = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Manila' })
const sameManilaDay = (a: Date, b: Date) => MANILA_DAY.format(a) === MANILA_DAY.format(b)

/**
 * Fold one finished delivery leg into the liaison's metrics. The schema keeps
 * total_deliveries + success_rate, so successful legs are derived from the two.
 * `minutes` is pickup → delivery time and only counts toward the average on success.
 */
export async function recordOutcome(userId: string, { success, minutes = null }: { success: boolean; minutes?: number | null }, transaction?: Transaction) {
  const profile = await Liaison.findOne({ where: { user_id: userId }, transaction, lock: transaction?.LOCK.UPDATE })
  if (!profile) return

  const prevTotal = Number(profile.total_deliveries ?? 0)
  const prevRate = profile.success_rate == null ? 100 : Number(profile.success_rate)
  const prevSuccessful = Math.round((prevTotal * prevRate) / 100)

  const total = prevTotal + 1
  const successful = prevSuccessful + (success ? 1 : 0)
  const updates: Record<string, unknown> = { total_deliveries: total, success_rate: Math.round((successful / total) * 10000) / 100 }

  if (success) {
    const now = new Date()
    const prevAvg = profile.average_delivery_time
    if (minutes != null && Number.isFinite(minutes)) {
      updates.average_delivery_time = Math.round(prevAvg == null ? minutes : (prevAvg * (successful - 1) + minutes) / successful)
    }
    updates.deliveries_today = profile.last_delivery && sameManilaDay(new Date(profile.last_delivery), now) ? profile.deliveries_today + 1 : 1
    updates.last_delivery = now
  }
  await profile.update(updates, { transaction })
}

/** Deliveries today, treating a stale counter (last delivery on an earlier day) as zero. */
export function deliveriesToday(profile: Record<string, any> | null) {
  if (!profile?.last_delivery) return 0
  return sameManilaDay(new Date(profile.last_delivery), new Date()) ? Number(profile.deliveries_today ?? 0) : 0
}
