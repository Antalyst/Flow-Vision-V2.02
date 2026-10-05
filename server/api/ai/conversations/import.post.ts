import { ASSISTANT_ROLES } from '~~/server/lib/ai-tools.ts'
import { addMessage, createConversation, serializeConversation, touchConversation, type StoredTool } from '~~/server/lib/ai-history.ts'
import { badRequest } from '~~/server/lib/errors.ts'

// Conversations used to live only in the browser. The page sends them here once, after which the
// database is the only copy. Sizes match what the browser used to keep.
const MAX_IMPORT = 40
const MAX_MESSAGES = 80
const MAX_CHARS = 60_000

interface LocalMessage {
  role?: unknown
  content?: unknown
  at?: unknown
  model?: unknown
  tools?: unknown
  error?: unknown
}

const validDate = (v: unknown) => {
  const d = typeof v === 'string' ? new Date(v) : null
  return d && !Number.isNaN(d.getTime()) && d.getTime() <= Date.now() ? d : null
}

/** POST /api/ai/conversations/import  { conversations: [{ title, messages: [...] }] } */
export default defineApiHandler(async (event) => {
  const actor = await requireUser(event, ...ASSISTANT_ROLES)
  const body = await readJson(event)
  if (!Array.isArray(body.conversations)) throw badRequest('conversations must be a list')

  const imported = []
  for (const raw of body.conversations.slice(0, MAX_IMPORT) as Array<{ title?: unknown; messages?: unknown }>) {
    const messages = (Array.isArray(raw?.messages) ? (raw.messages as LocalMessage[]) : [])
      .filter((m) => (m?.role === 'user' || m?.role === 'assistant') && typeof m.content === 'string' && m.content.trim())
      .slice(-MAX_MESSAGES)
    if (!messages.length) continue

    const firstQuestion = messages.find((m) => m.role === 'user')?.content as string | undefined
    const convo = await createConversation(actor, typeof raw.title === 'string' && raw.title.trim() ? raw.title : (firstQuestion ?? 'Imported chat'))
    // Keep the original order even where saved times are missing or equal.
    let last = 0
    for (const m of messages) {
      const at = Math.max((validDate(m.at) ?? new Date()).getTime(), last + 1)
      last = at
      await addMessage(convo.id, {
        role: m.role as 'user' | 'assistant',
        content: (m.content as string).slice(0, MAX_CHARS),
        model: typeof m.model === 'string' ? m.model.slice(0, 100) : null,
        tools: Array.isArray(m.tools) ? (m.tools as StoredTool[]).filter((t) => t && typeof t.name === 'string' && typeof t.label === 'string') : undefined,
        isError: m.error === true,
        at: new Date(at),
      })
    }
    // The list is sorted by last use, so it keeps the original order too.
    await touchConversation(convo.id, new Date(last))
    await convo.reload()
    imported.push(serializeConversation(convo))
  }
  return { data: imported }
})
