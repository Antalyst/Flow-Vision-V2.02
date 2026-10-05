import fs from 'node:fs/promises'
import path from 'node:path'
import crypto from 'node:crypto'
import { env } from './env.ts'
import { badRequest, httpError } from './errors.ts'

const MIME_BY_EXT: Record<string, string> = {
  '.pdf': 'application/pdf',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.doc': 'application/msword',
  '.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  '.xls': 'application/vnd.ms-excel',
  '.xlsx': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
}
const ALLOWED_MIME = new Set(Object.values(MIME_BY_EXT))

export interface StoredFile {
  fileUrl: string // "<uuid>/<original name>", stored in documents.file_url
  fileType: string // documents.file_type (≤ 50 chars)
  size: number
  name: string // the original (safe) file name
}

interface MultipartPart {
  name?: string
  filename?: string
  type?: string
  data: Buffer
}

/** One document can carry this many files (a bulk upload) under its single QR code. */
export const MAX_FILES_PER_DOCUMENT = 50

/**
 * Split multipart parts into text fields and the saved files (every part named `file`, in order).
 * `file` is the first one, for callers that take a single attachment. If any file is rejected,
 * the ones already saved are removed again.
 */
export async function parseDocumentForm(parts: MultipartPart[] | undefined) {
  const fields: Record<string, string> = {}
  const fileParts: MultipartPart[] = []
  for (const part of parts ?? []) {
    if (!part.name) continue
    if (part.filename !== undefined) {
      if (part.name === 'file' && part.data.length) fileParts.push(part)
    } else {
      fields[part.name] = part.data.toString('utf8')
    }
  }
  if (fileParts.length > MAX_FILES_PER_DOCUMENT) throw badRequest(`A document can have at most ${MAX_FILES_PER_DOCUMENT} files`)
  const files: StoredFile[] = []
  try {
    for (const part of fileParts) files.push(await saveUpload(part))
  } catch (err) {
    files.forEach((f) => removeUpload(f.fileUrl))
    throw err
  }
  return { fields, files, file: files[0] ?? null }
}

/** Keep the original name readable but safe as a single path segment. */
function safeName(original: string | undefined) {
  const base = path.basename(original || 'attachment').replace(/[^\w.\- ()]+/g, '_').replace(/^\.+/, '')
  return (base || 'attachment').slice(-120)
}

async function saveUpload(part: MultipartPart): Promise<StoredFile> {
  if (part.data.length > env.maxUploadBytes) throw httpError(413, 'File is too large', 'PAYLOAD_TOO_LARGE')
  // Browsers on machines without Office often send Excel/Word files untyped
  // (empty or application/octet-stream): fall back to the extension then.
  const byExt = MIME_BY_EXT[path.extname(part.filename ?? '').toLowerCase()]
  const sent = part.type ?? ''
  const mime = ALLOWED_MIME.has(sent) ? sent : !sent || sent === 'application/octet-stream' ? (byExt ?? sent) : sent
  if (!ALLOWED_MIME.has(mime)) throw badRequest('Only PDF, Word, Excel or image (PNG, JPG, WebP) files can be attached')

  // A random folder per upload; the original name inside it is what people see.
  const folder = crypto.randomUUID()
  const name = safeName(part.filename)
  await fs.mkdir(path.join(env.uploadDir, folder), { recursive: true })
  await fs.writeFile(path.join(env.uploadDir, folder, name), part.data)
  // file_type is VARCHAR(50); long Office MIME types are stored as the extension.
  const fileType = mime.length <= 50 ? mime : path.extname(name).slice(1).toLowerCase()
  return { fileUrl: `${folder}/${name}`, fileType, size: part.data.length, name }
}

const FILE_URL_RE = /^[0-9a-f-]{36}\/[^/\\]+$/

/** Absolute path for a stored file_url, or null if the value isn't one of ours. */
export function uploadPath(fileUrl: string | null | undefined) {
  if (!fileUrl || !FILE_URL_RE.test(fileUrl)) return null
  const [folder, name] = fileUrl.split('/') as [string, string]
  return path.join(env.uploadDir, folder, path.basename(name))
}

export function contentTypeFor(fileUrl: string, fileType: string | null) {
  if (fileType?.includes('/')) return fileType
  return MIME_BY_EXT[path.extname(fileUrl).toLowerCase()] ?? 'application/octet-stream'
}

export function removeUpload(fileUrl: string | null | undefined) {
  const filePath = uploadPath(fileUrl)
  if (filePath) fs.rm(path.dirname(filePath), { recursive: true, force: true }).catch(() => {})
}
