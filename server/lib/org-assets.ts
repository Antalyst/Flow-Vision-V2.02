import crypto from 'node:crypto'
import { readMultipartFormData, setResponseHeaders, type H3Event } from 'h3'
import { badRequest, httpError } from './errors.ts'
import { deleteFile, getFile, putFile } from './file-store.ts'

/**
 * Images of Organization Settings: the organization logo (QR labels, document letterheads) and
 * template signatures. Stored like every other file (see file-store.ts) under
 *   org/<uuid>/logo.<png|jpg>          organizations.logo_url
 *   templates/<uuid>/signature.<ext>   document_templates.signature_url
 * Only PNG and JPEG, checked by their bytes — they print, go into Word and PDF exports, and are
 * served from our own origin (an SVG could carry script).
 */

const MAX_IMAGE_BYTES = 2 * 1024 * 1024
const KEY_RE = /^(org|templates)\/[0-9a-f-]{36}\/(logo|signature)\.(png|jpg)$/

function imageKind(data: Buffer): 'png' | 'jpg' | null {
  if (data.length > 8 && data[0] === 0x89 && data[1] === 0x50 && data[2] === 0x4e && data[3] === 0x47) return 'png'
  if (data.length > 3 && data[0] === 0xff && data[1] === 0xd8 && data[2] === 0xff) return 'jpg'
  return null
}

/** The storage key, when the value is one of ours (older rows may hold an outside URL). */
export const imageKey = (url: unknown) => (typeof url === 'string' && KEY_RE.test(url) ? url : null)

/** A short version tag for the image's URL, so a new image is never served from the browser cache. */
export const imageVersion = (url: unknown) => imageKey(url)?.split('/')[1]?.slice(0, 8) ?? null

/** The uploaded image part of a multipart request. */
export async function readImagePart(event: H3Event) {
  const parts = (await readMultipartFormData(event)) ?? []
  const part = parts.find((p) => p.name === 'file' && p.filename !== undefined && p.data.length)
  if (!part) throw badRequest('Choose an image to upload')
  return part
}

export async function saveImage(folder: 'org' | 'templates', name: 'logo' | 'signature', data: Buffer) {
  if (data.length > MAX_IMAGE_BYTES) throw httpError(413, 'Images can be up to 2 MB', 'PAYLOAD_TOO_LARGE')
  const kind = imageKind(data)
  if (!kind) throw badRequest('Use a PNG or JPG image')
  const key = `${folder}/${crypto.randomUUID()}/${name}.${kind}`
  await putFile(key, data)
  return key
}

export async function readImage(url: unknown) {
  const key = imageKey(url)
  const data = key ? await getFile(key) : null
  return data ? { data, type: key!.endsWith('.png') ? 'image/png' : 'image/jpeg' } : null
}

export async function removeImage(url: unknown) {
  const key = imageKey(url)
  if (key) await deleteFile(key).catch(() => {})
}

/** Send an image; its URL carries a version, so the browser may keep it. */
export function sendImage(event: H3Event, image: { data: Buffer; type: string }) {
  setResponseHeaders(event, {
    'Content-Type': image.type,
    'Cache-Control': 'private, max-age=86400',
    'X-Content-Type-Options': 'nosniff',
  })
  return image.data
}
