export const escapeHtml = (s: string) => s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!)

/**
 * Print an HTML page from a hidden, sandboxed frame: no scripts run inside it (document content
 * is untrusted), and it needs no click, unlike a popup window, so it works right after saving.
 */
export function printHtml(title: string, css: string, body: string) {
  return new Promise<void>((resolve) => {
    const frame = document.createElement('iframe')
    frame.setAttribute('aria-hidden', 'true')
    frame.setAttribute('sandbox', 'allow-same-origin allow-modals')
    frame.style.cssText = 'position:fixed;right:0;bottom:0;width:0;height:0;border:0;visibility:hidden'
    frame.srcdoc = `<!doctype html><html><head><meta charset="utf-8"><title>${escapeHtml(title)}</title><style>${css}</style></head><body>${body}</body></html>`
    frame.addEventListener(
      'load',
      async () => {
        const win = frame.contentWindow!
        // Wait for images (logos, scanned pages, rendered PDF pages) before opening the dialog.
        await Promise.all([...win.document.images].map((img) => (img.complete ? null : img.decode().catch(() => null))))
        win.addEventListener('afterprint', () => setTimeout(() => frame.remove(), 500), { once: true })
        win.focus()
        win.print()
        setTimeout(() => frame.isConnected && frame.remove(), 120_000)
        resolve()
      },
      { once: true },
    )
    document.body.appendChild(frame)
  })
}

export interface LoadedImage {
  dataUrl: string
  bytes: Uint8Array
  type: 'png' | 'jpg'
  width: number
  height: number
}

const imageCache = new Map<string, Promise<LoadedImage | null>>()

/**
 * An image of our own (organization logo, template signature) as bytes and a data URL, with its
 * size — for printing and for Word / PDF exports. Null when it can't be loaded. Cached per URL
 * (the URLs carry a version, so a replaced image gets a new one).
 */
export function loadImage(url: string | null | undefined): Promise<LoadedImage | null> {
  if (!url || !import.meta.client) return Promise.resolve(null)
  let pending = imageCache.get(url)
  if (!pending) {
    pending = (async () => {
      try {
        const res = await fetch(url, { credentials: 'same-origin' })
        if (!res.ok) return null
        const blob = await res.blob()
        const bytes = new Uint8Array(await blob.arrayBuffer())
        const type = bytes[0] === 0x89 ? 'png' : 'jpg'
        const dataUrl = await new Promise<string>((resolve, reject) => {
          const reader = new FileReader()
          reader.onload = () => resolve(String(reader.result))
          reader.onerror = () => reject(reader.error)
          reader.readAsDataURL(blob)
        })
        const img = new Image()
        img.src = dataUrl
        await img.decode()
        return { dataUrl, bytes, type, width: img.naturalWidth || 1, height: img.naturalHeight || 1 }
      } catch {
        return null
      }
    })()
    imageCache.set(url, pending)
    // A failed load may succeed later (e.g. the logo is uploaded): don't keep the failure.
    pending.then((r) => r || imageCache.delete(url))
  }
  return pending
}

/** Fit an image inside a box, keeping its proportions. */
export function fitImage(img: { width: number; height: number }, maxWidth: number, maxHeight: number) {
  const scale = Math.min(maxWidth / img.width, maxHeight / img.height, 1)
  return { width: Math.round(img.width * scale), height: Math.round(img.height * scale) }
}
