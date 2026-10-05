import Groq, { APIError } from 'groq-sdk'
import type { ChatCompletion, ChatCompletionMessageParam, ChatCompletionTool } from 'groq-sdk/resources/chat/completions'
import { httpError } from './errors.ts'

export type { ChatCompletionMessageParam, ChatCompletionTool }

/**
 * Model failover ("auto"). Every free Groq model has its own per-minute token and per-day request
 * limit, so when one is used up (429), removed (404) or can't take the request (413), the next
 * model answers instead and the first one rests until Groq says its limit resets.
 *
 * Order: GROQ_MODELS (comma-separated) if set, else the preference list below — best tool-calling
 * models first. Models this key doesn't have are skipped, and chat models Groq adds later are
 * appended automatically (speech, guard and other non-chat models are left out).
 */
const PREFERENCE = [
  'openai/gpt-oss-120b',
  'qwen/qwen3.8-27b',
  'llama-3.3-70b-versatile',
  'moonshotai/kimi-k2-instruct-0905',
  'meta-llama/llama-4-maverick-17b-128e-instruct',
  'qwen/qwen3-32b',
  'openai/gpt-oss-20b',
  'meta-llama/llama-4-scout-17b-16e-instruct',
  'llama-3.1-8b-instant',
]
const configured = (process.env.GROQ_MODELS || '')
  .split(',')
  .map((s) => s.trim())
  .filter(Boolean)
const ORDER = [...new Set([...(process.env.GROQ_MODEL ? [process.env.GROQ_MODEL] : []), ...(configured.length ? configured : PREFERENCE)])]
const NOT_CHAT = /whisper|orpheus|tts|playai|guard|allam|compound|distil/i
// Reasoning models: keep their thinking out of the answer.
const REASONING = /gpt-oss|qwen3|deepseek-r1/i

const MODELS_TTL_MS = 10 * 60_000
const DEFAULT_REST_MS = 60_000

let client: Groq | null = null
let catalog: { ids: Set<string>; at: number } | null = null
/** Model → time (ms) it may be used again. */
const resting = new Map<string, number>()
/** Models the key doesn't have; skipped until the catalog is next refreshed. */
const missing = new Set<string>()
let lastModel: string | null = null

export function groqClient(): Groq {
  const apiKey = process.env.GROQ_API_KEY
  if (!apiKey) throw httpError(503, 'The AI assistant is not configured (GROQ_API_KEY is missing)', 'AI_UNAVAILABLE')
  // No SDK retries: a limited model must hand over to the next one at once, not wait.
  client ??= new Groq({ apiKey, maxRetries: 0, timeout: 60_000 })
  return client
}

/** The key's models from Groq (cached). Null when the list can't be fetched — then ORDER is tried as is. */
async function availableIds(): Promise<Set<string> | null> {
  if (catalog && Date.now() - catalog.at < MODELS_TTL_MS) return catalog.ids
  try {
    const list = await groqClient().models.list()
    const ids = new Set(list.data.filter((m) => (m as { active?: boolean }).active !== false).map((m) => m.id))
    catalog = { ids, at: Date.now() }
    missing.clear()
    return ids
  } catch (err) {
    console.warn('[ai] could not list Groq models', err instanceof Error ? err.message : err)
    return catalog?.ids ?? null
  }
}

/** Every chat model in failover order, whether or not it is resting right now. */
async function chain() {
  const ids = await availableIds()
  if (!ids) return ORDER.filter((m) => !missing.has(m))
  const preferred = ORDER.filter((m) => ids.has(m))
  const extra = configured.length ? [] : [...ids].filter((m) => !NOT_CHAT.test(m) && !preferred.includes(m)).sort()
  return [...preferred, ...extra].filter((m) => !missing.has(m))
}

/** A Groq HTTP error — matched by shape too, so a second copy of the SDK in the bundle can't hide one. */
const asApiError = (err: unknown): APIError | null =>
  err instanceof APIError || (err && typeof err === 'object' && typeof (err as APIError).status === 'number' && 'error' in err) ? (err as APIError) : null

const errorCode = (err: APIError) => {
  const body = err.error as { error?: { code?: string }; code?: string } | undefined
  return body?.error?.code ?? body?.code ?? ''
}

/** "2m59.56s" / "7.66s" / "450ms" → milliseconds. */
function parseDuration(v: string | null | undefined) {
  if (!v) return null
  let ms = 0
  let matched = false
  for (const [, n, unit] of v.matchAll(/([\d.]+)\s*(ms|h|m|s)/g)) {
    matched = true
    ms += Number(n) * (unit === 'h' ? 3_600_000 : unit === 'm' ? 60_000 : unit === 's' ? 1000 : 1)
  }
  if (matched) return ms
  const seconds = Number(v)
  return Number.isFinite(seconds) ? seconds * 1000 : null
}

/** How long Groq says to wait: retry-after, the reset headers, or "try again in 14m22s" in the message. */
function restFor(err: APIError) {
  const h = err.headers
  const fromHeaders = [h?.get('retry-after'), h?.get('x-ratelimit-reset-tokens'), h?.get('x-ratelimit-reset-requests')]
    .map(parseDuration)
    .filter((n): n is number => n != null && n > 0)
  const fromMessage = parseDuration(/try again in ([\dhms.]+)/i.exec(err.message)?.[1])
  return Math.max(...fromHeaders, fromMessage ?? 0, 0) || DEFAULT_REST_MS
}

interface CompletionInput {
  messages: ChatCompletionMessageParam[]
  tools?: ChatCompletionTool[]
  /** 'none' forces a plain-text answer (used once tool rounds are exhausted). */
  toolChoice?: 'auto' | 'none'
  responseFormat?: { type: 'json_object' }
  temperature?: number
  maxTokens?: number
}

/**
 * One chat completion on the first model that can take it. Besides failover, a malformed tool
 * call (`tool_use_failed`) is retried once, then answered without tools.
 */
export async function createCompletion({ messages, tools, toolChoice = 'auto', responseFormat, temperature = 0.2, maxTokens = 2048 }: CompletionInput): Promise<ChatCompletion> {
  const groq = groqClient()
  const models = await chain()
  const now = Date.now()
  const ready = models.filter((m) => (resting.get(m) ?? 0) <= now)
  let tooLarge = false

  for (const model of ready) {
    let choice = tools?.length ? toolChoice : undefined
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        const completion = await groq.chat.completions.create({
          model,
          messages,
          temperature,
          max_completion_tokens: maxTokens,
          ...(REASONING.test(model) && { reasoning_format: 'hidden' as const }),
          ...(responseFormat && { response_format: responseFormat }),
          ...(tools?.length && { tools, tool_choice: choice, parallel_tool_calls: true }),
        })
        if (lastModel !== model) console.info(`[ai] answering with ${model}`)
        lastModel = model
        return completion
      } catch (caught) {
        const err = asApiError(caught)
        if (!err) {
          console.error('[ai] Groq request failed', model, caught)
          break
        }
        const code = errorCode(err)
        if (err.status === 401) throw httpError(503, 'The AI service rejected the API key (GROQ_API_KEY)', 'AI_UNAVAILABLE')
        if (code === 'tool_use_failed') {
          if (attempt === 1) choice = 'none'
          continue
        }
        if (err.status === 429) {
          const ms = restFor(err)
          resting.set(model, Date.now() + ms)
          console.warn(`[ai] ${model} reached its limit; resting ${Math.ceil(ms / 1000)}s, switching model`)
        } else if (err.status === 413) {
          tooLarge = true
          console.warn(`[ai] request too large for ${model}; trying the next model`)
        } else if (err.status === 404 || code === 'model_not_found' || code === 'model_decommissioned') {
          missing.add(model)
          console.warn(`[ai] ${model} is not available to this GROQ_API_KEY; switching model`)
        } else {
          console.error('[ai] Groq request failed', model, err.status, code, err.message.slice(0, 300))
        }
        break
      }
    }
  }

  if (tooLarge) throw httpError(413, 'This question needs more data than the free AI models accept at once. Ask something narrower, or start a new chat.', 'AI_TOO_LARGE')
  if (models.length && models.every((m) => (resting.get(m) ?? 0) > Date.now())) {
    const soonest = Math.min(...models.map((m) => resting.get(m)!))
    const seconds = Math.max(1, Math.ceil((soonest - Date.now()) / 1000))
    const wait = seconds < 90 ? `${seconds} seconds` : `${Math.ceil(seconds / 60)} minutes`
    throw httpError(429, `All free AI models have reached their limits for now. Try again in about ${wait}.`, 'AI_RATE_LIMITED')
  }
  throw httpError(502, 'The AI service could not answer right now. Please try again.', 'AI_FAILED')
}

const LABELS: Record<string, string> = {
  'openai/gpt-oss-120b': 'GPT-OSS 120B',
  'openai/gpt-oss-20b': 'GPT-OSS 20B',
  'qwen/qwen3.8-27b': 'Qwen 3.8 27B',
  'qwen/qwen3-32b': 'Qwen 3 32B',
  'llama-3.3-70b-versatile': 'Llama 3.3 70B',
  'llama-3.1-8b-instant': 'Llama 3.1 8B',
  'moonshotai/kimi-k2-instruct-0905': 'Kimi K2',
  'meta-llama/llama-4-maverick-17b-128e-instruct': 'Llama 4 Maverick',
  'meta-llama/llama-4-scout-17b-16e-instruct': 'Llama 4 Scout',
}
export const modelLabel = (id: string) =>
  LABELS[id] ??
  (id.split('/').pop() ?? id)
    .split('-')
    .map((w) => (/^\d|^[a-z]{1,3}$/.test(w) ? w.toUpperCase() : w[0]!.toUpperCase() + w.slice(1)))
    .join(' ')

/** The failover list as the chat page shows it. */
export async function modelStatus() {
  const models = await chain()
  const now = Date.now()
  const ready = models.filter((m) => (resting.get(m) ?? 0) <= now)
  return {
    mode: 'auto' as const,
    current: lastModel && ready.includes(lastModel) ? lastModel : (ready[0] ?? null),
    models: models.map((id) => {
      const until = resting.get(id) ?? 0
      return { id, label: modelLabel(id), status: until > now ? ('resting' as const) : ('ready' as const), ...(until > now && { until: new Date(until).toISOString() }) }
    }),
  }
}

export const lastUsedModel = () => lastModel
