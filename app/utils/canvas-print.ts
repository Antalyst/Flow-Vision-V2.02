/**
 * Printing an AI canvas (a report or table built from live FlowVision data): its title, the body
 * and the note that it was created with FlowVision. The exports (useCanvasExport.ts) end with the
 * same note. Everything is escaped; the body is HTML from renderMarkdown (already escaped).
 */

export const FLOWVISION_NOTE = 'This document was created with FlowVision.'

const CANVAS_PRINT_CSS = `
@page { size: A4; margin: 16mm 18mm; }
body { margin: 0; background: #fff; color: #1b1b1f; font-family: system-ui, -apple-system, 'Segoe UI', sans-serif; font-size: 10.5pt; line-height: 1.5; }
h1 { font-size: 16pt; margin: 0 0 14px; color: #111113; }
article > * + * { margin-top: 0.7em; }
article h2 { font-size: 13pt; margin: 1.1em 0 0.3em; color: #111113; }
article h3, article h4 { font-size: 11.5pt; margin: 1em 0 0.25em; color: #111113; }
article p, article ul, article ol { margin-bottom: 0; }
article ul, article ol { padding-left: 1.4em; }
article blockquote { border-left: 2px solid #c9c6bd; padding-left: 12px; color: #55555b; font-style: italic; margin-left: 0; }
article hr { border: 0; border-top: 1px solid #c9c6bd; }
article pre { white-space: pre-wrap; font-size: 9pt; background: #f6f5f1; padding: 8px; }
article table { width: 100%; border-collapse: collapse; font-size: 9pt; page-break-inside: auto; }
article tr { page-break-inside: avoid; }
article th { background: #111113; color: #fff; text-align: left; padding: 5px 7px; font-weight: 600; }
article td { border: 1px solid #e0ddd5; padding: 5px 7px; vertical-align: top; }
article tr:nth-child(even) td { background: #f6f5f1; }
footer { margin-top: 32px; padding-top: 8px; border-top: 1px solid #e0ddd5; text-align: center; font-size: 8.5pt; color: #6b6b70; font-style: italic; }
`

/** Print a canvas on its own: A4, with page margins. */
export function printCanvas(title: string, markdown: string) {
  const body = `<h1>${escapeHtml(title)}</h1><article>${renderMarkdown(markdown)}</article><footer>${escapeHtml(FLOWVISION_NOTE)}</footer>`
  return printHtml(title, CANVAS_PRINT_CSS, body)
}
