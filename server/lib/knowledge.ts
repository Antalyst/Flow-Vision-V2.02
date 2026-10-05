import fs from 'node:fs/promises'
import path from 'node:path'
import crypto from 'node:crypto'
import { Op, type Transaction } from 'sequelize'
import { DocumentType, KnowledgeFile, type Row } from './models.ts'
import { env } from './env.ts'
import { badRequest, httpError } from './errors.ts'
import { extractText } from './ai.ts'
import { userSummary } from './serializers.ts'

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
 * starting processing time the CLIENT can change in Organization Settings.
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
  if (!typeName) return 0
  const type = await DocumentType.findOne({ where: { org_id: orgId, name: typeName }, attributes: ['processing_days', 'processing_hours'], transaction })
  return typeHours(type)
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

/** Save the file under UPLOAD_DIR/knowledge/<uuid>/ and extract its text for the AI. */
export async function saveKnowledgeFile(part: UploadPart, input: { orgId: string; userId: string; title: string | null; description: string | null }) {
  if (part.data.length > env.maxKnowledgeBytes) throw httpError(413, `Knowledge files can be up to ${Math.round(env.maxKnowledgeBytes / 1024 / 1024)} MB`, 'PAYLOAD_TOO_LARGE')
  const name = safeName(part.filename)
  const ext = path.extname(name).toLowerCase()
  if (!KNOWLEDGE_EXTS.has(ext)) throw badRequest('Knowledge files can be PDF, Word (.docx), text (.txt), Markdown (.md) or CSV')

  let content = ''
  let status: 'READY' | 'NO_TEXT' | 'FAILED' = 'READY'
  let error: string | null = null
  try {
    content = await extractText(part.data, name, part.type, { maxChars: MAX_KNOWLEDGE_CHARS })
    if (content.length < 20) status = 'NO_TEXT'
  } catch (err) {
    console.error('[knowledge] text extraction failed', err)
    status = 'FAILED'
    error = 'The file could not be read. If it is a scanned PDF, upload a version with selectable text.'
  }

  const folder = crypto.randomUUID()
  const fileUrl = `knowledge/${folder}/${name}`
  await fs.mkdir(path.join(env.uploadDir, 'knowledge', folder), { recursive: true })
  await fs.writeFile(path.join(env.uploadDir, 'knowledge', folder, name), part.data)
  try {
    return await KnowledgeFile.create({
      org_id: input.orgId,
      title: (input.title || path.basename(name, ext)).slice(0, 255),
      description: input.description,
      file_url: fileUrl,
      file_name: name,
      file_type: (part.type || '').slice(0, 100) || null,
      file_size: part.data.length,
      content: status === 'READY' ? content : null,
      char_count: status === 'READY' ? content.length : 0,
      status,
      error: status === 'NO_TEXT' ? 'No readable text found. Scanned PDFs need a version with selectable text.' : error,
      uploaded_by: input.userId,
    })
  } catch (err) {
    await removeKnowledgeFile(fileUrl)
    throw err
  }
}

const KNOWLEDGE_URL_RE = /^knowledge\/[0-9a-f-]{36}\/[^/\\]+$/

export function knowledgePath(fileUrl: string | null | undefined) {
  if (!fileUrl || !KNOWLEDGE_URL_RE.test(fileUrl)) return null
  const [, folder, name] = fileUrl.split('/') as [string, string, string]
  return path.join(env.uploadDir, 'knowledge', folder, path.basename(name))
}

export async function removeKnowledgeFile(fileUrl: string | null | undefined) {
  const filePath = knowledgePath(fileUrl)
  if (filePath) await fs.rm(path.dirname(filePath), { recursive: true, force: true }).catch(() => {})
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
export async function knowledgeContext(orgId: string, documentText: string, budget = CONTEXT_BUDGET) {
  const files = await KnowledgeFile.findAll({ where: { org_id: orgId, is_active: true, status: 'READY', char_count: { [Op.gt]: 0 } }, attributes: ['title', 'content'] })
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
