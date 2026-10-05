import { defineStore } from 'pinia'
import type { CanvasDoc } from '~/utils/markdown'

export interface AssistantTool {
  id?: string
  name: string
  label: string
  summary?: string
  ok?: boolean
  done: boolean
}

export interface AssistantMessage {
  id: string
  role: 'user' | 'assistant'
  content: string
  at: string
  tools?: AssistantTool[]
  /** Which AI model wrote the answer. */
  model?: string | null
  /** An assistant message that is an error notice; it and its question are left out of the history. */
  error?: boolean
  failed?: boolean
}

export interface ModelStatus {
  mode: 'auto'
  current: string | null
  models: Array<{ id: string; label: string; status: 'ready' | 'resting'; until?: string }>
}

export interface Conversation {
  id: string
  title: string
  createdAt: string
  updatedAt: string
  messages: AssistantMessage[]
}

type StreamEvent =
  | { type: 'tool_start'; id: string; name: string; label: string }
  | { type: 'tool_done'; id: string; name: string; label: string; summary: string; ok: boolean }
  | { type: 'reply'; content: string; model: string | null; tools: AssistantTool[] }
  | { type: 'error'; message: string }

const STORAGE_PREFIX = 'fv_assistant_'
const MAX_CONVERSATIONS = 40
const MAX_MESSAGES = 80
const newId = () => globalThis.crypto?.randomUUID?.() ?? `${Date.now()}-${Math.random().toString(36).slice(2)}`
const titleFrom = (text: string) => {
  const t = text.replace(/\s+/g, ' ').trim()
  return t.length > 60 ? `${t.slice(0, 57)}…` : t
}

/** Removes every saved conversation in this browser (called on sign-out). */
export function clearAssistantStorage() {
  if (!import.meta.client) return
  try {
    for (const key of Object.keys(localStorage)) if (key.startsWith(STORAGE_PREFIX)) localStorage.removeItem(key)
  } catch {
    /* storage blocked */
  }
}

/**
 * Assistant conversations, kept in this browser per account (localStorage) and cleared on
 * sign-out. Nothing is stored on the server.
 */
export const useAssistantStore = defineStore('assistant', () => {
  const auth = useAuthStore()
  const conversations = ref<Conversation[]>([])
  const activeId = ref<string | null>(null)
  const pendingId = ref<string | null>(null)
  const liveTools = ref<AssistantTool[]>([])
  const canvasOpen = ref(false)
  const activeCanvasId = ref<string | null>(null)
  const models = ref<ModelStatus | null>(null)
  let loadedFor: string | null = null

  /** The automatic failover list (which free models are ready or resting). */
  async function refreshModels() {
    try {
      models.value = await useApi().get<ModelStatus>('/ai/models')
    } catch {
      /* the list is informational only */
    }
  }

  const storageKey = () => (auth.user ? `${STORAGE_PREFIX}${auth.user.id}` : null)

  function load() {
    const key = storageKey()
    if (!import.meta.client || !key || loadedFor === key) return
    loadedFor = key
    try {
      const saved = JSON.parse(localStorage.getItem(key) ?? '[]')
      conversations.value = Array.isArray(saved) ? saved : []
    } catch {
      conversations.value = []
    }
    activeId.value = null
  }

  function persist() {
    const key = storageKey()
    if (!import.meta.client || !key) return
    const kept = [...conversations.value]
      .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
      .slice(0, MAX_CONVERSATIONS)
      .map((c) => ({ ...c, messages: c.messages.slice(-MAX_MESSAGES) }))
    try {
      localStorage.setItem(key, JSON.stringify(kept))
    } catch {
      /* storage full or blocked: the conversation still works for this visit */
    }
  }

  /** Newest first, for the sidebar. */
  const sorted = computed(() => [...conversations.value].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)))
  const active = computed(() => conversations.value.find((c) => c.id === activeId.value) ?? null)
  const messages = computed(() => active.value?.messages ?? [])
  const pending = computed(() => pendingId.value !== null)
  /** The open conversation is the one waiting for an answer. */
  const pendingHere = computed(() => pendingId.value !== null && pendingId.value === activeId.value)

  /** Every canvas in the open conversation, oldest first. */
  const canvases = computed<CanvasDoc[]>(() =>
    messages.value
      .filter((m) => m.role === 'assistant' && !m.error)
      .flatMap((m) => splitCanvas(m.content, m.id))
      .flatMap((s) => (s.kind === 'canvas' ? [s.canvas] : [])),
  )

  function openCanvas(id: string) {
    activeCanvasId.value = id
    canvasOpen.value = true
  }

  function select(id: string | null) {
    activeId.value = id
    canvasOpen.value = false
    activeCanvasId.value = null
  }

  const startNew = () => select(null)

  function remove(id: string) {
    if (pendingId.value === id) return
    conversations.value = conversations.value.filter((c) => c.id !== id)
    if (activeId.value === id) select(null)
    persist()
  }

  function fail(convo: Conversation, question: AssistantMessage, message: string) {
    question.failed = true
    convo.messages.push({ id: newId(), role: 'assistant', content: message, at: new Date().toISOString(), error: true })
  }

  function handle(e: StreamEvent, convo: Conversation, question: AssistantMessage) {
    if (e.type === 'tool_start') liveTools.value.push({ id: e.id, name: e.name, label: e.label, done: false })
    else if (e.type === 'tool_done') {
      const t = liveTools.value.find((x) => x.id === e.id)
      if (t) Object.assign(t, { summary: e.summary, ok: e.ok, done: true })
    } else if (e.type === 'reply') {
      const msg: AssistantMessage = { id: newId(), role: 'assistant', content: e.content, at: new Date().toISOString(), model: e.model, tools: e.tools.map((t) => ({ ...t, done: true })) }
      convo.messages.push(msg)
      const made = splitCanvas(msg.content, msg.id).flatMap((s) => (s.kind === 'canvas' ? [s.canvas] : []))
      if (made.length && activeId.value === convo.id) openCanvas(made.at(-1)!.id)
    } else if (e.type === 'error') fail(convo, question, e.message)
  }

  async function send(text: string) {
    const content = text.trim()
    if (!content || pending.value) return

    let convo = active.value
    if (!convo) {
      const now = new Date().toISOString()
      conversations.value.push({ id: newId(), title: titleFrom(content), createdAt: now, updatedAt: now, messages: [] })
      // The reactive copy, so later pushes update the page.
      convo = conversations.value.at(-1)!
      activeId.value = convo.id
    }
    const question: AssistantMessage = { id: newId(), role: 'user', content, at: new Date().toISOString() }
    convo.messages.push(question)
    convo.updatedAt = question.at
    pendingId.value = convo.id
    liveTools.value = []
    persist()

    const history = convo.messages.filter((m) => !m.error && !m.failed).map(({ role, content }) => ({ role, content }))
    try {
      const res = await fetch('/api/ai/chat', {
        method: 'POST',
        credentials: 'same-origin',
        headers: { 'content-type': 'application/json', accept: 'application/x-ndjson' },
        body: JSON.stringify({ messages: history }),
      })
      if (res.status === 401) {
        auth.clear()
        await navigateTo({ path: '/login', query: { redirect: '/ai/chat' } })
        return
      }
      if (!res.ok || !res.body) {
        const data = (await res.json().catch(() => null)) as { message?: string } | null
        fail(convo, question, data?.message ?? 'The assistant is unavailable right now.')
        return
      }

      const reader = res.body.getReader()
      const decoder = new TextDecoder()
      let buffer = ''
      let answered = false
      for (;;) {
        const { value, done } = await reader.read()
        buffer += decoder.decode(value, { stream: !done })
        let nl: number
        while ((nl = buffer.indexOf('\n')) >= 0) {
          const line = buffer.slice(0, nl).trim()
          buffer = buffer.slice(nl + 1)
          if (!line) continue
          const event = JSON.parse(line) as StreamEvent
          if (event.type === 'reply' || event.type === 'error') answered = true
          handle(event, convo, question)
        }
        if (done) break
      }
      if (!answered) fail(convo, question, 'The connection closed before the answer arrived. Please try again.')
    } catch {
      fail(convo, question, 'Cannot reach the FlowVision server.')
    } finally {
      convo.updatedAt = new Date().toISOString()
      pendingId.value = null
      liveTools.value = []
      persist()
      refreshModels()
    }
  }

  /** Ask a failed question again: drop it and its error notice, then resend. */
  async function retry(questionId: string) {
    const convo = active.value
    if (!convo || pending.value) return
    const i = convo.messages.findIndex((m) => m.id === questionId)
    if (i < 0) return
    const [question] = convo.messages.splice(i, convo.messages[i + 1]?.error ? 2 : 1)
    await send(question!.content)
  }

  return {
    conversations,
    sorted,
    activeId,
    pendingId,
    active,
    messages,
    pending,
    pendingHere,
    liveTools,
    models,
    refreshModels,
    canvasOpen,
    activeCanvasId,
    canvases,
    load,
    select,
    startNew,
    remove,
    send,
    retry,
    openCanvas,
  }
})
