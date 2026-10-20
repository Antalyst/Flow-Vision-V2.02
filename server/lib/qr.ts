import crypto from 'node:crypto'
import QRCode from 'qrcode'
import { badRequest } from './errors.ts'

// offices.code is the whole {ORGCODE}-{DEPT}-{OFFICE} prefix, e.g. BAG-HR-HRMSO
export const OFFICE_CODE_RE = /^[A-Z0-9]+(?:-[A-Z0-9]+)*$/

/**
 * Every document gets one routing code when it is uploaded, printed as its QR label and
 * scanned at every hand-off until the document is done:
 *   {OFFICE_CODE}-{MMDDYY upload date}-{6 random digits}, e.g. CHO-SNTR-102026-123456
 * The prefix is the code of the office (or umbrella office) it originated from; the date
 * (Philippine time) lets people find documents by the day they were uploaded.
 * Labels printed earlier still scan: {OFFICE_CODE}{MMDDYY}{6 digits} (e.g. BCC100726123456) and
 * {OFFICE_CODE}-{8 digits} (e.g. BCL-54967520).
 */
export const DASHED_ROUTING_CODE_RE = /^[A-Z0-9]+(?:-[A-Z0-9]+)*-\d{6}-\d{6}$/
export const ROUTING_CODE_RE = /^[A-Z0-9]+(?:-[A-Z0-9]+)*\d{12}$/
export const LEGACY_ROUTING_CODE_RE = /^[A-Z0-9]+(?:-[A-Z0-9]+)*-\d{8}$/
export const isRoutingCode = (code: string) => DASHED_ROUTING_CODE_RE.test(code) || ROUTING_CODE_RE.test(code) || LEGACY_ROUTING_CODE_RE.test(code)
// offices.code is at most 50 characters, plus "-MMDDYY-" and 6 random digits.
const MAX_CODE_LENGTH = 64

const MANILA_PARTS = new Intl.DateTimeFormat('en-US', { timeZone: 'Asia/Manila', year: '2-digit', month: '2-digit', day: '2-digit' })

/** The date segment of a routing code: MMDDYY in Philippine time, e.g. 100726 for Oct 7, 2026. */
export function routingDate(date: Date) {
  const parts = Object.fromEntries(MANILA_PARTS.formatToParts(date).map((p) => [p.type, p.value]))
  return `${parts.month}${parts.day}${parts.year}`
}

/**
 * Read a typed MMDDYY (e.g. 100726) as a Philippine calendar day: its start and end in UTC.
 * Null when it isn't a real date.
 */
export function parseRoutingDate(value: string) {
  const m = /^(\d{2})(\d{2})(\d{2})$/.exec(value)
  if (!m) return null
  const [month, day, year] = [Number(m[1]), Number(m[2]), 2000 + Number(m[3])]
  const utc = Date.UTC(year, month - 1, day)
  const check = new Date(utc)
  if (check.getUTCMonth() !== month - 1 || check.getUTCDate() !== day) return null
  // Manila is UTC+8 all year.
  const start = new Date(utc - 8 * 3600_000)
  return { start, end: new Date(start.getTime() + 24 * 3600_000) }
}

/**
 * QR prefix for documents uploaded by accounts without an office (the admin):
 * the organization's own code. Organizations have no code column, so it is the first segment
 * all its office codes share ({ORGCODE}-{DEPT}-{OFFICE}, e.g. BAG), or else the initials of
 * its name ("Bago City LGU" → BCL).
 */
export function organizationCode(name: string, officeCodes: string[]) {
  const firsts = new Set(officeCodes.filter((c) => c.includes('-')).map((c) => c.split('-')[0]!))
  if (firsts.size === 1 && officeCodes.every((c) => c.includes('-'))) return [...firsts][0]!
  const words = name.toUpperCase().match(/[A-Z0-9]+/g) ?? []
  const initials = words.length > 1 ? words.map((w) => w[0]).join('') : (words[0] ?? 'ORG').slice(0, 4)
  return initials.slice(0, 10) || 'ORG'
}

/** `uploadedAt` sets the date segment: a replacement label keeps the document's upload date. */
export function buildRoutingCode(officeCode: string, uploadedAt = new Date()) {
  const digits = String(crypto.randomInt(0, 1_000_000)).padStart(6, '0')
  return `${officeCode}-${routingDate(uploadedAt)}-${digits}`
}

/**
 * The same code written the other way, so a code typed with or without the dashes around the date
 * finds its label: CHO-102026-123456 ⇄ CHO102026123456. Null for the 8-digit legacy format.
 */
export function alternateRoutingCode(code: string) {
  if (DASHED_ROUTING_CODE_RE.test(code)) return `${code.slice(0, -14)}${code.slice(-13, -7)}${code.slice(-6)}`
  if (ROUTING_CODE_RE.test(code)) return `${code.slice(0, -12)}-${code.slice(-12, -6)}-${code.slice(-6)}`
  return null
}

export function parseRoutingCode(raw: unknown) {
  const code = typeof raw === 'string' ? raw.trim().toUpperCase() : ''
  if (!code) throw badRequest('Scan or type the document’s QR code')
  if (code.length > MAX_CODE_LENGTH || !isRoutingCode(code)) {
    throw badRequest('This is not a FlowVision document code (expected the office code, the date and 6 digits, e.g. CHO-102026-123456)')
  }
  const officeCode = DASHED_ROUTING_CODE_RE.test(code) ? code.slice(0, -14) : LEGACY_ROUTING_CODE_RE.test(code) ? code.slice(0, -9) : code.slice(0, -12)
  return { code, officeCode }
}

/** SVG renders crisply when printed at 25mm × 25mm; the PNG data URL is for quick previews. */
export async function renderQr(payload: string) {
  const options = { errorCorrectionLevel: 'M' as const, margin: 1, color: { dark: '#1B1B1B', light: '#FFFFFF' } }
  const [svg, dataUrl] = await Promise.all([
    QRCode.toString(payload, { ...options, type: 'svg' }),
    QRCode.toDataURL(payload, { ...options, width: 320 }),
  ])
  return { svg, dataUrl }
}
