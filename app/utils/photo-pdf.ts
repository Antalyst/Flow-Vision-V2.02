/**
 * Photos of paper → one file to upload. Several photos become a PDF with one photo per A4 page;
 * JPEG data goes into a PDF as-is (DCTDecode), so no library is needed.
 */

export interface CapturedPage {
  blob: Blob
  width: number
  height: number
  /** Object URL for the thumbnail; revoke it when the page is dropped. */
  url: string
}

// A4 in PDF points, with a small margin around the photo.
const PAGE_W = 595.28
const PAGE_H = 841.89
const MARGIN = 18

export async function pagesToPdf(pages: CapturedPage[]): Promise<Blob> {
  const enc = new TextEncoder()
  const parts: Uint8Array[] = []
  const offsets: number[] = []
  let length = 0
  const push = (chunk: Uint8Array | string) => {
    const bytes = typeof chunk === 'string' ? enc.encode(chunk) : chunk
    parts.push(bytes)
    length += bytes.length
  }
  const object = (id: number, body: string) => {
    offsets[id] = length
    push(`${id} 0 obj\n${body}\nendobj\n`)
  }

  push('%PDF-1.4\n%\xE2\xE3\xCF\xD3\n')
  // 1 = catalog, 2 = page tree, then per page: page, image, contents.
  const pageIds = pages.map((_, i) => 3 + i * 3)
  object(1, '<< /Type /Catalog /Pages 2 0 R >>')
  object(2, `<< /Type /Pages /Kids [${pageIds.map((id) => `${id} 0 R`).join(' ')}] /Count ${pages.length} >>`)

  for (const [i, page] of pages.entries()) {
    const [pageId, imageId, contentId] = [pageIds[i]!, pageIds[i]! + 1, pageIds[i]! + 2]
    // Fit the photo inside the page, keeping its proportions, centred.
    const scale = Math.min((PAGE_W - 2 * MARGIN) / page.width, (PAGE_H - 2 * MARGIN) / page.height)
    const w = page.width * scale
    const h = page.height * scale
    const x = (PAGE_W - w) / 2
    const y = (PAGE_H - h) / 2

    object(pageId, `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${PAGE_W} ${PAGE_H}] /Resources << /XObject << /Im0 ${imageId} 0 R >> >> /Contents ${contentId} 0 R >>`)

    const jpeg = new Uint8Array(await page.blob.arrayBuffer())
    offsets[imageId] = length
    push(`${imageId} 0 obj\n<< /Type /XObject /Subtype /Image /Width ${page.width} /Height ${page.height} /ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /DCTDecode /Length ${jpeg.length} >>\nstream\n`)
    push(jpeg)
    push('\nendstream\nendobj\n')

    const draw = `q ${w.toFixed(2)} 0 0 ${h.toFixed(2)} ${x.toFixed(2)} ${y.toFixed(2)} cm /Im0 Do Q`
    object(contentId, `<< /Length ${draw.length} >>\nstream\n${draw}\nendstream`)
  }

  const count = 3 + pages.length * 3
  const xref = length
  push(`xref\n0 ${count}\n0000000000 65535 f \n`)
  for (let id = 1; id < count; id++) push(`${String(offsets[id]).padStart(10, '0')} 00000 n \n`)
  push(`trailer\n<< /Size ${count} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF`)
  return new Blob(parts as BlobPart[], { type: 'application/pdf' })
}

/**
 * The live server takes at most 4.5 MB per request (Vercel), so photos are shrunk, step by step,
 * until an upload fits. The first step is the size pictures are taken at.
 */
export const SHRINK_STEPS = [
  { maxSide: 2000, quality: 0.85 },
  { maxSide: 1600, quality: 0.75 },
  { maxSide: 1280, quality: 0.68 },
  { maxSide: 1024, quality: 0.6 },
]

/** Draw an image source (video frame or picked photo) to a JPEG, at most `maxSide` pixels long. */
export async function toJpegPage(source: CanvasImageSource, srcWidth: number, srcHeight: number, maxSide = 2000, quality = 0.85): Promise<CapturedPage> {
  const page = await encodeJpeg(source, srcWidth, srcHeight, maxSide, quality)
  return { ...page, url: URL.createObjectURL(page.blob) }
}

async function encodeJpeg(source: CanvasImageSource, srcWidth: number, srcHeight: number, maxSide: number, quality: number) {
  const scale = Math.min(1, maxSide / Math.max(srcWidth, srcHeight))
  const width = Math.round(srcWidth * scale)
  const height = Math.round(srcHeight * scale)
  const canvas = document.createElement('canvas')
  canvas.width = width
  canvas.height = height
  const ctx = canvas.getContext('2d')!
  // White behind transparent images, so the JPEG isn't black there.
  ctx.fillStyle = '#fff'
  ctx.fillRect(0, 0, width, height)
  ctx.drawImage(source, 0, 0, width, height)
  const blob = await new Promise<Blob>((resolve, reject) => canvas.toBlob((b) => (b ? resolve(b) : reject(new Error('Could not encode the photo'))), 'image/jpeg', quality))
  return { blob, width, height }
}

/** A JPEG version of an image (file or taken page), at most `maxSide` pixels long. */
async function reencode(image: Blob, maxSide: number, quality: number) {
  const bitmap = await createImageBitmap(image, { imageOrientation: 'from-image' })
  try {
    return await encodeJpeg(bitmap, bitmap.width, bitmap.height, maxSide, quality)
  } finally {
    bitmap.close()
  }
}

/** Taken pages joined into one PDF, with the photos made smaller until it is at most `maxBytes`. */
export async function pagesToPdfWithin(pages: CapturedPage[], maxBytes: number): Promise<Blob> {
  let pdf = await pagesToPdf(pages)
  for (const { maxSide, quality } of SHRINK_STEPS.slice(1)) {
    if (pdf.size <= maxBytes) break
    const smaller = await Promise.all(pages.map((p) => reencode(p.blob, maxSide, quality)))
    pdf = await pagesToPdf(smaller.map((p) => ({ ...p, url: '' })))
  }
  return pdf
}

/** An image file as a JPEG, at most `maxSide` pixels long (named .jpg). */
export async function shrinkImageFile(file: File, maxSide: number, quality: number): Promise<File> {
  const { blob } = await reencode(file, maxSide, quality)
  return new File([blob], `${file.name.replace(/\.[^.]+$/, '')}.jpg`, { type: 'image/jpeg' })
}

/**
 * Files that together fit in `maxBytes`: the images among them are made smaller, step by step,
 * from the originals each time. Null when they don't fit even at the smallest step.
 */
export async function fitFiles(files: File[], maxBytes: number): Promise<File[] | null> {
  const total = (list: File[]) => list.reduce((n, f) => n + f.size, 0)
  if (total(files) <= maxBytes) return files
  for (const { maxSide, quality } of SHRINK_STEPS.slice(1)) {
    const smaller = await Promise.all(files.map((f) => (f.type.startsWith('image/') ? shrinkImageFile(f, maxSide, quality) : f)))
    if (total(smaller) <= maxBytes) return smaller
  }
  return null
}

/** A photo file picked from the phone's camera app or gallery, as a page. */
export async function fileToPage(file: File): Promise<CapturedPage> {
  const bitmap = await createImageBitmap(file, { imageOrientation: 'from-image' })
  try {
    return await toJpegPage(bitmap, bitmap.width, bitmap.height)
  } finally {
    bitmap.close()
  }
}
