/**
 * A small Markdown reader for the assistant's answers. One parse feeds both the chat/canvas HTML
 * and the Word/Excel/PDF exporters. Everything is HTML-escaped: the model's text (and any data it
 * quotes) can never inject markup. Supports headings, paragraphs, bullet/numbered lists, tables,
 * code blocks, quotes, rules, **bold**, *italic* and `code`.
 */

export type MdBlock =
  | { type: 'heading'; level: number; text: string }
  | { type: 'paragraph'; text: string }
  | { type: 'list'; ordered: boolean; items: string[] }
  | { type: 'table'; header: string[]; rows: string[][] }
  | { type: 'code'; text: string }
  | { type: 'quote'; text: string }
  | { type: 'hr' }

export interface MdRun {
  text: string
  bold?: boolean
  italic?: boolean
  code?: boolean
}

export interface CanvasDoc {
  id: string
  type: 'table' | 'document'
  title: string
  content: string
}

export type MessageSegment = { kind: 'text'; text: string } | { kind: 'canvas'; canvas: CanvasDoc }

const HEADING = /^(#{1,6})\s+(.*?)\s*#*\s*$/
const HR = /^\s*([-*_])(\s*\1){2,}\s*$/
const LIST_ITEM = /^(\s*)([-*+]|\d+[.)])\s+(.*)$/
const TABLE_SEP = /^\s*\|?\s*:?-{2,}:?\s*(\|\s*:?-{2,}:?\s*)*\|?\s*$/
const FENCE = /^\s*```/

function splitCells(line: string) {
  let s = line.trim()
  if (s.startsWith('|')) s = s.slice(1)
  if (s.endsWith('|') && !s.endsWith('\\|')) s = s.slice(0, -1)
  return s.split(/(?<!\\)\|/).map((c) => c.trim().replace(/\\\|/g, '|'))
}

const isTableStart = (lines: string[], i: number) => lines[i]!.includes('|') && i + 1 < lines.length && TABLE_SEP.test(lines[i + 1]!)

export function parseMarkdown(md: string): MdBlock[] {
  const lines = md.replace(/\r\n?/g, '\n').split('\n')
  const blocks: MdBlock[] = []
  let i = 0

  while (i < lines.length) {
    const line = lines[i]!
    if (!line.trim()) {
      i++
      continue
    }

    if (FENCE.test(line)) {
      const body: string[] = []
      i++
      while (i < lines.length && !FENCE.test(lines[i]!)) body.push(lines[i++]!)
      i++
      blocks.push({ type: 'code', text: body.join('\n') })
      continue
    }

    const h = HEADING.exec(line)
    if (h) {
      blocks.push({ type: 'heading', level: h[1]!.length, text: h[2]! })
      i++
      continue
    }

    if (HR.test(line)) {
      blocks.push({ type: 'hr' })
      i++
      continue
    }

    if (isTableStart(lines, i)) {
      const header = splitCells(line)
      const rows: string[][] = []
      i += 2
      while (i < lines.length && lines[i]!.trim() && lines[i]!.includes('|')) {
        const cells = splitCells(lines[i++]!)
        rows.push(header.map((_, c) => cells[c] ?? ''))
      }
      blocks.push({ type: 'table', header, rows })
      continue
    }

    const li = LIST_ITEM.exec(line)
    if (li) {
      const ordered = /\d/.test(li[2]!)
      const items: string[] = []
      while (i < lines.length) {
        const m = LIST_ITEM.exec(lines[i]!)
        if (m) {
          items.push(m[3]!)
          i++
        } else if (lines[i]!.trim() && /^\s{2,}/.test(lines[i]!) && items.length) {
          items[items.length - 1] += ` ${lines[i++]!.trim()}`
        } else break
      }
      blocks.push({ type: 'list', ordered, items })
      continue
    }

    if (/^\s*>/.test(line)) {
      const body: string[] = []
      while (i < lines.length && /^\s*>/.test(lines[i]!)) body.push(lines[i++]!.replace(/^\s*>\s?/, ''))
      blocks.push({ type: 'quote', text: body.join(' ') })
      continue
    }

    const body: string[] = []
    while (i < lines.length) {
      const l = lines[i]!
      if (!l.trim() || FENCE.test(l) || HEADING.test(l) || HR.test(l) || LIST_ITEM.test(l) || /^\s*>/.test(l) || isTableStart(lines, i)) break
      body.push(l.trim())
      i++
    }
    blocks.push({ type: 'paragraph', text: body.join(' ') })
  }
  return blocks
}

const INLINE = /(`[^`\n]+`)|(\*\*[^*\n]+\*\*)|(__[^_\n]+__)|(\*[^*\s\n][^*\n]*\*)|((?<![\w])_[^_\s\n][^_\n]*_(?![\w]))/g

/** Inline formatting as runs. Links keep their text only — no URLs from the model become clickable. */
export function parseInline(text: string): MdRun[] {
  const src = text.replace(/\[([^\]]+)\]\(([^)\s]+)\)/g, '$1').replace(/<br\s*\/?>/gi, ' ')
  const runs: MdRun[] = []
  let last = 0
  for (const m of src.matchAll(INLINE)) {
    if (m.index! > last) runs.push({ text: src.slice(last, m.index) })
    const t = m[0]
    if (m[1]) runs.push({ text: t.slice(1, -1), code: true })
    else if (m[2] || m[3]) runs.push({ text: t.slice(2, -2), bold: true })
    else runs.push({ text: t.slice(1, -1), italic: true })
    last = m.index! + t.length
  }
  if (last < src.length) runs.push({ text: src.slice(last) })
  return runs.filter((r) => r.text)
}

export const plainInline = (text: string) =>
  parseInline(text)
    .map((r) => r.text)
    .join('')

const escapeHtml = (s: string) => s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!)

function inlineHtml(text: string) {
  return parseInline(text)
    .map((r) => {
      const t = escapeHtml(r.text)
      if (r.code) return `<code>${t}</code>`
      if (r.bold) return `<strong>${t}</strong>`
      if (r.italic) return `<em>${t}</em>`
      return t
    })
    .join('')
}

export function renderMarkdown(md: string) {
  return parseMarkdown(md)
    .map((b) => {
      switch (b.type) {
        case 'heading': {
          const level = Math.min(Math.max(b.level, 2), 4)
          return `<h${level}>${inlineHtml(b.text)}</h${level}>`
        }
        case 'paragraph':
          return `<p>${inlineHtml(b.text)}</p>`
        case 'list': {
          const tag = b.ordered ? 'ol' : 'ul'
          return `<${tag}>${b.items.map((it) => `<li>${inlineHtml(it)}</li>`).join('')}</${tag}>`
        }
        case 'table':
          return (
            '<div class="fv-table-wrap"><table>' +
            `<thead><tr>${b.header.map((h) => `<th>${inlineHtml(h)}</th>`).join('')}</tr></thead>` +
            `<tbody>${b.rows.map((r) => `<tr>${r.map((c) => `<td>${inlineHtml(c)}</td>`).join('')}</tr>`).join('')}</tbody>` +
            '</table></div>'
          )
        case 'code':
          return `<pre><code>${escapeHtml(b.text)}</code></pre>`
        case 'quote':
          return `<blockquote>${inlineHtml(b.text)}</blockquote>`
        case 'hr':
          return '<hr>'
      }
    })
    .join('')
}

const CANVAS = /<canvas\b([^>]*)>([\s\S]*?)(?:<\/canvas>|$)/gi
const attr = (attrs: string, name: string) => new RegExp(`${name}\\s*=\\s*(?:"([^"]*)"|'([^']*)')`, 'i').exec(attrs)?.slice(1).find((v) => v != null)

/** An answer as text and canvas parts. `idPrefix` makes each canvas id stable across renders. */
export function splitCanvas(content: string, idPrefix: string): MessageSegment[] {
  const segments: MessageSegment[] = []
  let last = 0
  let n = 0
  for (const m of content.matchAll(CANVAS)) {
    const before = content.slice(last, m.index)
    if (before.trim()) segments.push({ kind: 'text', text: before.trim() })
    let body = m[2]!.trim()
    // Some answers wrap the canvas body in a ```markdown fence.
    const fenced = /^```[\w-]*\n([\s\S]*?)\n?```$/.exec(body)
    if (fenced) body = fenced[1]!.trim()
    const declared = attr(m[1]!, 'type')
    const type = declared === 'document' || declared === 'table' ? declared : parseMarkdown(body).some((b) => b.type === 'table') ? 'table' : 'document'
    segments.push({ kind: 'canvas', canvas: { id: `${idPrefix}:${n++}`, type, title: attr(m[1]!, 'title')?.trim() || 'Untitled canvas', content: body } })
    last = m.index! + m[0].length
  }
  const rest = content.slice(last)
  if (rest.trim()) segments.push({ kind: 'text', text: rest.trim() })
  return segments
}
