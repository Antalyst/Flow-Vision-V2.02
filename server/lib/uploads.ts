import path from 'node:path'
import crypto from 'node:crypto'
import { env } from './env.ts'
import { badRequest, conflict, httpError } from './errors.ts'
import { commitStaged, deleteFile, dropAbandonedStaged, getFile, openFile, putFile, readStaged, stagedInfo, stagePart, PART_BYTES } from './file-store.ts'

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

const tooLarge = () => httpError(413, `Files can be up to ${Math.round(env.maxUploadBytes / 1024 / 1024)} MB in total`, 'PAYLOAD_TOO_LARGE')

/**
 * Split multipart parts into text fields and the saved files, in the order they were sent: every
 * part named `file`, and every `upload` field — the key of a large file sent ahead in parts (see
 * startStagedUpload). `file` is the first one, for callers that take a single attachment. If any
 * file is rejected, the ones already saved are removed again.
 */
export async function parseDocumentForm(parts: MultipartPart[] | undefined, userId: string) {
  const fields: Record<string, string> = {}
  const sources: Array<MultipartPart | string> = []
  for (const part of parts ?? []) {
    if (!part.name) continue
    if (part.filename !== undefined) {
      if (part.name === 'file' && part.data.length) sources.push(part)
    } else if (part.name === 'upload') {
      sources.push(part.data.toString('utf8'))
    } else {
      fields[part.name] = part.data.toString('utf8')
    }
  }
  if (sources.length > MAX_FILES_PER_DOCUMENT) throw badRequest(`A document can have at most ${MAX_FILES_PER_DOCUMENT} files`)
  const files: StoredFile[] = []
  try {
    for (const source of sources) {
      files.push(typeof source === 'string' ? await claimStagedUpload(source, userId) : await saveUpload(source))
      if (files.reduce((n, f) => n + f.size, 0) > env.maxUploadBytes) throw tooLarge()
    }
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

/** The file's MIME type, or a 400 if it isn't a kind that can be attached. */
function attachableType(filename: string | undefined, sent = '') {
  // Browsers on machines without Office often send Excel/Word files untyped
  // (empty or application/octet-stream): fall back to the extension then.
  const byExt = MIME_BY_EXT[path.extname(filename ?? '').toLowerCase()]
  const mime = ALLOWED_MIME.has(sent) ? sent : !sent || sent === 'application/octet-stream' ? (byExt ?? sent) : sent
  if (!ALLOWED_MIME.has(mime)) throw badRequest('Only PDF, Word, Excel or image (PNG, JPG, WebP) files can be attached')
  return mime
}

// file_type is VARCHAR(50); long Office MIME types are stored as the extension.
const storedType = (mime: string, name: string) => (mime.length <= 50 ? mime : path.extname(name).slice(1).toLowerCase())

/** A random folder per upload; the original name inside it is what people see. */
const newKey = (filename: string | undefined) => `${crypto.randomUUID()}/${safeName(filename)}`

async function saveUpload(part: MultipartPart): Promise<StoredFile> {
  if (part.data.length > env.maxUploadBytes) throw tooLarge()
  const mime = attachableType(part.filename, part.type)
  const key = newKey(part.filename)
  await putFile(key, part.data)
  const name = key.slice(key.indexOf('/') + 1)
  return { fileUrl: key, fileType: storedType(mime, name), size: part.data.length, name }
}

// ---------------------------------------------------------------------------
// Large files, sent ahead in parts (each request stays under Vercel's 4.5 MB)
// ---------------------------------------------------------------------------

/** Begin a large upload with its first part; returns the key the later parts and the form refer to. */
export async function startStagedUpload(part: MultipartPart, totalBytes: number, userId: string) {
  if (!Number.isInteger(totalBytes) || totalBytes < 1) throw badRequest('size is required')
  if (totalBytes > env.maxUploadBytes) throw tooLarge()
  if (part.data.length > PART_BYTES) throw httpError(413, 'Each part can be up to 3 MB', 'PAYLOAD_TOO_LARGE')
  attachableType(part.filename, part.type)
  await dropAbandonedStaged()
  const key = newKey(part.filename)
  await stagePart(key, 0, part.data, userId)
  return key
}

/** Add part number `index` (1, 2, …) to the uploader's own staged upload. */
export async function appendStagedUpload(key: string, index: number, data: Buffer, userId: string) {
  const info = uploadKey(key) ? await stagedInfo(key) : null
  if (!info || info.owner !== userId) throw badRequest('That upload was not found. Attach the file again.')
  if (index !== info.parts) throw conflict(`Expected part ${info.parts}, got ${index}`, 'PART_OUT_OF_ORDER')
  if (data.length > PART_BYTES) throw httpError(413, 'Each part can be up to 3 MB', 'PAYLOAD_TOO_LARGE')
  if (info.bytes + data.length > env.maxUploadBytes) throw tooLarge()
  await stagePart(key, index, data, userId)
  return info.bytes + data.length
}

/** The bytes of the uploader's own staged upload (for the AI to read), or null. */
export async function readStagedUpload(key: string, userId: string) {
  const info = uploadKey(key) ? await stagedInfo(key) : null
  if (!info || info.owner !== userId) return null
  const data = await readStaged(key)
  return data ? { name: key.slice(key.indexOf('/') + 1), data } : null
}

/** Turn the uploader's own staged upload into an attachment. */
async function claimStagedUpload(key: string, userId: string): Promise<StoredFile> {
  const info = uploadKey(key) ? await stagedInfo(key) : null
  if (!info || info.owner !== userId) throw badRequest('A large file did not finish uploading. Attach it again.')
  const name = key.slice(key.indexOf('/') + 1)
  const mime = attachableType(name)
  await commitStaged(key)
  return { fileUrl: key, fileType: storedType(mime, name), size: info.bytes, name }
}

// ---------------------------------------------------------------------------
// Stored attachments
// ---------------------------------------------------------------------------

const FILE_URL_RE = /^[0-9a-f-]{36}\/[^/\\]+$/

/** The stored file_url if it is one of ours (safe to use as a storage key), else null. */
export function uploadKey(fileUrl: string | null | undefined) {
  return fileUrl && FILE_URL_RE.test(fileUrl) ? fileUrl : null
}

const nameOf = (key: string) => key.slice(key.indexOf('/') + 1)

/** A stored attachment's file name and bytes, or null if it's missing. */
export async function readUpload(fileUrl: string | null | undefined) {
  const key = uploadKey(fileUrl)
  const data = key ? await getFile(key) : null
  return data ? { name: nameOf(key!), data } : null
}

/** A stored attachment as a stream, for sending it (large files stay out of memory). */
export async function openUpload(fileUrl: string | null | undefined) {
  const key = uploadKey(fileUrl)
  const file = key ? await openFile(key) : null
  return file ? { name: nameOf(key!), ...file } : null
}

export function contentTypeFor(fileUrl: string, fileType: string | null) {
  if (fileType?.includes('/')) return fileType
  return MIME_BY_EXT[path.extname(fileUrl).toLowerCase()] ?? 'application/octet-stream'
}

export function removeUpload(fileUrl: string | null | undefined) {
  const key = uploadKey(fileUrl)
  if (key) deleteFile(key).catch(() => {})
}
