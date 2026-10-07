import type { DocumentFileInfo, FlowDocument, Office, QrInfo, UserSummary } from '~/types'

export type ScanAction = 'PICKUP' | 'RECEIVE'

export interface ScanPreview {
  action: ScanAction | null
  reason: string | null
  /** `info` = nothing to do, but nothing is wrong (e.g. a messenger checking where to go). */
  tone: 'info' | 'error' | null
  document: Pick<FlowDocument, 'id' | 'tracking_number' | 'qr_code' | 'title' | 'priority' | 'status' | 'current_step_number'>
  /** Where the document is now (or is being carried from). */
  from_office: Pick<Office, 'id' | 'code' | 'name' | 'department_name'> | null
  /** The next office on its route. */
  to_office: Pick<Office, 'id' | 'code' | 'name' | 'department_name'> | null
  messenger: UserSummary | null
  received_by: UserSummary | null
  /** A co-worker passed it to the next staff; it waits to be received at the next desk. */
  passed_by?: UserSummary | null
}

type PrintableDoc = Pick<FlowDocument, 'id' | 'title' | 'file_name'>

/**
 * {OFFICE_CODE}{MMDDYY upload date}{6 random digits}, e.g. BCC100726123456 — the prefix is the origin
 * office's code. Labels printed before (BCL-54967520: code, dash, 8 digits) still scan.
 */
const QR_PATTERN = /^[A-Z0-9]+(?:-[A-Z0-9]+)*(?:\d{12}|-\d{8})$/i
// Long PDFs print the first pages only, to keep the browser responsive.
const MAX_PDF_PAGES = 60

const esc = (s: string) => s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]!)

const LABEL_CSS = `
  .label { display: inline-flex; flex-direction: column; align-items: center; gap: 1.2mm; padding: 2mm; background: #fff; border: 0.3mm dashed #BDBAB2; }
  .label .qr svg { width: 25mm; height: 25mm; display: block; }
  .label .code { font: 700 2.6mm ui-monospace, monospace; letter-spacing: 0.02em; color: #1B1B1B; }
  .label .title { font-size: 2mm; max-width: 34mm; text-align: center; color: #5F5B54; }`

const labelHtml = (qr: QrInfo, doc: Pick<FlowDocument, 'title'>) =>
  `<div class="label"><div class="qr">${qr.svg}</div><div class="code">${esc(qr.payload)}</div><div class="title">${esc(doc.title)}</div></div>`

/**
 * Print an HTML page from a hidden, sandboxed frame: no scripts run inside it (document content
 * is untrusted), and it needs no click, unlike a popup window, so it works right after saving.
 */
function printHtml(title: string, css: string, body: string) {
  return new Promise<void>((resolve) => {
    const frame = document.createElement('iframe')
    frame.setAttribute('aria-hidden', 'true')
    frame.setAttribute('sandbox', 'allow-same-origin allow-modals')
    frame.style.cssText = 'position:fixed;right:0;bottom:0;width:0;height:0;border:0;visibility:hidden'
    frame.srcdoc = `<!doctype html><html><head><meta charset="utf-8"><title>${esc(title)}</title><style>${css}</style></head><body>${body}</body></html>`
    frame.addEventListener(
      'load',
      async () => {
        const win = frame.contentWindow!
        // Wait for images (scanned pages, rendered PDF pages) before opening the dialog.
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


/** Render a PDF's pages to images in the browser, so they print in the same job as the QR. */
async function renderPdfPages(url: string) {
  const { getDocumentProxy, renderPageAsImage } = await import('unpdf')
  const res = await fetch(url, { credentials: 'same-origin' })
  if (!res.ok) throw new Error(`Could not load the PDF (${res.status})`)
  const pdf = await getDocumentProxy(new Uint8Array(await res.arrayBuffer()))
  const pages: string[] = []
  for (let n = 1; n <= Math.min(pdf.numPages, MAX_PDF_PAGES); n++) pages.push(await renderPageAsImage(pdf, n, { scale: 2, toDataURL: true }))
  return { pages, truncated: pdf.numPages > MAX_PDF_PAGES }
}

export function useQR() {
  const api = useApi()
  const ui = useUiStore()

  /** Print a 25mm × 25mm label with the routing code underneath, so it can be typed in if a camera can't read it. */
  function printLabel(qr: QrInfo, doc: Pick<FlowDocument, 'title'>) {
    return printHtml(
      qr.payload,
      `@page { size: auto; margin: 8mm; } body { font-family: system-ui, sans-serif; margin: 0; padding: 8mm; } ${LABEL_CSS}`,
      labelHtml(qr, doc),
    )
  }

  /**
   * Print the uploaded document — every file of it, in order (a bulk upload has several) — untouched,
   * followed by one extra last page carrying its QR code, in one print job. PDFs, images and Word
   * (.docx) files print this way; other files are skipped (and named), and a document without any
   * prints the QR page alone.
   */
  async function printWithDocument(qr: QrInfo, doc: PrintableDoc, files: DocumentFileInfo[] = []) {
    // Older callers pass no list: the document's one file.
    const list: DocumentFileInfo[] = files.length
      ? files
      : doc.file_name
        ? [{ id: 'main', name: doc.file_name, type: null, size: 0, url: `/api/documents/${doc.id}/file` }]
        : []
    // The QR never goes on the document's own pages: it gets a page of its own, after them.
    const qrPage = `<section class="qr-page">
      <div class="qr-sheet">
        <p class="qr-eyebrow">FlowVision · Document QR</p>
        <div class="qr-big">${qr.svg}</div>
        <p class="qr-code">${esc(qr.payload)}</p>
        <p class="qr-title">${esc(doc.title)}</p>
        <p class="qr-note">Keep this page with the document. Messengers scan it to pick the document up, and each office scans it to receive it.</p>
      </div>
    </section>`
    const qrPageCss = `
      .qr-page { break-before: page; height: 100vh; display: flex; align-items: flex-start; justify-content: center; padding-top: 30mm; box-sizing: border-box; font-family: system-ui, sans-serif; color: #1B1B1B; }
      .qr-sheet { text-align: center; max-width: 120mm; }
      .qr-eyebrow { font-size: 3mm; letter-spacing: 0.08em; text-transform: uppercase; color: #5F5B54; margin: 0 0 6mm; }
      .qr-big svg { width: 60mm; height: 60mm; display: block; margin: 0 auto; }
      .qr-code { font: 700 5mm ui-monospace, monospace; letter-spacing: 0.03em; margin: 5mm 0 2mm; }
      .qr-title { font-size: 4mm; margin: 0 0 6mm; }
      .qr-note { font-size: 3mm; color: #5F5B54; line-height: 1.5; margin: 0; }`
    // One job for everything: picture pages fill the sheet, Word files get page margins.
    const css = `
      @page { size: auto; margin: 0; }
      body { margin: 0; font-family: system-ui, sans-serif; }
      .page { height: 100vh; display: flex; align-items: flex-start; justify-content: center; break-after: page; overflow: hidden; }
      .page img { max-width: 100%; max-height: 100%; object-fit: contain; }
      .docx { padding: 16mm; break-after: page; font-family: 'Times New Roman', serif; font-size: 12pt; line-height: 1.4; color: #111; }
      .docx img { max-width: 100%; } .docx table { border-collapse: collapse; } .docx td, .docx th { border: 1px solid #999; padding: 2pt 4pt; }
      ${qrPageCss}
      .qr-page { break-before: auto; }`

    const PRINTABLE = new Set(['pdf', 'png', 'jpg', 'jpeg', 'webp', 'docx'])
    const sections: string[] = []
    const skipped: string[] = []
    let truncated = false
    for (const f of list) {
      const ext = (f.name.split('.').pop() ?? '').toLowerCase()
      if (!PRINTABLE.has(ext)) {
        skipped.push(f.name)
        continue
      }
      try {
        if (ext === 'docx') {
          const { html } = await api.get<{ html: string }>(`/documents/${doc.id}/printable`, f.id === 'main' ? undefined : { file: f.id })
          sections.push(`<article class="docx">${html}</article>`)
        } else if (ext === 'pdf') {
          const rendered = await renderPdfPages(f.url)
          truncated ||= rendered.truncated
          sections.push(rendered.pages.map((src) => `<div class="page"><img src="${src}" alt=""></div>`).join(''))
        } else {
          sections.push(`<div class="page"><img src="${f.url}" alt=""></div>`)
        }
      } catch (err) {
        console.warn('[print] could not prepare', f.name, err)
        skipped.push(f.name)
      }
    }

    if (skipped.length) {
      ui.info(
        sections.length ? `${skipped.length} file${skipped.length === 1 ? '' : 's'} not printed` : 'Printing the QR page only',
        `${skipped.join(', ')} can't be printed from the browser. Open ${skipped.length === 1 ? 'it' : 'them'} in its own app to print.`,
      )
    }
    if (truncated) ui.info('Long PDF', `Only the first ${MAX_PDF_PAGES} pages of each PDF are printed.`)
    // The QR never goes on the document's own pages: it gets a page of its own, after them.
    return printHtml(qr.payload, css, sections.join('') + qrPage)
  }

  return {
    looksValid: (code: string) => QR_PATTERN.test(code.trim()),
    verify: (code: string) => api.post<ScanPreview>('/qr/verify', { payload: code.trim().toUpperCase() }),
    scan: (code: string, action: ScanAction) => api.post<{ action: ScanAction; document: FlowDocument }>('/qr/scan', { payload: code.trim().toUpperCase(), action }),
    regenerate: (documentId: string) => api.post<{ qr: QrInfo }>(`/qr/generate/${documentId}`),
    printLabel,
    printWithDocument,
  }
}
