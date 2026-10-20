import { PAGE_BREAK } from './ai.ts'
import { chunkContent, scorePassage, type Passage } from './ai-knowledge.ts'
import { wordsOf } from './knowledge.ts'

/**
 * Citizen's Charter helpers for Organization Settings › Document types.
 *
 * 1. parseServiceList: the charter's "List of Services" (a table of contents: each office, its
 *    divisions "Office - Division", their External / Internal Services, with page numbers) as rows
 *    the ADMIN can import as document types. This part of a charter is usually plain text even when
 *    the service tables themselves are scanned images.
 * 2. extractProcessingTime: the processing time written for one service, from that service's own
 *    passages ("TOTAL 1 day and 30 minutes", "Processing time: 3 days"; or, failing that, the sum of
 *    its step times). Only what the text says — never estimated.
 */

export interface ListedService {
  /** The office line as printed, e.g. "City Mayor’s Office - Administrative Division". */
  office: string
  /** The part before " - " (the office), and after it (the division / umbrella office), if any. */
  parent_office: string
  division: string | null
  category: 'INTERNAL' | 'EXTERNAL' | null
  name: string
  /** The page number printed in the list (the charter's own numbering). */
  page: number | null
}

const TRAILING_PAGE = /^(.*?\S)\s+(\d{1,4})$/
const SECTION = /^(external|internal)\s+services?\b/i
const OTHER_SECTION = /^other\s+services?\b/i
const SKIP = /^(annex\b|v\.\s*list of services)/i
const END = /^(feedback and complaints?|contact information|list of offices)\b/i
// The last word of an office or division name, as charters write them ("City Budget Office", "Local Civil Registrar").
const OFFICE_WORD = /\b(office|division|section|committee|registrar|hospital|college|panlungsod|unit|center|centre|department|board)$/i

/** Lines of the List of Services part of the charter: from its heading to "Feedback and Complaints". */
function listLines(content: string) {
  const lines = content.replaceAll(PAGE_BREAK, '\n').split('\n').map((l) => l.replace(/\s+/g, ' ').trim())
  const start = lines.findIndex((l) => /list of services/i.test(l))
  if (start < 0) return []
  const out: string[] = []
  for (const line of lines.slice(start + 1)) {
    if (END.test(line)) break
    // Page footers (a lone page number) and blank lines carry nothing.
    if (!line || /^\d{1,4}$/.test(line)) continue
    out.push(line)
  }
  return out
}

/** Document type names are at most 100 characters: cut a long service name at a word, with "…". */
export const fitName = (name: string, max = 100) => {
  const clean = name.replace(/\s+/g, ' ').trim()
  if (clean.length <= max) return clean
  const cut = clean.slice(0, max - 1)
  return `${cut.slice(0, cut.lastIndexOf(' ') > max * 0.6 ? cut.lastIndexOf(' ') : cut.length).replace(/[,;:\-–— ]+$/, '')}…`
}

export function parseServiceList(content: string): ListedService[] {
  const raw = listLines(content)
  // Entries wrap over several lines; an entry ends with its page number. Sub-headings end with ':'.
  const entries: Array<{ text: string; page: number | null }> = []
  let pending = ''
  for (const line of raw) {
    if (SKIP.test(line)) {
      pending = ''
      continue
    }
    if (/:$/.test(line) || OTHER_SECTION.test(line)) {
      entries.push({ text: `${pending} ${line}`.trim(), page: null })
      pending = ''
      continue
    }
    const m = TRAILING_PAGE.exec(line)
    if (m) {
      entries.push({ text: `${pending} ${m[1]}`.trim(), page: Number(m[2]) })
      pending = ''
    } else {
      pending = `${pending} ${line}`.trim()
    }
  }

  const isSection = (t: string) => SECTION.test(t)
  const services: ListedService[] = []
  let office = ''
  let category: ListedService['category'] = null
  let lastService: string | null = null
  entries.forEach((e, i) => {
    if (isSection(e.text)) {
      category = /^internal/i.test(e.text) ? 'INTERNAL' : 'EXTERNAL'
      return
    }
    if (OTHER_SECTION.test(e.text) || /:$/.test(e.text)) return
    // An office heading is followed by its first section heading, or by one of its own divisions.
    // Offices list External Services first, so "…, then Internal Services" right after an external
    // service is just the same office's second section — unless the line is one of its divisions.
    const next = entries[i + 1]?.text ?? ''
    const parentNow = office.split(/\s+-\s+|-\s+/)[0]!.trim()
    const heading =
      next.startsWith(`${e.text} - `) ||
      next.startsWith(`${e.text}- `) ||
      (isSection(next) && (/^external/i.test(next) || category !== 'EXTERNAL' || OFFICE_WORD.test(e.text) || (Boolean(parentNow) && e.text.startsWith(`${parentNow} - `))))
    if (heading) {
      office = e.text
      category = null
      lastService = null
      return
    }
    if (!office) return
    // "A. Traditional Transaction" under a service is a way of availing that service.
    const variant = /^[A-Z]\.\s+(.*)$/.exec(e.text)
    const name = variant && lastService ? `${lastService} — ${variant[1]}` : e.text
    if (!variant) lastService = e.text
    const [parentOffice, ...rest] = office.split(/\s+-\s+|-\s+/)
    services.push({ office, parent_office: parentOffice!.trim(), division: rest.length ? rest.join(' - ').trim() : null, category, name: fitName(name), page: e.page })
  })
  return services
}

// ---------------------------------------------------------------------------
// Matching charter office names to FlowVision offices
// ---------------------------------------------------------------------------

const norm = (s: string) =>
  s
    .toLowerCase()
    .replace(/[’']/g, '')
    .replace(/[^a-z0-9 ]+/g, ' ')
    .replace(/\b(the|of|and|office|city)\b/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    // "Mayor’s" and "Mayor", "Services" and "Service" are the same word here.
    .split(' ')
    .map((w) => (w.length > 3 && w.endsWith('s') ? w.slice(0, -1) : w))
    .join(' ')

/** How alike two office names are (0–1): shared words over the longer name's words. */
export function nameSimilarity(a: string, b: string) {
  const wa = new Set(norm(a).split(' ').filter(Boolean))
  const wb = new Set(norm(b).split(' ').filter(Boolean))
  if (!wa.size || !wb.size) return norm(a) === norm(b) ? 1 : 0
  let shared = 0
  for (const w of wa) if (wb.has(w)) shared++
  return shared / Math.max(wa.size, wb.size)
}

export interface OfficeLite {
  id: string
  name: string
  code: string
  parent_office_id: string | null
}

/**
 * The FlowVision office (or umbrella office) a charter office line most likely means: for
 * "Office - Division", an umbrella of the matched office whose name matches the division, else the
 * office itself. null when nothing is alike enough (≥ 0.6) — the ADMIN then picks one or Global.
 */
export function matchOffice(service: Pick<ListedService, 'parent_office' | 'division'>, offices: OfficeLite[]) {
  const best = (candidates: OfficeLite[], name: string) => {
    let pick: OfficeLite | null = null
    let score = 0
    for (const o of candidates) {
      const s = Math.max(nameSimilarity(o.name, name), o.code.toLowerCase() === name.toLowerCase() ? 1 : 0)
      if (s > score) [pick, score] = [o, s]
    }
    return score >= 0.6 ? pick : null
  }
  const parent = best(offices.filter((o) => !o.parent_office_id), service.parent_office)
  if (service.division) {
    const pool = parent ? offices.filter((o) => o.parent_office_id === parent.id) : offices.filter((o) => o.parent_office_id)
    const umbrella = best(pool, service.division)
    if (umbrella) return umbrella
    // A division with its own office in FlowVision (e.g. "City Population Office" set up as an office).
    const asOffice = best(offices, service.division)
    if (asOffice) return asOffice
  }
  return parent
}

// ---------------------------------------------------------------------------
// Processing time of one service
// ---------------------------------------------------------------------------

export interface TimeFound {
  minutes: number
  days: number
  hours: number
  mins: number
  basis: 'total' | 'stated' | 'sum_of_steps'
  /** The line(s) the time was read from, exactly as in the charter. */
  lines: string[]
}

const UNIT = /(\d+(?:\.\d+)?)\s*(working\s+days?|days?|hours?|hrs?|minutes?|mins?)\b/gi

/** "1 day, 2 hours and 30 minutes" → minutes (a working day counts as 8 hours, like the charter's). */
export function durationMinutes(text: string, workDayHours = 8) {
  let total = 0
  let found = false
  for (const m of text.matchAll(UNIT)) {
    const n = Number(m[1])
    const unit = m[2]!.toLowerCase()
    found = true
    if (unit.startsWith('day') || unit.startsWith('working')) total += n * workDayHours * 60
    else if (unit.startsWith('h')) total += n * 60
    else total += n
  }
  return found ? Math.round(total) : null
}

const split = (minutes: number, workDayHours = 8) => {
  const dayMin = workDayHours * 60
  const days = Math.floor(minutes / dayMin)
  const rest = minutes - days * dayMin
  return { days, hours: Math.floor(rest / 60), mins: rest % 60 }
}

/** The processing time written in a service's text, or null when the text doesn't state one. */
export function extractProcessingTime(text: string, workDayHours = 8): TimeFound | null {
  const lines = text.split('\n').map((l) => l.trim()).filter(Boolean)
  // 1. A TOTAL line (charters end each table with the total processing time).
  for (const [i, line] of lines.entries()) {
    if (!/^total\b/i.test(line)) continue
    const window = [line, lines[i + 1] ?? ''].join(' ')
    const minutes = durationMinutes(window, workDayHours)
    if (minutes) return { minutes, ...split(minutes, workDayHours), basis: 'total', lines: [line, ...(durationMinutes(line, workDayHours) ? [] : [lines[i + 1]!])] }
  }
  // 2. "Processing time: 3 days" written out.
  for (const line of lines) {
    const m = /processing\s+time\s*[:\-]?\s*(.+)$/i.exec(line)
    const minutes = m ? durationMinutes(m[1]!, workDayHours) : null
    if (minutes) return { minutes, ...split(minutes, workDayHours), basis: 'stated', lines: [line] }
  }
  // 3. The step times of the table, added up (each step's "15 minutes", "1 day").
  const steps = lines.filter((l) => durationMinutes(l, workDayHours) != null && !/^total\b/i.test(l))
  if (steps.length >= 2) {
    const minutes = steps.reduce((n, l) => n + (durationMinutes(l, workDayHours) ?? 0), 0)
    if (minutes > 0) return { minutes, ...split(minutes, workDayHours), basis: 'sum_of_steps', lines: steps.slice(0, 12) }
  }
  return null
}

/**
 * The passages of `content` that belong to the service called `serviceName`: the section whose
 * heading matches it best (≥ 60 % of its words), plus the passages that follow it in that section.
 */
export function servicePassages(content: string, indexVersion: number | null | undefined, serviceName: string): Passage[] {
  const terms = [...new Set(wordsOf(serviceName))]
  if (!terms.length) return []
  const passages = chunkContent(content, indexVersion)
  let bestSection: string | null = null
  let bestScore = 0
  for (const p of passages) {
    if (!p.section) continue
    const s = scorePassage({ ...p, text: p.section }, terms)
    if (s && s.coverage > bestScore) [bestSection, bestScore] = [p.section, s.coverage]
  }
  if (bestSection && bestScore >= 0.6) return passages.filter((p) => p.section === bestSection)
  // No heading matches: the passages that mention most of the name.
  return passages.filter((p) => (scorePassage(p, terms)?.coverage ?? 0) >= 0.75).slice(0, 4)
}
