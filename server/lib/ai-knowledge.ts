import { Op } from 'sequelize'
import { KnowledgeFile, Office, type Row } from './models.ts'
import { wordsOf } from './knowledge.ts'
import { PAGE_BREAK } from './ai.ts'
import { canReadKnowledge, knowledgeWhere, type AiUserContext } from './ai-context.ts'

/**
 * The assistant's view of the organization's knowledge files (Organization Settings), always
 * through the user's knowledge scope (ai-context.ts): the SQL filter first, then every row is
 * checked again in code. Office filtering is never left to the AI's prompt.
 *
 * Retrieval is keyword based (no embeddings): files are cut into passages that remember their page
 * and section heading; a passage qualifies only when it contains at least half of the question's
 * words, so a single shared word never produces a confident answer.
 */

// ≈ 1,500 tokens of passages per search — keeps a full tool round inside Groq's per-minute limits.
const DEFAULT_BUDGET = 6000
const CHUNK = 1300
const LEGACY_CHUNK = 1400
const LEGACY_OVERLAP = 200
const MAX_SERVICES = 80

const officeInclude = { model: Office, as: 'office', attributes: ['id', 'name', 'code'] }

export type KnowledgeFocus = 'requirements' | 'fees' | 'processing_time' | 'steps' | 'services' | 'general'
export const KNOWLEDGE_FOCUSES: readonly KnowledgeFocus[] = ['requirements', 'fees', 'processing_time', 'steps', 'services', 'general']

/** Words a Citizen's Charter uses for each kind of question (they score, but less than the user's own words). */
const FOCUS_TERMS: Record<KnowledgeFocus, string[]> = {
  requirements: ['requirements', 'requirement', 'checklist', 'documents', 'secure', 'submit', 'copy', 'original'],
  fees: ['fees', 'fee', 'paid', 'amount', 'payment', 'php', 'pesos', 'charge', 'free', 'cost'],
  processing_time: ['processing', 'time', 'minutes', 'hours', 'days', 'duration', 'total'],
  steps: ['steps', 'step', 'client', 'agency', 'actions', 'procedure', 'process', 'responsible', 'person'],
  services: ['services', 'service', 'internal', 'external', 'office', 'division', 'classification', 'transaction', 'avail'],
  general: [],
}

/** Fallback when the AI doesn't say what the question is about. */
export function detectFocus(question: string): KnowledgeFocus {
  const q = question.toLowerCase()
  if (/\b(requirements?|checklist|documents? (needed|required)|what (do|should) i (bring|submit))\b/.test(q)) return 'requirements'
  if (/\b(fees?|how much|cost|payment|charges?|bayad)\b/.test(q)) return 'fees'
  if (/\b(processing time|how long|duration|minutes|days)\b/.test(q)) return 'processing_time'
  if (/\b(steps?|procedures?|process|how (do|to))\b/.test(q)) return 'steps'
  if (/\b(services?|internal|external)\b/.test(q)) return 'services'
  return 'general'
}

// ---------------------------------------------------------------------------
// Passages: page- and section-aware chunks
// ---------------------------------------------------------------------------

export interface Passage {
  text: string
  /** 1-based page, when the file kept its pages (PDFs re-read after this change). */
  page: number | null
  /** The nearest heading above the passage, when one could be recognised. */
  section: string | null
  /** internal / external, when the passage sits under an "Internal/External Services" heading. */
  category: 'internal' | 'external' | null
}

const FIELD_RE = /^(office or division|classification|type of transaction|who may avail)\s*:/i
const NUMBERED_RE = /^(\d+(\.\d+)*[.)]|[ivx]+\.|[a-z]\.)\s+\S/i
const CATEGORY_RE = /\b(internal|external)\s+services?\b/i
// Table headings and other labels every charter repeats; they never name a service.
const GENERIC_RE =
  /^(checklist of requirements|requirements?|where to secure|fees? to be paid|fees?|processing time|person responsible|client steps?|agency actions?|total|end of transaction|internal services|external services|feedback and complaints?( mechanism)?|list of offices|citizen'?s charter|service information|note[s:]?)\b/i

/** A short line that reads like a heading: mostly capitals, or numbered ("1. Issuance of …"). */
export function isHeading(line: string) {
  if (line.length < 3 || line.length > 120 || FIELD_RE.test(line)) return false
  const letters = line.replace(/[^a-z]/gi, '')
  if (letters.length < 3) return false
  const upper = letters.replace(/[^A-Z]/g, '').length / letters.length
  if (upper >= 0.8) return true
  return NUMBERED_RE.test(line) && line.length <= 110 && !/[.;:]$/.test(line)
}

const cleanHeading = (line: string) => line.replace(NUMBERED_RE.test(line) ? /^(\d+(\.\d+)*[.)]|[ivx]+\.|[a-z]\.)\s+/i : /^$/, '').trim().slice(0, 150)

/** Did this file keep its lines and pages (index_version 1, or plain text that had line breaks)? */
export const hasLayout = (content: string, indexVersion?: number | null) => Number(indexVersion ?? 0) >= 1 || content.includes('\n') || content.includes(PAGE_BREAK)

/**
 * Cut a file into passages. Layout text is walked line by line so every passage knows its page and
 * the heading it falls under; flattened (legacy) text gets fixed-size passages without locators.
 */
export function chunkContent(content: string, indexVersion?: number | null): Passage[] {
  if (!content) return []
  if (!hasLayout(content, indexVersion)) {
    const out: Passage[] = []
    for (let i = 0; i < content.length; i += LEGACY_CHUNK - LEGACY_OVERLAP) {
      out.push({ text: content.slice(i, i + LEGACY_CHUNK).trim(), page: null, section: null, category: null })
      if (i + LEGACY_CHUNK >= content.length) break
    }
    return out
  }

  const pages = content.split(PAGE_BREAK)
  const paged = pages.length > 1
  const out: Passage[] = []
  let section: string | null = null
  let category: Passage['category'] = null
  let buffer: string[] = []
  let bufferPage = 1
  let bufferSection: string | null = null
  let bufferCategory: Passage['category'] = null
  let size = 0
  let currentPage = 1

  const flush = (keepTail: boolean) => {
    const text = buffer.join('\n').trim()
    if (text) out.push({ text, page: paged ? bufferPage : null, section: bufferSection, category: bufferCategory })
    // Carry the last two lines over, so a rule split across passages is still found whole once.
    buffer = keepTail ? buffer.slice(-2) : []
    size = buffer.reduce((n, l) => n + l.length + 1, 0)
    bufferPage = currentPage
    bufferSection = section
    bufferCategory = category
  }

  pages.forEach((page, p) => {
    currentPage = p + 1
    for (const line of page.split('\n')) {
      if (!line.trim()) continue
      if (isHeading(line)) {
        const marker = CATEGORY_RE.exec(line)
        if (marker) category = marker[1]!.toLowerCase() as 'internal' | 'external'
        if (!GENERIC_RE.test(line)) {
          // A new section starts a new passage, so passages don't straddle two services.
          if (size > 200) flush(false)
          section = cleanHeading(line)
        }
      }
      if (!buffer.length) {
        bufferPage = p + 1
        bufferSection = section
        bufferCategory = category
      }
      buffer.push(line)
      size += line.length + 1
      if (size >= CHUNK) flush(true)
    }
    // Passages never cross a page, so each has one page number.
    if (paged) flush(false)
  })
  flush(false)
  return out
}

// ---------------------------------------------------------------------------
// Scoring
// ---------------------------------------------------------------------------

export interface ScoredPassage extends Passage {
  score: number
  /** Share of the question's own words found in the passage (0–1). */
  coverage: number
}

/**
 * Score one passage. Each distinct question word found counts 1 (2 when it is also in the section
 * heading or file title); focus words add 0.3 each (at most 1.5); consecutive question words found
 * together add 0.5. Below half the question's words, the passage doesn't qualify (null).
 */
export function scorePassage(passage: Passage, terms: string[], { focus = 'general', title = '', bonusTerms = [] }: { focus?: KnowledgeFocus; title?: string; bonusTerms?: string[] } = {}): ScoredPassage | null {
  if (!terms.length) return null
  const words = new Set(wordsOf(passage.text))
  const headingWords = new Set(wordsOf(`${passage.section ?? ''} ${title}`))
  let matched = 0
  let score = 0
  for (const t of terms) {
    if (!words.has(t) && !headingWords.has(t)) continue
    matched++
    score += headingWords.has(t) ? 2 : 1
  }
  const coverage = matched / terms.length
  const needed = Math.max(1, Math.ceil(terms.length / 2))
  if (matched < needed) return null

  let extra = 0
  for (const t of FOCUS_TERMS[focus]) if (words.has(t)) extra += 0.3
  score += Math.min(extra, 1.5)
  for (const t of bonusTerms) if (words.has(t) || headingWords.has(t)) score += 0.5
  const lower = passage.text.toLowerCase()
  for (let i = 0; i + 1 < terms.length; i++) if (lower.includes(`${terms[i]} ${terms[i + 1]}`)) score += 0.5
  return { ...passage, score, coverage }
}

// ---------------------------------------------------------------------------
// Scope helpers
// ---------------------------------------------------------------------------

export interface OfficeTarget {
  id: string
  name: string
  code: string | null
}

/** Words of an office's name and code, to recognise it inside an organization-wide charter. */
export const officeTerms = (office: OfficeTarget | null) => (office ? [...new Set([...wordsOf(office.name), ...wordsOf(office.code ?? '')])] : [])

/**
 * The office a question is about, by name or code, inside the user's organization. Users who can't
 * read every office may only name their own: another office is refused without saying whether it
 * has any knowledge.
 */
export async function resolveOfficeTarget(ctx: AiUserContext, name: string | undefined): Promise<{ office: OfficeTarget | null; error?: string }> {
  if (!name) return { office: null }
  const p = `%${name.replace(/[\\%_]/g, (c) => `\\${c}`)}%`
  const found = await Office.findAll({
    where: { org_id: ctx.orgId, [Op.or]: [{ name: { [Op.like]: p } }, { code: { [Op.like]: p } }] },
    attributes: ['id', 'name', 'code'],
    limit: 5,
  })
  if (!found.length) return { office: null, error: `No office of the organization matches "${name}".` }
  const mine = ctx.office && found.find((o) => o.id === ctx.office!.id)
  const pick = mine ?? found[0]!
  if (!ctx.allOffices && pick.id !== ctx.office?.id) {
    return { office: null, error: "This account can only search its own office's knowledge and organization-wide files. Tell the user their role can't view another office's knowledge." }
  }
  return { office: { id: pick.id as string, name: String(pick.name), code: (pick.code as string | null) ?? null } }
}

/** Files the user may read, optionally narrowed to one office (its own files plus organization-wide ones). */
async function readableFiles(ctx: AiUserContext, { office, charterOnly = false, withContent = true }: { office?: OfficeTarget | null; charterOnly?: boolean; withContent?: boolean } = {}) {
  const where: Record<string | symbol, unknown> = { ...(knowledgeWhere(ctx) as object) }
  if (charterOnly) where.kind = 'CITIZENS_CHARTER'
  if (office) where[Op.and] = [{ [Op.or]: [{ office_id: null }, { office_id: office.id }] }]
  const rows = await KnowledgeFile.findAll({
    where,
    attributes: ['id', 'org_id', 'office_id', 'title', 'description', 'kind', 'index_version', ...(withContent ? ['content'] : [])],
    include: [officeInclude],
    order: [['title', 'ASC']],
  })
  // Defense in depth: the query already filtered, every row is checked again here.
  return rows.filter((f) => canReadKnowledge(f, ctx) && (!office || f.office_id == null || f.office_id === office.id))
}

const scopeLabel = (f: Row) => (f.office_id ? String(f.office?.name ?? 'an office') : 'Organization-wide')

// ---------------------------------------------------------------------------
// Catalog (system prompt)
// ---------------------------------------------------------------------------

/** Titles, descriptions, kind and scope of the files this user may read — never anyone else's. */
export async function knowledgeCatalog(ctx: AiUserContext) {
  const files = await readableFiles(ctx, { withContent: false })
  return files.slice(0, 40).map((f) => ({
    title: String(f.title),
    description: f.description ? String(f.description).slice(0, 200) : null,
    charter: f.kind === 'CITIZENS_CHARTER',
    scope: scopeLabel(f),
    needsReread: !hasLayout('', f.index_version),
  }))
}

// ---------------------------------------------------------------------------
// Search
// ---------------------------------------------------------------------------

export interface KnowledgeSource {
  title: string
  scope: string
  page: number | null
  section: string | null
}

export interface KnowledgeSearchResult {
  files_searched: number
  evidence: 'strong' | 'weak' | 'none'
  passages: Array<KnowledgeSource & { text: string; charter: boolean; category: Passage['category'] }>
}

/**
 * The passages that best answer `query`, from the files this user may read. `office` narrows to
 * that office's files plus organization-wide ones, where passages naming the office rank higher.
 */
export async function searchKnowledge(
  ctx: AiUserContext,
  query: string,
  { office = null, focus = detectFocus(query), charterOnly = false, budget = DEFAULT_BUDGET }: { office?: OfficeTarget | null; focus?: KnowledgeFocus; charterOnly?: boolean; budget?: number } = {},
): Promise<KnowledgeSearchResult> {
  const files = await readableFiles(ctx, { office, charterOnly })
  const terms = [...new Set(wordsOf(query))]
  if (!files.length || !terms.length) return { files_searched: files.length, evidence: 'none', passages: [] }
  const bonusTerms = officeTerms(office).filter((t) => !terms.includes(t))

  const scored: Array<ScoredPassage & { file: Row }> = []
  for (const f of files) {
    for (const passage of chunkContent(String(f.content ?? ''), f.index_version)) {
      const s = scorePassage(passage, terms, { focus, title: String(f.title), bonusTerms })
      if (!s) continue
      // The office asked about first, then Citizen's Charter files for service questions.
      if (office && f.office_id === office.id) s.score *= 1.5
      if (f.kind === 'CITIZENS_CHARTER' && focus !== 'general') s.score *= 1.15
      scored.push({ ...s, file: f })
    }
  }
  scored.sort((a, b) => b.score - a.score || b.coverage - a.coverage)

  const passages: KnowledgeSearchResult['passages'] = []
  let used = 0
  for (const s of scored) {
    if (used + s.text.length > budget) break
    passages.push({ title: String(s.file.title), scope: scopeLabel(s.file), page: s.page, section: s.section, category: s.category, charter: s.file.kind === 'CITIZENS_CHARTER', text: s.text })
    used += s.text.length
  }
  const top = scored[0]
  const evidence = !top ? 'none' : top.coverage >= 0.75 ? 'strong' : 'weak'
  return { files_searched: files.length, evidence, passages }
}

// ---------------------------------------------------------------------------
// Citizen's Charter services
// ---------------------------------------------------------------------------

export interface CharterService {
  name: string
  category: 'internal' | 'external' | 'unclassified'
  office_or_division: string | null
  transaction_type: string | null
  page: number | null
}

/**
 * Services listed in a Citizen's Charter (ARTA layout): a service heading followed by its
 * "Office or Division / Classification / Type of Transaction / Who may avail" lines, under an
 * "Internal Services" or "External Services" heading. A service whose heading isn't under either
 * is reported as unclassified — never guessed.
 */
export function parseCharterServices(content: string): CharterService[] {
  const pages = content.split(PAGE_BREAK)
  const paged = pages.length > 1
  const services: CharterService[] = []
  let category: CharterService['category'] = 'unclassified'
  let heading: { name: string; page: number } | null = null
  let current: CharterService | null = null

  pages.forEach((page, p) => {
    for (const raw of page.split('\n')) {
      const line = raw.trim()
      if (!line) continue
      const field = FIELD_RE.exec(line)
      if (field) {
        if (!current && heading) {
          current = { name: heading.name, category, office_or_division: null, transaction_type: null, page: paged ? heading.page : null }
          services.push(current)
          heading = null
        }
        const value = line.slice(line.indexOf(':') + 1).trim().slice(0, 150) || null
        if (current && /^office or division/i.test(field[1]!)) current.office_or_division ??= value
        if (current && /^type of transaction/i.test(field[1]!)) current.transaction_type ??= value
        continue
      }
      if (isHeading(line)) {
        const marker = CATEGORY_RE.exec(line)
        if (marker) category = marker[1]!.toLowerCase() as 'internal' | 'external'
        if (!GENERIC_RE.test(line) && !marker) {
          heading = { name: cleanHeading(line), page: p + 1 }
          current = null
        }
      }
    }
  })
  // The same service can be repeated on a continuation page.
  const seen = new Set<string>()
  return services.filter((s) => {
    const key = `${s.category}|${s.name.toLowerCase()}`
    if (seen.has(key)) return false
    seen.add(key)
    return true
  })
}

/** Does a service's "Office or Division" line name this office (its code, or most of its name)? */
export function servesOffice(service: CharterService, office: OfficeTarget) {
  const text = (service.office_or_division ?? '').toLowerCase()
  if (!text) return false
  if (office.code && text.includes(office.code.toLowerCase())) return true
  const nameWords = wordsOf(office.name)
  if (!nameWords.length) return false
  const found = nameWords.filter((w) => text.includes(w)).length
  return found / nameWords.length >= 0.6
}

/**
 * The services of the Citizen's Charter files this user may read. With `office`, that office's
 * charter files count whole; services from organization-wide charters are kept only when their
 * "Office or Division" line names the office.
 */
export async function listCharterServices(ctx: AiUserContext, { office = null }: { office?: OfficeTarget | null } = {}) {
  const files = await readableFiles(ctx, { office, charterOnly: true })
  const services: Array<CharterService & { source: string; scope: string }> = []
  const unreadable: string[] = []
  const noServices: string[] = []
  for (const f of files) {
    const content = String(f.content ?? '')
    if (!hasLayout(content, f.index_version)) {
      unreadable.push(String(f.title))
      continue
    }
    let found = parseCharterServices(content)
    if (office && f.office_id !== office.id) found = found.filter((s) => servesOffice(s, office))
    if (!found.length) noServices.push(String(f.title))
    for (const s of found) services.push({ ...s, source: String(f.title), scope: scopeLabel(f) })
  }
  const count = (c: CharterService['category']) => services.filter((s) => s.category === c).length
  return {
    charter_files: files.length,
    totals: { internal: count('internal'), external: count('external'), unclassified: count('unclassified') },
    services: services.slice(0, MAX_SERVICES),
    ...(services.length > MAX_SERVICES && { shortened: `Only the first ${MAX_SERVICES} of ${services.length} services are listed.` }),
    ...(unreadable.length && { files_needing_reread: unreadable }),
    ...(noServices.length && { files_without_recognised_services: noServices }),
  }
}
