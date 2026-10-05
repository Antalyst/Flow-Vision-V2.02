import type { Priority } from './models.ts'

/**
 * Priority is not picked by the uploader: it is worked out from the document itself
 * (its type, title and description) and how fast its Document Route has to process it.
 * The strongest signal wins.
 */

export interface PrioritySignals {
  title?: string | null
  description?: string | null
  document_type?: string | null
  /** Total processing time of the route (sum of every step's days + hours). */
  routeHours?: number | null
}

const RANK: Record<Priority, number> = { LOW: 0, NORMAL: 1, HIGH: 2, URGENT: 3 }
const max = (a: Priority, b: Priority) => (RANK[b] > RANK[a] ? b : a)

const URGENT_WORDS = /\b(urgent|asap|immediate(ly)?|emergency|rush|critical|today|same[- ]day)\b/i
const HIGH_WORDS = /\b(priority|important|time[- ]sensitive|deadline|due|payroll|payment|salary|procurement)\b/i
const LOW_WORDS = /\b(fyi|for (your )?information|for reference|reference only|no rush|archive|courtesy copy)\b/i

// Document types that move money or bind the organization are handled first.
const HIGH_TYPES = ['purchase request', 'disbursement voucher', 'contract', 'payroll']
const LOW_TYPES = ['letter']

export function autoPriority({ title, description, document_type, routeHours }: PrioritySignals): Priority {
  const text = `${title ?? ''}\n${description ?? ''}`
  const type = (document_type ?? '').trim().toLowerCase()

  if (URGENT_WORDS.test(text) || (routeHours != null && routeHours > 0 && routeHours <= 8)) return 'URGENT'

  let priority: Priority = 'NORMAL'
  if (LOW_TYPES.includes(type) || LOW_WORDS.test(text)) priority = 'LOW'
  if (HIGH_TYPES.includes(type) || HIGH_WORDS.test(text)) priority = max(priority === 'LOW' ? 'NORMAL' : priority, 'HIGH')
  // A route that must finish within a day is never low priority.
  if (routeHours != null && routeHours > 0 && routeHours <= 24) priority = max(priority, 'HIGH')
  return priority
}
