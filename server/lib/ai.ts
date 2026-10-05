import path from 'node:path'
import { httpError } from './errors.ts'
import { createCompletion, type ChatCompletionMessageParam } from './ai-groq.ts'

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
  const typeList = docTypes.map((t) => (t.description ? `- ${t.name}: ${t.description}` : `- ${t.name}`)).join('\n')
  const messages: ChatCompletionMessageParam[] = [
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
    ...(knowledge ? [{ role: 'system' as const, content: `Organization knowledge (excerpts):\n\n${knowledge}` }] : []),
    { role: 'user', content: `Document text:\n\n${text}` },
  ]

  // Same automatic model failover as the assistant (ai-groq.ts).
  const completion = await createCompletion({ messages, responseFormat: { type: 'json_object' }, maxTokens: 1024 })
  let parsed: Partial<DocumentSuggestion> = {}
  try {
    parsed = JSON.parse(completion.choices[0]?.message?.content ?? '{}')
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
