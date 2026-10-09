import type { DocumentTemplateItem } from '~/types'

/**
 * A document drafted by the AI, laid out like the paper it will be printed on: the template's
 * letterhead (organization logo and header lines), the body, the signature block and the footer —
 * and always the note that it was created with FlowVision. One HTML builder feeds the canvas
 * preview, the template preview in Organization Settings and printing, so all three match.
 * Everything is escaped; the body is HTML from renderMarkdown (already escaped).
 */

export const FLOWVISION_NOTE = 'This document was created with FlowVision.'

export type SheetTemplate = Pick<DocumentTemplateItem, 'name' | 'show_logo' | 'header_text' | 'signatory_name' | 'signatory_title' | 'signature_url' | 'footer_text'>

export interface SheetInput {
  title: string
  /** HTML of the body (from renderMarkdown). */
  bodyHtml: string
  template: SheetTemplate | null
  orgName: string
  /** Image sources (URLs or data URLs); null = none. */
  logoSrc: string | null
  signatureSrc: string | null
}

const lines = (text: string | null | undefined) =>
  (text ?? '')
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean)

export function sheetHtml({ title, bodyHtml, template, orgName, logoSrc, signatureSrc }: SheetInput) {
  const parts: string[] = ['<div class="fvs">']
  if (template) {
    const header = lines(template.header_text)
    const headLines = header.length ? header : [orgName]
    parts.push('<header class="fvs-head">')
    if (template.show_logo && logoSrc) parts.push(`<img class="fvs-logo" src="${escapeHtml(logoSrc)}" alt="">`)
    // The last line is the most specific (the office or organization): it stands out.
    parts.push(`<div class="fvs-lines">${headLines.map((l, i) => `<p${i === headLines.length - 1 ? ' class="fvs-strong"' : ''}>${escapeHtml(l)}</p>`).join('')}</div>`)
    parts.push('</header><div class="fvs-rule"></div>')
  } else {
    // No template: the canvas title heads the page.
    parts.push(`<h1 class="fvs-title">${escapeHtml(title)}</h1>`)
  }
  parts.push(`<article class="fvs-body">${bodyHtml}</article>`)
  if (template && (template.signatory_name || template.signatory_title || (template.signature_url && signatureSrc))) {
    parts.push('<section class="fvs-sign">')
    if (signatureSrc) parts.push(`<img class="fvs-signature" src="${escapeHtml(signatureSrc)}" alt="">`)
    if (template.signatory_name) parts.push(`<p class="fvs-sign-name">${escapeHtml(template.signatory_name)}</p>`)
    if (template.signatory_title) parts.push(`<p class="fvs-sign-title">${escapeHtml(template.signatory_title)}</p>`)
    parts.push('</section>')
  }
  parts.push('<footer class="fvs-foot">')
  if (template?.footer_text) parts.push(`<p>${escapeHtml(template.footer_text)}</p>`)
  parts.push(`<p class="fvs-note">${escapeHtml(FLOWVISION_NOTE)}</p>`)
  parts.push('</footer></div>')
  return parts.join('')
}

/** Styles of the sheet, scoped to .fvs: used on screen (useHead) and in the print frame. */
export const SHEET_CSS = `
.fvs { background: #fff; color: #1b1b1f; font-family: Georgia, 'Times New Roman', serif; font-size: 11.5pt; line-height: 1.55; }
.fvs-head { display: flex; flex-direction: column; align-items: center; text-align: center; gap: 6px; }
.fvs-logo { width: auto; height: auto; max-height: 72px; max-width: 160px; object-fit: contain; }
.fvs-lines p { margin: 0; font-size: 10.5pt; color: #3b3b40; }
.fvs-lines p.fvs-strong { font-size: 12.5pt; font-weight: 700; color: #111113; text-transform: uppercase; letter-spacing: 0.02em; }
.fvs-rule { border-top: 2px solid #111113; border-bottom: 1px solid #111113; height: 2px; margin: 12px 0 18px; }
.fvs-title { font-size: 16pt; margin: 0 0 14px; color: #111113; }
.fvs-body > * + * { margin-top: 0.7em; }
.fvs-body > :first-child { margin-top: 0; }
.fvs-body h2 { font-size: 13.5pt; margin: 1.1em 0 0.3em; color: #111113; }
.fvs-body h3, .fvs-body h4 { font-size: 12pt; margin: 1em 0 0.25em; color: #111113; }
.fvs-body p { margin-bottom: 0; }
.fvs-body ul, .fvs-body ol { padding-left: 1.4em; margin-bottom: 0; }
.fvs-body li + li { margin-top: 0.2em; }
.fvs-body strong { color: #111113; }
.fvs-body blockquote { border-left: 2px solid #c9c6bd; padding-left: 12px; color: #55555b; font-style: italic; margin-left: 0; }
.fvs-body hr { border: 0; border-top: 1px solid #c9c6bd; }
.fvs-body code { font-family: ui-monospace, Consolas, monospace; font-size: 10pt; }
.fvs-body pre { white-space: pre-wrap; font-size: 9.5pt; background: #f6f5f1; padding: 8px; }
.fvs-body .fv-table-wrap { overflow-x: auto; }
.fvs-body table { width: 100%; border-collapse: collapse; font-family: system-ui, -apple-system, 'Segoe UI', sans-serif; font-size: 9.5pt; }
.fvs-body th { background: #111113; color: #fff; text-align: left; padding: 5px 7px; font-weight: 600; }
.fvs-body td { border: 1px solid #e0ddd5; padding: 5px 7px; vertical-align: top; }
.fvs-body tr:nth-child(even) td { background: #f6f5f1; }
.fvs-sign { margin-top: 40px; margin-left: auto; width: fit-content; min-width: 220px; max-width: 100%; text-align: center; }
.fvs-signature { display: block; max-height: 64px; max-width: 200px; margin: 0 auto -10px; object-fit: contain; }
.fvs-sign-name { margin: 0; padding-top: 4px; border-top: 1px solid #111113; font-weight: 700; text-transform: uppercase; color: #111113; }
.fvs-sign-title { margin: 0; font-size: 10pt; color: #3b3b40; }
.fvs-foot { margin-top: 36px; padding-top: 8px; border-top: 1px solid #e0ddd5; text-align: center; font-family: system-ui, -apple-system, 'Segoe UI', sans-serif; font-size: 8.5pt; color: #6b6b70; }
.fvs-foot p { margin: 0; }
.fvs-foot .fvs-note { margin-top: 2px; font-style: italic; }
`

/** Print the sheet on its own: A4, with page margins. */
export function printSheet(title: string, html: string) {
  return printHtml(title, `@page { size: A4; margin: 16mm 18mm; } body { margin: 0; } ${SHEET_CSS} .fvs table { page-break-inside: auto; } .fvs tr { page-break-inside: avoid; }`, html)
}
