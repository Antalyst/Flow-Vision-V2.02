import { defineStore } from 'pinia'
import type { CanvasDoc } from '~/utils/markdown'

export interface AssistantTool {
  id?: string
  name: string
  label: string
  summary?: string
  ok?: boolean
  done: boolean
  /** findDocuments: what it found, shown as cards that open each document. */
  documents?: FoundDocument[]
}

/** A document the assistant found (findDocuments). */
export interface FoundDocument {
  id: string
  title: string
  tracking_code: string | null
  status: string
  document_type: string | null
  submitted_at: string | null
  location: string | null
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
  /** The messages have been fetched (the list only carries titles). */
  loaded?: boolean
  /** Not saved yet: the server hasn't confirmed the first question. */
  draft?: boolean
}

type ConversationSummary = Omit<Conversation, 'messages' | 'loaded' | 'draft'>

type StreamEvent =
  | { type: 'saved'; conversation: ConversationSummary; question: { id: string; at: string } }
  | { type: 'tool_start'; id: string; name: string; label: string }
  | { type: 'tool_done'; id: string; name: string; label: string; summary: string; ok: boolean; documents?: FoundDocument[] }
  | { type: 'reply'; id: string; at: string; content: string; model: string | null; tools: AssistantTool[] }
  | { type: 'error'; id?: string; at?: string; message: string }

// Before conversations were saved to the database they lived in localStorage under this prefix.
// They're imported once, then removed from the browser.
const STORAGE_PREFIX = 'fv_assistant_'
const newId = () => globalThis.crypto?.randomUUID?.() ?? `${Date.now()}-${Math.random().toString(36).slice(2)}`
const titleFrom = (text: string) => {
  const t = text.replace(/\s+/g, ' ').trim()
  return t.length > 60 ? `${t.slice(0, 57)}…` : t
}

/** Removes any conversations left in this browser from before they were saved to the account (called on sign-out). */
export function clearAssistantStorage() {
  if (!import.meta.client) return
  try {
    for (const key of Object.keys(localStorage)) if (key.startsWith(STORAGE_PREFIX)) localStorage.removeItem(key)
  } catch {
    /* storage blocked */
  }
}

/**
 * Assistant conversations, saved to the user's account (ai_conversations / ai_messages), so they
 * follow the user to any device. The list loads first; a thread's messages load when it's opened.
 * The server stores each question and answer itself as part of /api/ai/chat.
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
  /** Fetching the conversation list / the open thread. */
  const listLoading = ref(false)
  const threadLoading = ref(false)
  let loadedFor: string | null = null

  /** The automatic failover list (which free models are ready or resting). */
  async function refreshModels() {
    try {
      models.value = await useApi().get<ModelStatus>('/ai/models')
    } catch {
      /* the list is informational only */
    }
  }

  const toConversation = (c: ConversationSummary): Conversation => ({ ...c, messages: [], loaded: false })

  /** The signed-in user's conversations. Runs once per account. */
  async function load() {
    const userId = auth.user?.id
    if (!import.meta.client || !userId || loadedFor === userId) return
    loadedFor = userId
    conversations.value = []
    activeId.value = null
    listLoading.value = true
    try {
      await importLocal(userId)
      const { data } = await useApi().get<{ data: ConversationSummary[] }>('/ai/conversations')
      // Keep a thread that was started while the list was loading.
      const drafts = conversations.value.filter((c) => c.draft || c.loaded)
      conversations.value = [...drafts, ...data.filter((c) => !drafts.some((d) => d.id === c.id)).map(toConversation)]
    } catch (err) {
      loadedFor = null
      useUiStore().error('Could not load your conversations', apiErrorMessage(err))
    } finally {
      listLoading.value = false
    }
  }

  /** Moves conversations saved in this browser (older versions) into the account, then forgets them. */
  async function importLocal(userId: string) {
    const key = `${STORAGE_PREFIX}${userId}`
    let saved: unknown
    try {
      saved = JSON.parse(localStorage.getItem(key) ?? 'null')
    } catch {
      return
    }
    if (!Array.isArray(saved) || !saved.length) {
      if (saved !== null) localStorage.removeItem(key)
      return
    }
    await useApi().post('/ai/conversations/import', { conversations: saved })
    localStorage.removeItem(key)
  }

  /** Fetches a thread's messages the first time it's opened. */
  async function fetchThread(convo: Conversation) {
    if (convo.loaded || convo.draft) return
    threadLoading.value = true
    try {
      const full = await useApi().get<ConversationSummary & { messages: AssistantMessage[] }>(`/ai/conversations/${convo.id}`)
      Object.assign(convo, { title: full.title, updatedAt: full.updatedAt, messages: full.messages, loaded: true })
    } catch (err) {
      useUiStore().error('Could not open the conversation', apiErrorMessage(err))
    } finally {
      threadLoading.value = false
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
    const convo = conversations.value.find((c) => c.id === id)
    if (convo) void fetchThread(convo)
  }

  const startNew = () => select(null)

  /** Deletes a conversation for good. It disappears at once and comes back if the server refuses. */
  async function remove(id: string) {
    if (pendingId.value === id) return
    const index = conversations.value.findIndex((c) => c.id === id)
    const convo = conversations.value[index]
    if (!convo) return
    conversations.value.splice(index, 1)
    if (activeId.value === id) select(null)
    if (convo.draft) return
    try {
      await useApi().del(`/ai/conversations/${id}`)
    } catch (err) {
      conversations.value.splice(index, 0, convo)
      useUiStore().error('Could not delete the conversation', apiErrorMessage(err))
    }
  }

  function fail(convo: Conversation, question: AssistantMessage, message: string, saved?: { id?: string; at?: string }) {
    question.failed = true
    convo.messages.push({ id: saved?.id ?? newId(), role: 'assistant', content: message, at: saved?.at ?? new Date().toISOString(), error: true })
  }

  function handle(e: StreamEvent, convo: Conversation, question: AssistantMessage) {
    if (e.type === 'saved') {
      // The server's ids replace the temporary ones; a new thread becomes a saved conversation.
      const wasId = convo.id
      Object.assign(convo, { id: e.conversation.id, title: e.conversation.title, createdAt: e.conversation.createdAt, draft: false, loaded: true })
      if (activeId.value === wasId) activeId.value = convo.id
      if (pendingId.value === wasId) pendingId.value = convo.id
      question.id = e.question.id
      question.at = e.question.at
    } else if (e.type === 'tool_start') liveTools.value.push({ id: e.id, name: e.name, label: e.label, done: false })
    else if (e.type === 'tool_done') {
      const t = liveTools.value.find((x) => x.id === e.id)
      if (t) Object.assign(t, { summary: e.summary, ok: e.ok, done: true, documents: e.documents })
    } else if (e.type === 'reply') {
      const msg: AssistantMessage = { id: e.id, role: 'assistant', content: e.content, at: e.at, model: e.model, tools: e.tools.map((t) => ({ ...t, done: true })) }
      convo.messages.push(msg)
      const made = splitCanvas(msg.content, msg.id).flatMap((s) => (s.kind === 'canvas' ? [s.canvas] : []))
      if (made.length && activeId.value === convo.id) openCanvas(made.at(-1)!.id)
    } else if (e.type === 'error') fail(convo, question, e.message, e)
  }

  async function send(text: string, retryOf?: string) {
    const content = text.trim()
    if (!content || pending.value) return

    let convo = active.value
    if (!convo) {
      const now = new Date().toISOString()
      conversations.value.push({ id: newId(), title: titleFrom(content), createdAt: now, updatedAt: now, messages: [], draft: true, loaded: true })
      // The reactive copy, so later pushes update the page.
      convo = conversations.value.at(-1)!
      activeId.value = convo.id
    }
    const question: AssistantMessage = { id: newId(), role: 'user', content, at: new Date().toISOString() }
    convo.messages.push(question)
    convo.updatedAt = question.at
    pendingId.value = convo.id
    liveTools.value = []

    try {
      const res = await fetch('/api/ai/chat', {
        method: 'POST',
        credentials: 'same-origin',
        headers: { 'content-type': 'application/json', accept: 'application/x-ndjson' },
        // The server keeps the history; only the new question travels.
        body: JSON.stringify({ message: content, conversationId: convo.draft ? undefined : convo.id, retryOf }),
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
    // The server drops its saved copy of the unanswered question (and its error notice) too.
    await send(question!.content, question!.id)
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
    listLoading,
    threadLoading,
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
