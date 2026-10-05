import crypto from 'node:crypto'
import QRCode from 'qrcode'
import { badRequest } from './errors.ts'

// offices.code is the whole {ORGCODE}-{DEPT}-{OFFICE} prefix, e.g. BAG-HR-HRMSO
export const OFFICE_CODE_RE = /^[A-Z0-9]+(?:-[A-Z0-9]+)*$/

/**
 * Every document gets one routing code when it is uploaded, printed as its QR label and
 * scanned at every hand-off until the document is done: {OFFICE_CODE}-{8 random digits},
 * e.g. BAG-ADM-RECORDS-48213907. The prefix is the code of the office it originated from.
 */
export const ROUTING_CODE_RE = /^[A-Z0-9]+(?:-[A-Z0-9]+)*-\d{8}$/
// offices.code is at most 50 characters, plus "-" and 8 digits.
const MAX_CODE_LENGTH = 59

/**
 * QR prefix for documents uploaded by accounts without an office (the CLIENT administrator):
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

export function buildRoutingCode(officeCode: string) {
  const digits = String(crypto.randomInt(0, 100_000_000)).padStart(8, '0')
  return `${officeCode}-${digits}`
}

export function parseRoutingCode(raw: unknown) {
  const code = typeof raw === 'string' ? raw.trim().toUpperCase() : ''
  if (!code) throw badRequest('Scan or type the document’s QR code')
  if (code.length > MAX_CODE_LENGTH || !ROUTING_CODE_RE.test(code)) {
    throw badRequest('This is not a FlowVision document code (expected OFFICE-CODE-12345678)')
  }
  return { code, officeCode: code.slice(0, -9) }
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
