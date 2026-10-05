import path from 'node:path'
import { httpError } from './errors.ts'

const GROQ_URL = 'https://api.groq.com/openai/v1/chat/completions'
// Llama 3.3 70B first; if the key has no access to it, fall back to the next model. GROQ_MODEL overrides the first choice.
const GROQ_MODELS = [process.env.GROQ_MODEL || 'llama-3.3-70b-versatile', 'openai/gpt-oss-120b']
// Enough for the title page and opening sections; keeps requests well inside the model's context.
const MAX_CHARS = 12000
const TEXT_EXTS = new Set(['.txt', '.md', '.markdown', '.csv'])

export interface DocumentSuggestion {
  title: string
  description: string
  document_type: string
}

/**
 * Plain text from a PDF, Word (.docx) or text-based upload (.txt, .md, .csv); '' when the format
 * can't be read. `maxChars` caps the result (the document analysis only needs the opening).
 */
export async function extractText(data: Buffer, filename: string | undefined, mime: string | undefined, { maxChars = MAX_CHARS } = {}): Promise<string> {
  const ext = path.extname(filename ?? '').toLowerCase()
  let text = ''
  if (mime === 'application/pdf' || ext === '.pdf') {
    const { extractText: pdfText, getDocumentProxy } = await import('unpdf')
    const pdf = await getDocumentProxy(new Uint8Array(data))
    text = (await pdfText(pdf, { mergePages: true })).text
  } else if (ext === '.docx') {
    const mammoth = await import('mammoth')
    text = (await mammoth.extractRawText({ buffer: data })).value
  } else if (mime?.startsWith('text/') || TEXT_EXTS.has(ext)) {
    text = data.toString('utf8')
  }
  return text.replace(/\s+/g, ' ').trim().slice(0, maxChars)
}

/** Ask Groq for a title, description and document type based on the document's text. */
export interface AiContext {
  /** The organization's name, so the AI knows whose paperwork it reads. */
  organization: string
  /** The organization's document types (Organization Settings), with what each covers. */
  docTypes: Array<{ name: string; description?: string | null }>
  /** Passages from the organization's knowledge files that match this document (may be empty). */
  knowledge: string
}

export async function suggestDocumentDetails(text: string, { organization, docTypes, knowledge }: AiContext): Promise<DocumentSuggestion> {
  const apiKey = process.env.GROQ_API_KEY
  if (!apiKey) throw httpError(503, 'AI is not configured (GROQ_API_KEY is missing)', 'AI_UNAVAILABLE')

  const typeList = docTypes.map((t) => (t.description ? `- ${t.name}: ${t.description}` : `- ${t.name}`)).join('\n')
  const messages = [
    {
      role: 'system',
      content:
        `You read documents submitted to ${organization}, a Philippine government organization, and fill in their tracking record. ` +
        'Reply with JSON only: {"title": string, "description": string, "document_type": string}. ' +
        'title: the document\'s own title or subject, concise (max 120 characters), no tracking numbers. ' +
        'description: 1–3 plain sentences on what the document is, who it is from, and what it requests or needs (max 600 characters). ' +
        `document_type: exactly one of these names, or "Other" if none fit:\n${typeList || '- Other'}\n` +
        'Use only facts from the document; never invent names, amounts or dates. ' +
        'The organization knowledge below (when given) explains its terms, offices and procedures: use it to understand and classify the document, never as a source of facts about it.',
    },
    ...(knowledge ? [{ role: 'system', content: `Organization knowledge (excerpts):\n\n${knowledge}` }] : []),
    { role: 'user', content: `Document text:\n\n${text}` },
  ]

  let res: Response | null = null
  for (const model of new Set(GROQ_MODELS)) {
    res = await fetch(GROQ_URL, {
      method: 'POST',
      headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ model, temperature: 0.2, response_format: { type: 'json_object' }, messages }),
    })
    if (res.ok) break
    const detail = await res.text().catch(() => '')
    console.error('[ai] Groq request failed', model, res.status, detail.slice(0, 500))
    // Only an unavailable model is worth retrying with the next one.
    if (!detail.includes('model_not_found') && !detail.includes('model_decommissioned')) break
  }
  if (!res?.ok) throw httpError(502, 'The AI service could not read this document right now', 'AI_FAILED')

  const body = (await res.json()) as { choices?: { message?: { content?: string } }[] }
  let parsed: Partial<DocumentSuggestion> = {}
  try {
    parsed = JSON.parse(body.choices?.[0]?.message?.content ?? '{}')
  } catch {
    throw httpError(502, 'The AI returned an unreadable answer', 'AI_FAILED')
  }
  const clean = (v: unknown, max: number) => (typeof v === 'string' ? v.trim().slice(0, max) : '')
  return {
    title: clean(parsed.title, 255),
    description: clean(parsed.description, 5000),
    document_type: clean(parsed.document_type, 100),
  }
}
