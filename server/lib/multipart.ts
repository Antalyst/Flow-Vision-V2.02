import { getRequestHeader, readFormData, type H3Event, type MultiPartData } from 'h3'
import { badRequest, httpError } from './errors.ts'

/**
 * Reads a multipart/form-data upload through the web-standard parser (`readFormData`).
 *
 * Why not h3's `readMultipartFormData`? It copies every byte of a file part into a plain JavaScript
 * array, and V8 can't grow an array past about 112 million elements: a single file of roughly
 * 108 MiB or more fails with "RangeError: Invalid array length" (and a 100 MiB one takes ~13 s
 * against well under a second here). The web parser has no such limit.
 *
 * - The body is parsed once per request; calling this again returns the same parts.
 * - `maxBytes` is checked against the declared Content-Length *before* the body is read (413).
 *   Each saved file is still size-checked by the caller, which covers chunked uploads.
 * - Not multipart at all → undefined (callers answer "choose a file"); malformed → 400.
 * - Same shape as `readMultipartFormData`: `{ name, filename?, type?, data: Buffer }` per part.
 */
const PARSED = '__uploadParts'
// Multipart boundaries and the text fields come on top of the file itself.
const ENVELOPE_BYTES = 1024 * 1024

export async function readUploadParts(event: H3Event, { maxBytes }: { maxBytes: number }): Promise<MultiPartData[] | undefined> {
  const cached = event.context[PARSED] as MultiPartData[] | undefined
  if (cached) return cached

  const contentType = getRequestHeader(event, 'content-type') ?? ''
  if (!/^multipart\/form-data/i.test(contentType)) return undefined
  if (!/boundary=/i.test(contentType)) throw badRequest('The upload is malformed: no multipart boundary')

  const declared = Number(getRequestHeader(event, 'content-length'))
  if (Number.isFinite(declared) && declared > maxBytes + ENVELOPE_BYTES) {
    // (server/middleware/security.ts already answers this for the knowledge route; this keeps the
    // helper safe for routes with other limits.) The body is left unread.
    throw httpError(413, `Files can be up to ${Math.round(maxBytes / 1024 / 1024)} MB`, 'PAYLOAD_TOO_LARGE')
  }

  let form: FormData
  try {
    form = await readFormData(event)
  } catch (err) {
    // Only the reason is logged, never the body (it may be a private document).
    console.warn('[upload] could not parse multipart body:', err instanceof Error ? err.message : 'unknown error')
    throw badRequest('The upload could not be read. Send the file as multipart/form-data.')
  }

  const parts: MultiPartData[] = []
  for (const [name, value] of form.entries()) {
    if (typeof value === 'string') {
      parts.push({ name, data: Buffer.from(value, 'utf8') })
    } else {
      // Buffer.from(ArrayBuffer) shares the memory: the file isn't copied again.
      parts.push({ name, filename: value.name, ...(value.type && { type: value.type }), data: Buffer.from(await value.arrayBuffer()) })
    }
  }
  event.context[PARSED] = parts
  return parts
}
