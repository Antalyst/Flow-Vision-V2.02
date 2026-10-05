import { isError } from 'h3'
import { createCompletion, modelLabel, type ChatCompletionMessageParam } from '~~/server/lib/ai-groq.ts'
import { ASSISTANT_ROLES, ASSISTANT_TOOLS, TOOL_LABELS, runAssistantTool, scrubIds } from '~~/server/lib/ai-tools.ts'
import { buildSystemPrompt } from '~~/server/lib/ai-prompt.ts'
import { badRequest, tooMany } from '~~/server/lib/errors.ts'

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

/**
 * The conversation from the page: user/assistant turns only (no system or tool roles can be
 * injected), the most recent ones, size-capped. Canvases of older answers are collapsed — the
 * user already has them, and resending every table would eat the AI's per-minute token budget.
 */
function readHistory(body: Record<string, unknown>): ChatCompletionMessageParam[] {
  if (!Array.isArray(body.messages)) throw badRequest('messages must be a list')
  const turns = body.messages
    .filter((m): m is { role: 'user' | 'assistant'; content: string } => {
      const r = (m as { role?: unknown })?.role
      const c = (m as { content?: unknown })?.content
      return (r === 'user' || r === 'assistant') && typeof c === 'string' && c.trim().length > 0
    })
    .slice(-MAX_HISTORY)
  if (turns.at(-1)?.role !== 'user') throw badRequest('The last message must be your question')

  const lastAssistant = turns.findLastIndex((m) => m.role === 'assistant')
  return turns.map((m, i) => {
    if (m.role === 'user') return { role: 'user', content: m.content.trim().slice(0, MAX_USER_CHARS) }
    const content = i === lastAssistant ? m.content : m.content.replace(CANVAS_RE, '$1[Canvas content already shown to the user]</canvas>')
    return { role: 'assistant', content: content.slice(0, MAX_ASSISTANT_CHARS) }
  })
}

type StreamEvent =
  | { type: 'tool_start'; id: string; name: string; label: string }
  | { type: 'tool_done'; id: string; name: string; label: string; summary: string; ok: boolean }
  | { type: 'reply'; content: string; model: string | null; tools: Array<{ name: string; label: string; summary: string; ok: boolean }> }
  | { type: 'error'; message: string }

/**
 * POST /api/ai/chat  { messages: [{ role: 'user' | 'assistant', content }] }
 * Streams newline-delimited JSON: tool_start / tool_done while the assistant looks things up,
 * then one `reply` (or `error`). Auth, validation and throttling fail before the stream starts,
 * as ordinary JSON errors.
 */
export default defineApiHandler(async (event) => {
  const actor = await requireUser(event, ...ASSISTANT_ROLES)
  throttle(actor.id)
  const history = readHistory(await readJson(event))
  const system = await buildSystemPrompt(actor)

  const encoder = new TextEncoder()
  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      const send = (e: StreamEvent) => controller.enqueue(encoder.encode(`${JSON.stringify(e)}\n`))
      const used: Array<{ name: string; label: string; summary: string; ok: boolean }> = []
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
        send({ type: 'reply', content, model: model && modelLabel(model), tools: used })
      } catch (err) {
        if (!isError(err)) console.error('[ai] chat failed', err)
        send({ type: 'error', message: isError(err) ? err.message : 'The assistant ran into a problem. Please try again.' })
      } finally {
        controller.close()
      }
    },
  })

  setResponseHeaders(event, {
    'content-type': 'application/x-ndjson; charset=utf-8',
    'cache-control': 'no-cache, no-transform',
    'x-accel-buffering': 'no',
  })
  return sendStream(event, stream)
})
