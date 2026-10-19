import path from 'node:path'
import crypto from 'node:crypto'
import { Op, type Transaction } from 'sequelize'
import { DocumentType, KNOWLEDGE_KINDS, KnowledgeFile, Office, type Row } from './models.ts'
import { env } from './env.ts'
import { badRequest, httpError } from './errors.ts'
import { extractKnowledgeText } from './ai.ts'
import { canReadKnowledge, knowledgeWhere, type AiUserContext } from './ai-context.ts'
import { userSummary } from './serializers.ts'
import { deleteFile, getFile, putFile } from './file-store.ts'

/**
 * Organization Settings:
 *   document_types   the types offered when uploading, and the list the AI classifies into
 *   knowledge_files  files whose text is the AI's organization knowledge (terms, offices,
 *                    procedures). When the AI reads an upload, the passages that best match the
 *                    document go along with it — not whole files: the AI service limits how much
 *                    text one request may carry.
 */

/**
 * Offered to a new organization (and backfilled for existing ones by db:migrate), each with a
 * starting processing time the ADMIN can change in Organization Settings.
 */
export const DEFAULT_DOCUMENT_TYPES = [
  { name: 'Purchase Request', days: 3 },
  { name: 'Disbursement Voucher', days: 3 },
  { name: 'Travel Order', days: 2 },
  { name: 'Leave Application', days: 2 },
  { name: 'Memorandum', days: 1 },
  { name: 'Letter', days: 2 },
  { name: 'Contract', days: 5 },
] as const

export async function createDefaultDocumentTypes(orgId: string, userId: string | null, transaction?: Transaction) {
  await DocumentType.bulkCreate(
    DEFAULT_DOCUMENT_TYPES.map((t, i) => ({ org_id: orgId, name: t.name, processing_days: t.days, processing_hours: 0, sort_order: i, created_by: userId })),
    { transaction },
  )
}

/** Active types, in their order — what the upload form offers and the AI classifies into. */
export function activeDocumentTypes(orgId: string) {
  return DocumentType.findAll({ where: { org_id: orgId, is_active: true }, order: [['sort_order', 'ASC'], ['name', 'ASC']] })
}

/** A type's processing time in hours (days × 24 + hours). */
export const typeHours = (t: Row | null | undefined) => (t ? Number(t.processing_days ?? 0) * 24 + Number(t.processing_hours ?? 0) : 0)

/**
 * How long a document of this type may take, in hours — from the organization's document type
 * of that name. 0 when the type is unknown or has no time set (then the document gets no deadline).
 */
export async function processingHoursFor(orgId: string, typeName: string | null | undefined, transaction?: Transaction) {
  const { days, hours } = await processingTimeFor(orgId, typeName, transaction)
  return days * 24 + hours
}

/**
 * The same as days + hours. Days are working days once the organization sets its working hours
 * (see work-calendar.ts); 0 + 0 when the type is unknown or untimed.
 */
export async function processingTimeFor(orgId: string, typeName: string | null | undefined, transaction?: Transaction) {
  if (!typeName) return { days: 0, hours: 0 }
  const type = await DocumentType.findOne({ where: { org_id: orgId, name: typeName }, attributes: ['processing_days', 'processing_hours'], transaction })
  return { days: Number(type?.processing_days ?? 0), hours: Number(type?.processing_hours ?? 0) }
}

/** Processing time from a request body: whole days 0–365 plus hours 0–23. */
export function readProcessingTime(body: Record<string, unknown>) {
  const read = (field: string, max: number, label: string) => {
    const raw = body[field]
    if (raw == null || raw === '') return 0
    const n = Number(raw)
    if (!Number.isInteger(n) || n < 0 || n > max) throw badRequest(`${label} must be a whole number from 0 to ${max}`, { field })
    return n
  }
  return { processing_days: read('processing_days', 365, 'Days'), processing_hours: read('processing_hours', 23, 'Hours') }
}

export function documentTypeDto(t: Row, usage?: number) {
  return {
    id: t.id,
    name: t.name,
    description: t.description ?? null,
    processing_days: Number(t.processing_days ?? 0),
    processing_hours: Number(t.processing_hours ?? 0),
    /** processing_days × 24 + processing_hours; 0 = no deadline. */
    total_hours: typeHours(t),
    is_active: Boolean(t.is_active),
    sort_order: Number(t.sort_order ?? 0),
    ...(usage !== undefined && { usage }),
  }
}

// ---------------------------------------------------------------------------
// Knowledge files
// ---------------------------------------------------------------------------

const KNOWLEDGE_EXTS = new Set(['.pdf', '.docx', '.txt', '.md', '.markdown', '.csv'])
// LONGTEXT holds far more, but a few million characters is already a library of manuals.
const MAX_KNOWLEDGE_CHARS = 5_000_000
// How much knowledge goes with one AI request (≈ 1,500 tokens) — the free Groq tier allows ~12k tokens a minute.
const CONTEXT_BUDGET = 6000
const CHUNK = 1200

interface UploadPart {
  filename?: string
  type?: string
  data: Buffer
}

const safeName = (original: string | undefined) => {
  const base = path.basename(original || 'knowledge').replace(/[^\w.\- ()]+/g, '_').replace(/^\.+/, '')
  return (base || 'knowledge').slice(-120)
}

/**
 * The office a knowledge file is scoped to, as chosen by the ADMIN: null = organization-wide.
 * It must be an active office of the same organization. Never taken from the uploader's own office.
 */
export async function resolveKnowledgeOffice(orgId: string, officeId: unknown) {
  if (officeId == null || officeId === '') return null
  const office = await Office.findOne({ where: { id: String(officeId), org_id: orgId, status: 'active' }, attributes: ['id', 'name'] })
  if (!office) throw badRequest('Office not found', { field: 'office_id' })
  return office
}

export const readKnowledgeKind = (value: unknown) => {
  if (value == null || value === '') return null
  const kind = String(value).toUpperCase()
  if (!(KNOWLEDGE_KINDS as readonly string[]).includes(kind)) throw badRequest('Kind must be GENERAL or CITIZENS_CHARTER', { field: 'kind' })
  return kind as (typeof KNOWLEDGE_KINDS)[number]
}

const UNREADABLE = 'The file could not be read. If it is a scanned PDF, upload a version with selectable text.'

/** Extract a knowledge file's text with its lines and pages kept (index_version 1). */
async function extractForKnowledge(data: Buffer, name: string, mime: string | undefined) {
  try {
    const content = await extractKnowledgeText(data, name, mime, { maxChars: MAX_KNOWLEDGE_CHARS })
    if (content.replace(/\s/g, '').length < 20) {
      return { content: null, char_count: 0, status: 'NO_TEXT' as const, error: 'No readable text found. Scanned PDFs need a version with selectable text.', index_version: 1 }
    }
    return { content, char_count: content.length, status: 'READY' as const, error: null, index_version: 1 }
  } catch (err) {
    console.error('[knowledge] text extraction failed', err)
    return { content: null, char_count: 0, status: 'FAILED' as const, error: UNREADABLE, index_version: 1 }
  }
}

/**
 * Read a stored knowledge file again with the current extractor, so files uploaded before pages
 * and headings were kept get them — without uploading them again. Scope and kind don't change.
 */
export async function reindexKnowledgeFile(file: Row) {
  const data = await readKnowledgeFile(file.file_url)
  if (!data) throw httpError(404, 'The stored copy of this file is missing. Upload it again.', 'FILE_MISSING')
  await file.update(await extractForKnowledge(data, String(file.file_name), (file.file_type as string | null) ?? undefined))
  return file
}

/** Save the file as knowledge/<uuid>/<name> (see file-store.ts) and extract its text for the AI. */
export async function saveKnowledgeFile(
  part: UploadPart,
  input: { orgId: string; userId: string; title: string | null; description: string | null; officeId?: string | null; kind?: (typeof KNOWLEDGE_KINDS)[number] | null },
) {
  if (part.data.length > env.maxKnowledgeBytes) throw httpError(413, `Knowledge files can be up to ${Math.round(env.maxKnowledgeBytes / 1024 / 1024)} MB`, 'PAYLOAD_TOO_LARGE')
  const name = safeName(part.filename)
  const ext = path.extname(name).toLowerCase()
  if (!KNOWLEDGE_EXTS.has(ext)) throw badRequest('Knowledge files can be PDF, Word (.docx), text (.txt), Markdown (.md) or CSV')

  const extracted = await extractForKnowledge(part.data, name, part.type)

  const folder = crypto.randomUUID()
  const fileUrl = `knowledge/${folder}/${name}`
  await putFile(fileUrl, part.data)
  try {
    return await KnowledgeFile.create({
      org_id: input.orgId,
      office_id: input.officeId ?? null,
      title: (input.title || path.basename(name, ext)).slice(0, 255),
      description: input.description,
      kind: input.kind ?? 'GENERAL',
      file_url: fileUrl,
      file_name: name,
      file_type: (part.type || '').slice(0, 100) || null,
      file_size: part.data.length,
      ...extracted,
      uploaded_by: input.userId,
    })
  } catch (err) {
    await removeKnowledgeFile(fileUrl)
    throw err
  }
}

const KNOWLEDGE_URL_RE = /^knowledge\/[0-9a-f-]{36}\/[^/\\]+$/

const knowledgeKey = (fileUrl: string | null | undefined) => (fileUrl && KNOWLEDGE_URL_RE.test(fileUrl) ? fileUrl : null)

/** A knowledge file's bytes, or null if it's missing. */
export async function readKnowledgeFile(fileUrl: string | null | undefined) {
  const key = knowledgeKey(fileUrl)
  return key ? getFile(key) : null
}

export async function removeKnowledgeFile(fileUrl: string | null | undefined) {
  const key = knowledgeKey(fileUrl)
  if (key) await deleteFile(key)
}

export function knowledgeDto(k: Row) {
  return {
    id: k.id,
    title: k.title,
    description: k.description ?? null,
    file_name: k.file_name,
    file_type: k.file_type ?? null,
    file_size: Number(k.file_size ?? 0),
    char_count: Number(k.char_count ?? 0),
    status: k.status,
    error: k.error ?? null,
    is_active: Boolean(k.is_active),
    kind: (k.kind as string) ?? 'GENERAL',
    office: k.office ? { id: k.office.id as string, name: String(k.office.name) } : null,
    // Uploaded before pages and headings were kept: "Re-read" in settings fixes it.
    needs_reread: k.status === 'READY' && Number(k.index_version ?? 0) < 1,
    created_at: new Date(k.created_at).toISOString(),
    uploader: k.uploader !== undefined ? userSummary(k.uploader) : undefined,
  }
}

// Common words that say nothing about what a passage is about.
const STOP = new Set(
  'the and for with that this from are was were will shall have has had not but you your our their they them its into upon such any all may can per sec section para of to in on at by an a or as is be it ng sa ang mga na at para ay si ni kay ito iyon'.split(' '),
)
export const wordsOf = (s: string) => (s.toLowerCase().match(/[a-z0-9ñ]{3,}/g) ?? []).filter((w) => !STOP.has(w))

/**
 * The knowledge passages that best match a document: every active file is cut into chunks, each
 * chunk scored by how many of the document's distinctive words it contains, and the best chunks
 * are returned up to the budget. Simple keyword retrieval — no extra service needed.
 */
export async function knowledgeContext(ctx: AiUserContext, documentText: string, budget = CONTEXT_BUDGET) {
  // Only the files the uploader may read: an office's private knowledge never reaches another office's suggestion.
  const rows = await KnowledgeFile.findAll({ where: { ...(knowledgeWhere(ctx) as object), char_count: { [Op.gt]: 0 } }, attributes: ['org_id', 'office_id', 'title', 'content'] })
  const files = rows.filter((f) => canReadKnowledge(f, ctx))
  if (!files.length) return ''

  // Distinctive words of the document, weighted by how often they appear in it.
  const weights = new Map<string, number>()
  for (const w of wordsOf(documentText)) weights.set(w, (weights.get(w) ?? 0) + 1)
  if (!weights.size) return ''

  const scored: Array<{ score: number; title: string; text: string }> = []
  for (const f of files) {
    const content = String(f.content ?? '')
    for (let i = 0; i < content.length; i += CHUNK) {
      const text = content.slice(i, i + CHUNK)
      const seen = new Set(wordsOf(text))
      let score = 0
      for (const w of seen) score += Math.min(weights.get(w) ?? 0, 5)
      if (score > 0) scored.push({ score, title: f.title as string, text })
    }
  }
  scored.sort((a, b) => b.score - a.score)

  const out: string[] = []
  let used = 0
  for (const c of scored) {
    const block = `[${c.title}] ${c.text}`
    if (used + block.length > budget) break
    out.push(block)
    used += block.length
  }
  return out.join('\n\n')
}
