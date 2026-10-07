import { isError } from 'h3'
import { createCompletion, modelLabel, type ChatCompletionMessageParam } from '~~/server/lib/ai-groq.ts'
import { ASSISTANT_ROLES, ASSISTANT_TOOLS, TOOL_LABELS, runAssistantTool, scrubIds } from '~~/server/lib/ai-tools.ts'
import { buildSystemPrompt } from '~~/server/lib/ai-prompt.ts'
import { badRequest, tooMany } from '~~/server/lib/errors.ts'
import {
  addMessage,
  createConversation,
  discardFailedQuestion,
  historyFor,
  ownConversation,
  serializeConversation,
  touchConversation,
} from '~~/server/lib/ai-history.ts'
import { AiMessage } from '~~/server/lib/models.ts'
import { requirePage } from '~~/server/lib/team.ts'

// The free models allow 8,000 tokens a minute, so only the recent turns go along.
const MAX_HISTORY = 12
const MAX_USER_CHARS = 4000
const MAX_ASSISTANT_CHARS = 8000
const MAX_TOOL_ROUNDS = 4

// Per-user throttle (per process): each message can cost several AI calls.
const WINDOW_MS = 60_000
const PER_WINDOW = 12
const recent = new Map<string, number[]>()
function throttle(userId: string) {
  const now = Date.now()
  const hits = (recent.get(userId) ?? []).filter((t) => now - t < WINDOW_MS)
  if (hits.length >= PER_WINDOW) throw tooMany('You are sending messages too quickly. Wait a moment and try again.')
  hits.push(now)
  recent.set(userId, hits)
  if (recent.size > 5000) for (const [k, v] of recent) if (!v.some((t) => now - t < WINDOW_MS)) recent.delete(k)
}

const CANVAS_RE = /(<canvas\b[^>]*>)[\s\S]*?(<\/canvas>|$)/gi

/** The question being asked, trimmed and size-checked. */
function readQuestion(body: Record<string, unknown>): string {
  const text = typeof body.message === 'string' ? body.message.trim() : ''
  if (!text) throw badRequest('Type a question first')
  if (text.length > MAX_USER_CHARS) throw badRequest(`Keep questions under ${MAX_USER_CHARS.toLocaleString()} characters`)
  return text
}

/**
 * The saved conversation as the AI sees it: the most recent answered turns, size-capped.
 * Canvases of older answers are collapsed — the user already has them, and resending every
 * table would eat the AI's per-minute token budget.
 */
function toPrompt(turns: Array<{ role: 'user' | 'assistant'; content: string }>): ChatCompletionMessageParam[] {
  const lastAssistant = turns.findLastIndex((m) => m.role === 'assistant')
  return turns.map((m, i) => {
    if (m.role === 'user') return { role: 'user', content: m.content.trim().slice(0, MAX_USER_CHARS) }
    const content = i === lastAssistant ? m.content : m.content.replace(CANVAS_RE, '$1[Canvas content already shown to the user]</canvas>')
    return { role: 'assistant', content: content.slice(0, MAX_ASSISTANT_CHARS) }
  })
}

type StreamEvent =
  | { type: 'saved'; conversation: ReturnType<typeof serializeConversation>; question: { id: string; at: string } }
  | { type: 'tool_start'; id: string; name: string; label: string }
  | { type: 'tool_done'; id: string; name: string; label: string; summary: string; ok: boolean }
  | { type: 'reply'; id: string; at: string; content: string; model: string | null; tools: Array<{ name: string; label: string; summary: string; ok: boolean }> }
  | { type: 'error'; id?: string; at?: string; message: string }

/**
 * POST /api/ai/chat  { message, conversationId?, retryOf? }
 * Saves the question to the user's conversation (a new one when there is no conversationId),
 * then streams newline-delimited JSON: `saved` with the stored ids, tool_start / tool_done while
 * the assistant looks things up, then one `reply` (or `error`) — also saved, so the thread is
 * complete even if the page was closed mid-answer. `retryOf` replaces an unanswered question.
 * Auth, validation and throttling fail before the stream starts, as ordinary JSON errors.
 */
export default defineApiHandler(async (event) => {
  const actor = await requireUser(event, ...ASSISTANT_ROLES)
  requirePage(actor, '/ai/chat')
  throttle(actor.id)
  const body = await readJson(event)
  const text = readQuestion(body)

  const convo = body.conversationId ? await ownConversation(actor, body.conversationId) : await createConversation(actor, text)
  await discardFailedQuestion(convo.id, body.retryOf)
  const question = await addMessage(convo.id, { role: 'user', content: text })
  await touchConversation(convo.id)
  await convo.reload()
  const history = toPrompt(await historyFor(convo.id, MAX_HISTORY))
  const system = await buildSystemPrompt(actor)

  const encoder = new TextEncoder()
  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      // The page may be closed mid-answer. Writing to the gone stream is ignored, so the answer
      // is still saved (and never mistaken for a failure).
      let open = true
      const send = (e: StreamEvent) => {
        if (!open) return
        try {
          controller.enqueue(encoder.encode(`${JSON.stringify(e)}\n`))
        } catch {
          open = false
        }
      }
      const used: Array<{ name: string; label: string; summary: string; ok: boolean }> = []
      send({ type: 'saved', conversation: serializeConversation(convo), question: { id: question.id, at: new Date(question.created_at).toISOString() } })
      try {
        const messages: ChatCompletionMessageParam[] = [{ role: 'system', content: system }, ...history]
        let reply = ''
        let model: string | null = null
        for (let round = 0; ; round++) {
          const finalRound = round >= MAX_TOOL_ROUNDS
          const completion = await createCompletion({ messages, tools: ASSISTANT_TOOLS, toolChoice: finalRound ? 'none' : 'auto' })
          model = completion.model
          const message = completion.choices[0]?.message
          const calls = message?.tool_calls ?? []
          if (!calls.length || finalRound) {
            reply = message?.content ?? ''
            break
          }
          messages.push({ role: 'assistant', content: message?.content || null, tool_calls: calls })
          for (const call of calls) {
            const name = call.function.name
            const label = TOOL_LABELS[name] ?? 'Looking things up'
            send({ type: 'tool_start', id: call.id, name, label })
            const outcome = await runAssistantTool(name, call.function.arguments, actor)
            messages.push({ role: 'tool', tool_call_id: call.id, content: outcome.content })
            used.push({ name, label, summary: outcome.summary, ok: outcome.ok })
            send({ type: 'tool_done', id: call.id, name, label, summary: outcome.summary, ok: outcome.ok })
          }
        }
        const content = scrubIds(reply.trim()) || "I couldn't put an answer together this time. Try asking again, or phrase the question differently."
        const label = model && modelLabel(model)
        const answer = await addMessage(convo.id, { role: 'assistant', content, model: label, tools: used })
        await touchConversation(convo.id)
        send({ type: 'reply', id: answer.id, at: new Date(answer.created_at).toISOString(), content, model: label, tools: used })
      } catch (err) {
        if (!isError(err)) console.error('[ai] chat failed', err)
        const message = isError(err) ? err.message : 'The assistant ran into a problem. Please try again.'
        // Keep the thread as the user saw it: the question marked unanswered, then the notice.
        const notice = await Promise.all([
          AiMessage.update({ failed: true }, { where: { id: question.id } }),
          addMessage(convo.id, { role: 'assistant', content: message, isError: true }),
        ])
          .then(([, n]) => n)
          .catch((saveErr) => {
            console.error('[ai] could not save the error notice', saveErr)
            return null
          })
        send({ type: 'error', id: notice?.id, at: notice ? new Date(notice.created_at).toISOString() : undefined, message })
      } finally {
        try {
          controller.close()
        } catch {
          /* already closed by the client */
        }
      }
    },
    cancel() {
      /* client went away; start() keeps going and saves the answer */
    },
  })

  setResponseHeaders(event, {
    'content-type': 'application/x-ndjson; charset=utf-8',
    'cache-control': 'no-cache, no-transform',
    'x-accel-buffering': 'no',
  })
  return sendStream(event, stream)
})
