import type { AccountType, DocumentStatus, FlowDocument, Priority } from '~/types'

export const STATUS_META: Record<DocumentStatus, { label: string; tone: Tone }> = {
  CREATED: { label: 'Draft', tone: 'neutral' },
  START: { label: 'At origin', tone: 'primary' },
  PICKED_UP: { label: 'Picked up', tone: 'info' },
  IN_TRANSIT: { label: 'In transit', tone: 'info' },
  ARRIVED_AT_OFFICE: { label: 'Dropped off', tone: 'warning' },
  COMPLETED: { label: 'Completed', tone: 'success' },
  RETURNED: { label: 'Returned', tone: 'danger' },
}

export const PRIORITY_META: Record<Priority, { label: string; tone: Tone }> = {
  LOW: { label: 'Low', tone: 'neutral' },
  NORMAL: { label: 'Normal', tone: 'info' },
  HIGH: { label: 'High', tone: 'warning' },
  URGENT: { label: 'Urgent', tone: 'danger' },
}

export const ROLE_META: Record<AccountType, { label: string; home: string; tone: Tone; description: string }> = {
  CLIENT: { label: 'Client', home: '/client/dashboard', tone: 'primary', description: 'Submits documents and administers the organization' },
  EMPLOYEE: { label: 'Employee', home: '/employee/dashboard', tone: 'info', description: 'Receives and routes documents at an office' },
  STAFF: { label: 'Staff', home: '/staff/dashboard', tone: 'success', description: 'Approves at the final checkpoint; view-only elsewhere' },
  LIAISON: { label: 'Liaison', home: '/liaison/dashboard', tone: 'warning', description: 'Carries documents between offices' },
}

export type Tone = 'neutral' | 'primary' | 'success' | 'warning' | 'danger' | 'info'

export const TONE_CLASSES: Record<Tone, string> = {
  neutral: 'bg-ink/[0.06] text-ink-body',
  primary: 'bg-terracotta/12 text-terracotta-ink',
  success: 'bg-sage/15 text-sage-ink',
  warning: 'bg-amber/20 text-amber-ink',
  danger: 'bg-danger/12 text-danger-ink',
  info: 'bg-info/12 text-info-ink',
}

export const TONE_DOT: Record<Tone, string> = {
  neutral: 'bg-ink-3',
  primary: 'bg-terracotta',
  success: 'bg-sage',
  warning: 'bg-amber',
  danger: 'bg-danger',
  info: 'bg-info',
}

export const EVENT_LABELS: Record<string, string> = {
  CREATED: 'Draft created',
  SUBMITTED: 'Submitted',
  RESUBMITTED: 'Resubmitted',
  RECEIVED: 'Received (QR scanned)',
  PICKUP_REQUESTED: 'Messenger assigned',
  SENT_BACK: 'Flagged & sent back',
  PICKED_UP: 'Picked up by messenger',
  IN_TRANSIT: 'In transit',
  ARRIVED: 'Dropped off at office',
  DELIVERY_FAILED: 'Delivery failed',
  APPROVAL_REQUESTED: 'Awaiting final approval',
  APPROVED: 'Approved',
  RETURNED: 'Returned to submitter',
  COMPLETED: 'Completed',
  MESSENGER_REASSIGNED: 'Messenger reassigned',
  PASSED_TO_STAFF: 'Passed to the next staff',
  PASS_CANCELLED: 'Taken back from the next staff',
  NOTE: 'Note',
}

export function fullName(u?: { first_name: string; last_name: string } | null) {
  return u ? `${u.first_name} ${u.last_name}` : '—'
}

export function initials(u?: { first_name: string; last_name: string } | null) {
  return u ? `${u.first_name[0] ?? ''}${u.last_name[0] ?? ''}`.toUpperCase() : '?'
}

// Pinned to Philippine time so server-rendered and hydrated output always match.
export const TIME_ZONE = 'Asia/Manila'
const dateFmt = new Intl.DateTimeFormat('en-PH', { month: 'short', day: 'numeric', year: 'numeric', timeZone: TIME_ZONE })
const dateTimeFmt = new Intl.DateTimeFormat('en-PH', { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit', timeZone: TIME_ZONE })
const timeFmt = new Intl.DateTimeFormat('en-PH', { hour: 'numeric', minute: '2-digit', timeZone: TIME_ZONE })

/** Current hour (0–23) in Philippine time. */
export function localHour() {
  return Number(new Intl.DateTimeFormat('en-US', { hour: 'numeric', hourCycle: 'h23', timeZone: TIME_ZONE }).format(new Date()))
}

export const formatDate = (v?: string | null) => (v ? dateFmt.format(new Date(v)) : '—')
export const formatDateTime = (v?: string | null) => (v ? dateTimeFmt.format(new Date(v)) : '—')
export const formatTime = (v?: string | null) => (v ? timeFmt.format(new Date(v)) : '—')

export function timeAgo(v?: string | null) {
  if (!v) return '—'
  const seconds = Math.round((Date.now() - new Date(v).getTime()) / 1000)
  if (seconds < 45) return 'just now'
  const minutes = Math.round(seconds / 60)
  if (minutes < 60) return `${minutes}m ago`
  const hours = Math.round(minutes / 60)
  if (hours < 24) return `${hours}h ago`
  const days = Math.round(hours / 24)
  if (days < 7) return `${days}d ago`
  return formatDate(v)
}

export function formatDuration(minutes?: number | null) {
  if (minutes == null || Number.isNaN(minutes)) return '—'
  if (minutes < 1) return '<1 min'
  const total = Math.round(minutes)
  if (total < 60) return `${total} min`
  const h = Math.floor(total / 60)
  const m = total % 60
  return m ? `${h}h ${m}m` : `${h}h`
}

/** A processing time in hours as days + hours, e.g. 52 → "2d 4h", 5 → "5h". */
export function formatSla(hours?: number | null) {
  if (hours == null || Number.isNaN(hours)) return '—'
  const total = Math.max(0, Math.round(hours))
  const d = Math.floor(total / 24)
  const h = total % 24
  if (!d) return `${h}h`
  return h ? `${d}d ${h}h` : `${d}d`
}

export function formatBytes(bytes?: number | null) {
  if (!bytes) return '—'
  const units = ['B', 'KB', 'MB', 'GB']
  let i = 0
  let n = bytes
  while (n >= 1024 && i < units.length - 1) {
    n /= 1024
    i += 1
  }
  return `${n.toFixed(n < 10 && i > 0 ? 1 : 0)} ${units[i]}`
}

/**
 * A document type's processing time in words: "3 working days 2 hours" once the organization
 * set working hours (days are working days then), else "3d 2h".
 */
export function processingLabel(days: number, hours: number, working: boolean) {
  if (!working) return formatSla(days * 24 + hours)
  const parts = [days && `${days} working day${days === 1 ? '' : 's'}`, hours && `${hours} working hour${hours === 1 ? '' : 's'}`].filter(Boolean)
  return parts.join(' ') || '0 hours'
}

/**
 * Working time as working days + hours: with an 8-hour working day, 1,200 minutes → "2d 4h".
 * Around the clock (dayMinutes 1440) the days are ordinary days.
 */
export function formatWorkTime(minutes?: number | null, dayMinutes = 1440) {
  if (minutes == null || Number.isNaN(minutes)) return '—'
  const total = Math.max(0, Math.round(minutes))
  if (total < dayMinutes || dayMinutes <= 0) return formatDuration(total)
  const d = Math.floor(total / dayMinutes)
  const h = Math.floor((total - d * dayMinutes) / 60)
  return h ? `${d}d ${h}h` : `${d}d`
}

/**
 * How the document stands against its deadline: its document type's processing time from
 * submission (target_at), counted in the organization's working hours. Warning in the last
 * quarter of the time, danger once overdue. `paused`: the clock is stopped right now.
 */
export function deadlineState(doc: FlowDocument): { tone: Tone; label: string; paused?: boolean } | null {
  if (!doc.target_at || !doc.submitted_at || ['COMPLETED', 'RETURNED', 'CREATED'].includes(doc.status)) return null
  const p = doc.processing
  if (p && p.left_minutes != null && p.allowed_minutes != null) {
    const time = (m: number) => formatWorkTime(m, p.day_minutes)
    const paused = p.paused ? ' · paused' : ''
    if (p.left_minutes < 0) return { tone: 'danger', label: `Overdue by ${time(-p.left_minutes)}${paused}`, paused: p.paused }
    const tone: Tone = p.left_minutes < p.allowed_minutes * 0.25 ? 'warning' : 'success'
    return { tone, label: `${time(p.left_minutes)} left${paused}`, paused: p.paused }
  }
  const total = (new Date(doc.target_at).getTime() - new Date(doc.submitted_at).getTime()) / 60_000
  const remaining = (new Date(doc.target_at).getTime() - Date.now()) / 60_000
  if (remaining < 0) return { tone: 'danger', label: `Overdue by ${formatDuration(-remaining)}` }
  if (remaining < total * 0.25) return { tone: 'warning', label: `${formatDuration(remaining)} left` }
  return { tone: 'success', label: `${formatDuration(remaining)} left` }
}

/** Short human description of where a document is and what it is waiting for. */
export function whereabouts(doc: FlowDocument) {
  // At step 0 (the origin) a CLIENT upload is at the organization, not at an office.
  const office = doc.currentOffice?.name ?? doc.origin?.name ?? 'the office'
  switch (doc.status) {
    case 'CREATED':
      return 'Not yet submitted'
    case 'START':
    case 'ARRIVED_AT_OFFICE': {
      if (doc.current_step_number === 0) {
        if (doc.pickup_requested_at) return `At its origin, ${office} — ${doc.liaison ? fullName(doc.liaison) : 'a messenger'} will bring it to ${doc.next_office_name ?? 'the first office'}`
        return `At its origin, ${office} — assign a messenger to bring it to ${doc.next_office_name ?? 'the first office'}`
      }
      if (doc.pickup_requested_at) return `Released to ${doc.liaison ? fullName(doc.liaison) : 'a messenger'} at ${office}, waiting for pickup`
      if (!doc.received_at) {
        // Just submitted: the paper is still with its origin (the uploader's office or organization).
        if (doc.status === 'START' && doc.origin && doc.origin.office_id !== doc.current_office_id) return `Sent from ${doc.origin.name}, waiting for ${office} to scan it in`
        return `At ${office}, waiting to be scanned in`
      }
      return `In review at ${office}${doc.received_by ? ` — received by ${fullName(doc.received_by)}` : ''}`
    }
    case 'PICKED_UP':
    case 'IN_TRANSIT':
      return `${doc.liaison ? fullName(doc.liaison) : 'A messenger'} is bringing it to ${doc.next_office_name ?? 'the next office'}`
    case 'COMPLETED':
      return 'Approved and completed'
    case 'RETURNED':
      return 'Returned to submitter'
    default:
      return ''
  }
}

/**
 * Whether `userId` releases this document (assigns its messenger): at an office only the person
 * who received it; at its origin (step 0), anyone of the origin office. The server checks the same.
 */
export function releasesDocument(doc: FlowDocument, userId: string | null | undefined) {
  if (!userId) return false
  return doc.current_step_number === 0 || doc.received_by?.id === userId
}
