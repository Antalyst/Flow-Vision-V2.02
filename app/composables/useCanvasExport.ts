import type { CanvasDoc, MdBlock } from '~/utils/markdown'
import type { LoadedImage } from '~/utils/print'
import type { DocumentTemplateItem } from '~/types'

export type ExportFormat = 'docx' | 'xlsx' | 'pdf'

/** How a canvas is laid out: its template (letterhead) and the organization it belongs to. */
export interface ExportLayout {
  template: DocumentTemplateItem | null
  orgName: string
  logoUrl: string | null
}

/** The layout with its images loaded. */
interface Brand {
  template: DocumentTemplateItem | null
  orgName: string
  logo: LoadedImage | null
  signature: LoadedImage | null
}

/** The letterhead lines: the template's, or just the organization name. */
const headerLines = (b: Brand) => {
  const lines = (b.template?.header_text ?? '').split(/\r?\n/).map((l) => l.trim()).filter(Boolean)
  return lines.length ? lines : [b.orgName]
}
const hasSignatureBlock = (b: Brand) => Boolean(b.template && (b.template.signatory_name || b.template.signatory_title || b.signature))

const INK = '111113'
const MUTED = '6B6B70'
const ZEBRA = 'F6F5F1'
const RULE = 'E6E4DE'

const stampFmt = new Intl.DateTimeFormat('en-US', { month: 'short', day: 'numeric', year: 'numeric', hour: 'numeric', minute: '2-digit', timeZone: TIME_ZONE })

function fileName(title: string, ext: ExportFormat) {
  const base = title.replace(/[^\w\s.-]+/g, ' ').trim().replace(/\s+/g, '-').slice(0, 80) || 'flowvision-canvas'
  return `${base}.${ext}`
}

function download(blob: Blob, name: string) {
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = name
  document.body.appendChild(a)
  a.click()
  a.remove()
  setTimeout(() => URL.revokeObjectURL(url), 2000)
}

/** Tables with the heading written just above each one (used for sheet names). */
function tablesOf(blocks: MdBlock[]) {
  const out: Array<{ name: string | null; header: string[]; rows: string[][] }> = []
  let heading: string | null = null
  for (const b of blocks) {
    if (b.type === 'heading') heading = plainInline(b.text)
    else if (b.type === 'table') {
      out.push({ name: heading, header: b.header.map(plainInline), rows: b.rows.map((r) => r.map(plainInline)) })
      heading = null
    }
  }
  return out
}

const isWide = (blocks: MdBlock[]) => blocks.some((b) => b.type === 'table' && b.header.length > 6)

// ---------------------------------------------------------------------------
// Word (.docx)
// ---------------------------------------------------------------------------

async function toDocx(canvas: CanvasDoc, blocks: MdBlock[], meta: string, brand: Brand) {
  const d = await import('docx')
  const { AlignmentType, BorderStyle, Document, Footer, HeadingLevel, ImageRun, LevelFormat, Packer, PageOrientation, Paragraph, ShadingType, Table, TableCell, TableRow, TextRun, WidthType } = d

  const runs = (text: string, opts: { size?: number; bold?: boolean; color?: string } = {}) =>
    parseInline(text).map(
      (r) => new TextRun({ text: r.text, bold: r.bold || opts.bold, italics: r.italic, font: r.code ? 'Consolas' : undefined, size: opts.size, color: opts.color }),
    )
  const border = { style: BorderStyle.SINGLE, size: 4, color: RULE }
  const cellBorders = { top: border, bottom: border, left: border, right: border }
  const headings = [HeadingLevel.HEADING_1, HeadingLevel.HEADING_2, HeadingLevel.HEADING_3]

  const image = (img: LoadedImage, maxWidth: number, maxHeight: number) => new ImageRun({ type: img.type, data: img.bytes, transformation: fitImage(img, maxWidth, maxHeight) })
  const children: Array<InstanceType<typeof Paragraph> | InstanceType<typeof Table>> = []
  if (brand.template) {
    // Letterhead: logo, header lines (the last one stands out), a double rule.
    if (brand.logo) children.push(new Paragraph({ alignment: AlignmentType.CENTER, spacing: { after: 80 }, children: [image(brand.logo, 160, 72)] }))
    const lines = headerLines(brand)
    lines.forEach((line, i) => {
      const last = i === lines.length - 1
      children.push(new Paragraph({ alignment: AlignmentType.CENTER, children: [new TextRun({ text: last ? line.toUpperCase() : line, bold: last, size: last ? 26 : 21, color: last ? INK : '3B3B40' })] }))
    })
    children.push(new Paragraph({ border: { bottom: { style: BorderStyle.DOUBLE, size: 6, color: INK } }, spacing: { after: 280 }, children: [] }))
  } else {
    children.push(
      new Paragraph({ heading: HeadingLevel.TITLE, children: [new TextRun({ text: canvas.title })] }),
      new Paragraph({ spacing: { after: 280 }, children: [new TextRun({ text: meta, color: MUTED, size: 18 })] }),
    )
  }
  let listInstance = 0

  for (const b of blocks) {
    switch (b.type) {
      case 'heading':
        children.push(new Paragraph({ heading: headings[Math.min(b.level, 3) - 1], spacing: { before: 240, after: 120 }, children: runs(b.text) }))
        break
      case 'paragraph':
        children.push(new Paragraph({ spacing: { after: 140 }, children: runs(b.text) }))
        break
      case 'list':
        listInstance++
        for (const item of b.items) {
          children.push(
            new Paragraph({
              spacing: { after: 60 },
              children: runs(item),
              ...(b.ordered ? { numbering: { reference: 'fv-numbered', level: 0, instance: listInstance } } : { bullet: { level: 0 } }),
            }),
          )
        }
        break
      case 'table':
        children.push(
          new Table({
            width: { size: 100, type: WidthType.PERCENTAGE },
            rows: [
              new TableRow({
                tableHeader: true,
                children: b.header.map(
                  (h) =>
                    new TableCell({
                      borders: cellBorders,
                      shading: { type: ShadingType.CLEAR, fill: INK, color: 'auto' },
                      margins: { top: 80, bottom: 80, left: 100, right: 100 },
                      children: [new Paragraph({ children: [new TextRun({ text: plainInline(h), bold: true, color: 'FFFFFF', size: 18 })] })],
                    }),
                ),
              }),
              ...b.rows.map(
                (row, i) =>
                  new TableRow({
                    children: row.map(
                      (cell) =>
                        new TableCell({
                          borders: cellBorders,
                          margins: { top: 60, bottom: 60, left: 100, right: 100 },
                          ...(i % 2 === 1 && { shading: { type: ShadingType.CLEAR, fill: ZEBRA, color: 'auto' } }),
                          children: [new Paragraph({ children: runs(cell, { size: 18 }) })],
                        }),
                    ),
                  }),
              ),
            ],
          }),
          new Paragraph({ spacing: { after: 160 }, children: [] }),
        )
        break
      case 'code':
        for (const line of b.text.split('\n')) children.push(new Paragraph({ children: [new TextRun({ text: line || ' ', font: 'Consolas', size: 18 })] }))
        break
      case 'quote':
        children.push(new Paragraph({ indent: { left: 480 }, spacing: { after: 140 }, children: parseInline(b.text).map((r) => new TextRun({ text: r.text, italics: true, bold: r.bold, color: MUTED })) }))
        break
      case 'hr':
        children.push(new Paragraph({ border: { bottom: border }, spacing: { after: 160 }, children: [] }))
        break
    }
  }

  // Signature block, on the right.
  if (brand.template && hasSignatureBlock(brand)) {
    const t = brand.template
    children.push(new Paragraph({ spacing: { before: 600 }, children: [] }))
    if (brand.signature) children.push(new Paragraph({ alignment: AlignmentType.RIGHT, children: [image(brand.signature, 180, 64)] }))
    if (t.signatory_name) {
      children.push(new Paragraph({ alignment: AlignmentType.RIGHT, border: { top: { style: BorderStyle.SINGLE, size: 6, color: INK } }, children: [new TextRun({ text: t.signatory_name.toUpperCase(), bold: true })] }))
    }
    if (t.signatory_title) children.push(new Paragraph({ alignment: AlignmentType.RIGHT, children: [new TextRun({ text: t.signatory_title, size: 20, color: '3B3B40' })] }))
  }
  // Every page ends with the template's footer and the FlowVision note.
  const footer = new Footer({
    children: [
      ...(brand.template?.footer_text ? [new Paragraph({ alignment: AlignmentType.CENTER, children: [new TextRun({ text: brand.template.footer_text, size: 16, color: MUTED })] })] : []),
      new Paragraph({ alignment: AlignmentType.CENTER, children: [new TextRun({ text: FLOWVISION_NOTE, italics: true, size: 16, color: MUTED })] }),
    ],
  })

  const doc = new Document({
    creator: 'FlowVision Assistant',
    title: canvas.title,
    styles: { default: { document: { run: { font: 'Calibri', size: 21, color: '1E1E22' } } } },
    numbering: {
      config: [
        {
          reference: 'fv-numbered',
          levels: [{ level: 0, format: LevelFormat.DECIMAL, text: '%1.', alignment: AlignmentType.START, style: { paragraph: { indent: { left: 720, hanging: 360 } } } }],
        },
      ],
    },
    sections: [{ properties: { page: { size: { orientation: isWide(blocks) ? PageOrientation.LANDSCAPE : PageOrientation.PORTRAIT } } }, footers: { default: footer }, children }],
  })
  download(await Packer.toBlob(doc), fileName(canvas.title, 'docx'))
}

// ---------------------------------------------------------------------------
// Excel (.xlsx)
// ---------------------------------------------------------------------------

const NUMBER = /^-?\d{1,15}(\.\d+)?$/
const cellValue = (v: string) => (NUMBER.test(v) && !/^-?0\d/.test(v) ? Number(v) : v)

async function toXlsx(canvas: CanvasDoc, blocks: MdBlock[], meta: string, brand: Brand) {
  const mod = await import('exceljs')
  const ExcelJS = ((mod as { default?: unknown }).default ?? mod) as typeof import('exceljs')
  const wb = new ExcelJS.Workbook()
  wb.creator = 'FlowVision Assistant'
  wb.created = new Date()

  const used = new Set<string>()
  const sheetName = (raw: string) => {
    const base = raw.replace(/[[\]:*?/\\]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 28) || 'Sheet'
    let name = base
    for (let n = 2; used.has(name.toLowerCase()); n++) name = `${base.slice(0, 26)} ${n}`
    used.add(name.toLowerCase())
    return name
  }
  const thin = { style: 'thin' as const, color: { argb: `FF${RULE}` } }

  // The template's letterhead lines head each sheet; the FlowVision note ends it.
  const letterhead = (ws: import('exceljs').Worksheet) => {
    if (!brand.template) return
    const lines = headerLines(brand)
    lines.forEach((line, i) => (ws.addRow([line]).font = { bold: i === lines.length - 1, size: i === lines.length - 1 ? 12 : 10, color: { argb: `FF${INK}` } }))
    ws.addRow([])
  }
  const signOff = (ws: import('exceljs').Worksheet) => {
    ws.addRow([])
    if (brand.template?.signatory_name) ws.addRow([brand.template.signatory_name.toUpperCase()]).font = { bold: true }
    if (brand.template?.signatory_title) ws.addRow([brand.template.signatory_title])
    if (brand.template?.footer_text) ws.addRow([brand.template.footer_text]).font = { size: 9, color: { argb: `FF${MUTED}` } }
    ws.addRow([FLOWVISION_NOTE]).font = { italic: true, size: 9, color: { argb: `FF${MUTED}` } }
  }

  const tables = tablesOf(blocks)
  tables.forEach((t, ti) => {
    const ws = wb.addWorksheet(sheetName(t.name ?? (tables.length === 1 ? canvas.title : `Table ${ti + 1}`)))
    letterhead(ws)
    ws.addRow([t.name && tables.length > 1 ? `${canvas.title} — ${t.name}` : canvas.title]).font = { bold: true, size: 14, color: { argb: `FF${INK}` } }
    ws.addRow([meta]).font = { italic: true, size: 9, color: { argb: `FF${MUTED}` } }
    ws.addRow([])

    const header = ws.addRow(t.header)
    header.height = 22
    header.eachCell((c) => {
      c.font = { bold: true, color: { argb: 'FFFFFFFF' } }
      c.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: `FF${INK}` } }
      c.alignment = { vertical: 'middle', wrapText: true }
      c.border = { top: thin, bottom: thin, left: thin, right: thin }
    })
    t.rows.forEach((r, i) => {
      const row = ws.addRow(r.map(cellValue))
      row.eachCell({ includeEmpty: true }, (c) => {
        c.alignment = { vertical: 'top', wrapText: true }
        c.border = { top: thin, bottom: thin, left: thin, right: thin }
        if (i % 2 === 1) c.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: `FF${ZEBRA}` } }
      })
    })

    const headerRow = header.number
    ws.views = [{ state: 'frozen', ySplit: headerRow }]
    ws.autoFilter = { from: { row: headerRow, column: 1 }, to: { row: headerRow, column: t.header.length } }
    t.header.forEach((h, c) => {
      const longest = Math.max(h.length, ...t.rows.map((r) => (r[c] ?? '').length))
      ws.getColumn(c + 1).width = Math.min(60, Math.max(10, longest + 2))
    })
    signOff(ws)
  })

  // Prose (or a canvas without tables): one readable sheet of its text.
  if (!tables.length) {
    const ws = wb.addWorksheet(sheetName(canvas.title))
    ws.getColumn(1).width = 110
    letterhead(ws)
    ws.addRow([canvas.title]).font = { bold: true, size: 14 }
    ws.addRow([meta]).font = { italic: true, size: 9, color: { argb: `FF${MUTED}` } }
    ws.addRow([])
    for (const b of blocks) {
      if (b.type === 'heading') ws.addRow([plainInline(b.text)]).font = { bold: true, size: 12 }
      else if (b.type === 'paragraph' || b.type === 'quote') ws.addRow([plainInline(b.text)])
      else if (b.type === 'list') b.items.forEach((it, i) => ws.addRow([`${b.ordered ? `${i + 1}.` : '•'} ${plainInline(it)}`]))
      else if (b.type === 'code') b.text.split('\n').forEach((l) => ws.addRow([l]))
      else continue
      ws.lastRow!.alignment = { wrapText: true, vertical: 'top' }
    }
    signOff(ws)
  }

  const buffer = await wb.xlsx.writeBuffer()
  download(new Blob([buffer], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' }), fileName(canvas.title, 'xlsx'))
}

// ---------------------------------------------------------------------------
// PDF
// ---------------------------------------------------------------------------

/** The built-in PDF fonts cover Latin-1 only: map common typography to safe equivalents. */
const pdfText = (s: string) =>
  s
    .replace(/[‘’]/g, "'")
    .replace(/[“”]/g, '"')
    .replace(/[–—]/g, '-')
    .replace(/…/g, '...')
    .replace(/→/g, '->')
    .replace(/₱/g, 'PHP ')
    .replace(/[•·]/g, '-')
    .replace(/★/g, '*')
    .replace(/[^\x09\x0A\x0D\x20-\x7E\xA0-\xFF]/g, '')

const rgb = (hex: string): [number, number, number] => [parseInt(hex.slice(0, 2), 16), parseInt(hex.slice(2, 4), 16), parseInt(hex.slice(4, 6), 16)]

async function toPdf(canvas: CanvasDoc, blocks: MdBlock[], meta: string, brand: Brand) {
  const [{ jsPDF }, { autoTable }] = await Promise.all([import('jspdf'), import('jspdf-autotable')])
  const doc = new jsPDF({ orientation: isWide(blocks) ? 'landscape' : 'portrait', unit: 'pt', format: 'a4' })
  const W = doc.internal.pageSize.getWidth()
  const H = doc.internal.pageSize.getHeight()
  const M = 48
  const width = W - M * 2
  let y = M

  const ensure = (h: number) => {
    if (y + h > H - M) {
      doc.addPage()
      y = M
    }
  }
  const write = (text: string, opts: { size: number; bold?: boolean; italic?: boolean; mono?: boolean; color?: string; indent?: number; gap?: number }) => {
    doc.setFont(opts.mono ? 'courier' : 'helvetica', opts.bold ? (opts.italic ? 'bolditalic' : 'bold') : opts.italic ? 'italic' : 'normal')
    doc.setFontSize(opts.size)
    doc.setTextColor(...rgb(opts.color ?? '1E1E22'))
    const lineH = opts.size * 1.35
    for (const line of doc.splitTextToSize(pdfText(text), width - (opts.indent ?? 0)) as string[]) {
      ensure(lineH)
      doc.text(line, M + (opts.indent ?? 0), y + opts.size)
      y += lineH
    }
    y += opts.gap ?? 0
  }

  const centered = (text: string, size: number, bold: boolean, color: string) => {
    doc.setFont('helvetica', bold ? 'bold' : 'normal')
    doc.setFontSize(size)
    doc.setTextColor(...rgb(color))
    for (const line of doc.splitTextToSize(pdfText(text), width) as string[]) {
      doc.text(line, W / 2, y + size, { align: 'center' })
      y += size * 1.3
    }
  }
  if (brand.template) {
    // Letterhead: logo, header lines (the last one stands out), a double rule.
    if (brand.logo) {
      const { width: w, height: h } = fitImage(brand.logo, 140, 60)
      doc.addImage(brand.logo.dataUrl, brand.logo.type === 'png' ? 'PNG' : 'JPEG', (W - w) / 2, y, w, h)
      y += h + 6
    }
    const lines = headerLines(brand)
    lines.forEach((line, i) => (i === lines.length - 1 ? centered(line.toUpperCase(), 12.5, true, INK) : centered(line, 10, false, '3B3B40')))
    y += 6
    doc.setDrawColor(...rgb(INK))
    doc.setLineWidth(1.4)
    doc.line(M, y, W - M, y)
    doc.setLineWidth(0.5)
    doc.line(M, y + 3, W - M, y + 3)
    y += 20
  } else {
    write(canvas.title, { size: 18, bold: true, color: INK, gap: 2 })
    write(meta, { size: 9, color: MUTED, gap: 8 })
    doc.setDrawColor(...rgb(RULE))
    doc.line(M, y, W - M, y)
    y += 14
  }

  for (const b of blocks) {
    switch (b.type) {
      case 'heading':
        y += 6
        write(plainInline(b.text), { size: b.level <= 1 ? 15 : b.level === 2 ? 13 : 11.5, bold: true, color: INK, gap: 4 })
        break
      case 'paragraph':
        write(plainInline(b.text), { size: 10.5, gap: 6 })
        break
      case 'quote':
        write(plainInline(b.text), { size: 10.5, italic: true, color: MUTED, indent: 14, gap: 6 })
        break
      case 'code':
        write(b.text, { size: 9, mono: true, gap: 6 })
        break
      case 'list':
        b.items.forEach((item, i) => {
          ensure(14)
          doc.setFont('helvetica', 'normal')
          doc.setFontSize(10.5)
          doc.setTextColor(...rgb('1E1E22'))
          if (b.ordered) doc.text(`${i + 1}.`, M + 2, y + 10.5)
          else {
            doc.setFillColor(...rgb(INK))
            doc.circle(M + 5, y + 7, 1.6, 'F')
          }
          write(plainInline(item), { size: 10.5, indent: 16, gap: 2 })
        })
        y += 4
        break
      case 'table':
        autoTable(doc, {
          startY: y,
          head: [b.header.map((h) => pdfText(plainInline(h)))],
          body: b.rows.map((r) => r.map((c) => pdfText(plainInline(c)))),
          margin: { left: M, right: M, top: M, bottom: M },
          theme: 'grid',
          styles: { font: 'helvetica', fontSize: 8.5, cellPadding: 5, overflow: 'linebreak', lineColor: rgb(RULE), lineWidth: 0.5, textColor: rgb('1E1E22') },
          headStyles: { fillColor: rgb(INK), textColor: [255, 255, 255], fontStyle: 'bold' },
          alternateRowStyles: { fillColor: rgb(ZEBRA) },
        })
        y = (doc as unknown as { lastAutoTable: { finalY: number } }).lastAutoTable.finalY + 16
        break
      case 'hr':
        ensure(12)
        doc.setDrawColor(...rgb(RULE))
        doc.line(M, y + 4, W - M, y + 4)
        y += 12
        break
    }
  }

  // Signature block, on the right.
  if (brand.template && hasSignatureBlock(brand)) {
    const t = brand.template
    const blockW = 200
    const x = W - M - blockW
    ensure(110)
    y += 36
    if (brand.signature) {
      const { width: w, height: h } = fitImage(brand.signature, 180, 56)
      doc.addImage(brand.signature.dataUrl, brand.signature.type === 'png' ? 'PNG' : 'JPEG', x + (blockW - w) / 2, y, w, h)
      y += h - 4
    }
    doc.setDrawColor(...rgb(INK))
    doc.setLineWidth(0.8)
    doc.line(x, y, x + blockW, y)
    y += 2
    doc.setTextColor(...rgb(INK))
    if (t.signatory_name) {
      doc.setFont('helvetica', 'bold')
      doc.setFontSize(10.5)
      doc.text(pdfText(t.signatory_name.toUpperCase()), x + blockW / 2, y + 11, { align: 'center' })
      y += 14
    }
    if (t.signatory_title) {
      doc.setFont('helvetica', 'normal')
      doc.setFontSize(9.5)
      doc.setTextColor(...rgb('3B3B40'))
      doc.text(pdfText(t.signatory_title), x + blockW / 2, y + 10, { align: 'center' })
      y += 13
    }
  }

  // Every page: the template's footer, the FlowVision note and the page number.
  const pages = doc.getNumberOfPages()
  for (let p = 1; p <= pages; p++) {
    doc.setPage(p)
    doc.setFont('helvetica', 'normal')
    doc.setFontSize(8)
    doc.setTextColor(...rgb(MUTED))
    if (brand.template?.footer_text) doc.text(pdfText(brand.template.footer_text).slice(0, 140), W / 2, H - 36, { align: 'center' })
    doc.setFont('helvetica', 'italic')
    doc.text(pdfText(FLOWVISION_NOTE), M, H - 24)
    doc.setFont('helvetica', 'normal')
    doc.text(`Page ${p} of ${pages}`, W - M, H - 24, { align: 'right' })
  }
  doc.save(fileName(canvas.title, 'pdf'))
}

/**
 * Canvas exports, built in the browser as real Office/PDF files — Word through `docx`, Excel
 * through `exceljs` (one sheet per table, typed numbers, frozen header and filters), PDF through
 * `jspdf` + `jspdf-autotable`. The libraries load only when an export is first used. A canvas on a
 * template gets its letterhead, signature block and footer; every export notes it was created with FlowVision.
 */
export function useCanvasExport() {
  const auth = useAuthStore()
  const busy = ref<ExportFormat | null>(null)

  /** `layout`: the canvas's template (letterhead), laid out the same way as its preview and print. */
  async function exportCanvas(canvas: CanvasDoc, format: ExportFormat, layout?: ExportLayout) {
    if (busy.value) return
    busy.value = format
    try {
      const blocks = parseMarkdown(canvas.content)
      const orgName = layout?.orgName || auth.user?.organization?.name || 'FlowVision'
      const meta = `${orgName} · Prepared with FlowVision Assistant · ${stampFmt.format(new Date())}`
      const template = layout?.template ?? null
      const [logo, signature] = await Promise.all([loadImage(template?.show_logo ? layout?.logoUrl : null), loadImage(template?.signature_url)])
      const brand: Brand = { template, orgName, logo, signature }
      if (format === 'docx') await toDocx(canvas, blocks, meta, brand)
      else if (format === 'xlsx') await toXlsx(canvas, blocks, meta, brand)
      else await toPdf(canvas, blocks, meta, brand)
    } finally {
      busy.value = null
    }
  }

  return { busy, exportCanvas }
}
