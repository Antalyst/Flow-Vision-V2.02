<script setup lang="ts">
import type { Message } from '~/types'

/** A live chat thread: a document's thread, a direct conversation, or the office channel. */
const props = withDefaults(
  defineProps<{ kind: 'DOCUMENT' | 'DIRECT' | 'OFFICE'; targetId?: string | null; height?: string; placeholder?: string }>(),
  { height: 'h-[420px]', placeholder: 'Write a message…' },
)

const api = useApi()
const auth = useAuthStore()
const { on, joinDocument } = useRealtime()
const messages = ref<Message[]>([])
const draft = ref('')
const loading = ref(true)
const sending = ref(false)
const scroller = ref<HTMLElement | null>(null)
const ui = useUiStore()

const path = computed(() => {
  if (props.kind === 'DOCUMENT') return `/messages/${props.targetId}`
  if (props.kind === 'DIRECT') return `/messages/direct/${props.targetId}`
  return '/messages/office'
})

function belongsHere(m: Message) {
  if (m.thread_type !== props.kind) return false
  if (props.kind === 'DOCUMENT') return m.document_id === props.targetId
  if (props.kind === 'OFFICE') return m.office_id === auth.user?.office?.id
  const me = auth.user?.id
  return (m.sender_id === me && m.recipient_id === props.targetId) || (m.sender_id === props.targetId && m.recipient_id === me)
}

async function scrollToEnd() {
  await nextTick()
  scroller.value?.scrollTo({ top: scroller.value.scrollHeight })
}

async function load() {
  loading.value = true
  try {
    messages.value = (await api.get<{ data: Message[] }>(path.value)).data
    scrollToEnd()
  } catch (err) {
    ui.error('Could not load messages', apiErrorMessage(err))
  } finally {
    loading.value = false
  }
}

async function send() {
  const body = draft.value.trim()
  if (!body || sending.value) return
  sending.value = true
  try {
    const payload: Record<string, unknown> = { thread_type: props.kind, body }
    if (props.kind === 'DOCUMENT') payload.document_id = props.targetId
    if (props.kind === 'DIRECT') payload.recipient_id = props.targetId
    const { message } = await api.post<{ message: Message }>('/messages', payload)
    // The socket echo may arrive first; avoid duplicates.
    if (!messages.value.some((m) => m.id === message.id)) messages.value.push(message)
    draft.value = ''
    scrollToEnd()
  } catch (err) {
    ui.error('Message not sent', apiErrorMessage(err))
  } finally {
    sending.value = false
  }
}

function onEnter(e: KeyboardEvent) {
  if (!e.shiftKey) {
    e.preventDefault()
    send()
  }
}

on<Message>('message', (m) => {
  if (belongsHere(m) && !messages.value.some((x) => x.id === m.id)) {
    messages.value.push(m)
    scrollToEnd()
  }
})

// Messages are live and per-viewer, so they load in the browser rather than during SSR.
watch(() => [props.kind, props.targetId], load)
onMounted(() => {
  load()
  if (props.kind === 'DOCUMENT' && props.targetId) joinDocument(props.targetId)
})

const isMine = (m: Message) => m.sender_id === auth.user?.id
const showHeader = (i: number) => i === 0 || messages.value[i - 1]!.sender_id !== messages.value[i]!.sender_id
</script>

<template>
  <div class="flex flex-col">
    <div ref="scroller" class="flex-1 space-y-1 overflow-y-auto pr-1" :class="height">
      <div v-if="loading" class="space-y-4 py-4" role="status" aria-label="Loading messages">
        <div v-for="i in 4" :key="i" class="flex items-end gap-2.5" :class="i % 2 === 0 && 'flex-row-reverse'">
          <div class="skeleton size-8 shrink-0 rounded-full" />
          <div class="skeleton h-10 rounded-2xl" :style="{ width: `${40 + (i % 3) * 15}%` }" />
        </div>
      </div>
      <EmptyState v-else-if="!messages.length" icon="message-circle" title="No messages yet" description="Start the conversation." />
      <div v-for="(m, i) in messages" :key="m.id" class="flex gap-2.5" :class="[isMine(m) ? 'flex-row-reverse' : '', showHeader(i) ? 'pt-3' : '']">
        <UserAvatar v-if="showHeader(i) && !isMine(m)" :user="m.sender" size="sm" />
        <span v-else-if="!isMine(m)" class="w-7 shrink-0" />
        <div class="flex max-w-[78%] flex-col" :class="isMine(m) ? 'items-end' : 'items-start'">
          <p v-if="showHeader(i)" class="mb-1 text-[11px] text-ink-2">
            <template v-if="!isMine(m)">{{ fullName(m.sender) }} · </template>{{ formatTime(m.created_at) }}
          </p>
          <p
            class="rounded-2xl px-3.5 py-2 text-[14px] leading-relaxed break-words whitespace-pre-wrap"
            :class="isMine(m) ? 'rounded-br-md bg-terracotta text-white' : 'rounded-bl-md bg-card text-ink shadow-sm ring-1 ring-line/60'"
          >
            {{ m.body }}
          </p>
        </div>
      </div>
    </div>
    <form class="mt-3 flex items-end gap-2" @submit.prevent="send">
      <label class="sr-only" for="composer">Message</label>
      <textarea
        id="composer"
        v-model="draft"
        rows="1"
        class="input max-h-32 min-h-12 resize-none py-3"
        :placeholder="placeholder"
        @keydown.enter="onEnter"
      />
      <button class="btn btn-primary size-12 shrink-0 px-0" :disabled="!draft.trim() || sending" aria-label="Send">
        <FIcon name="send" :size="18" />
      </button>
    </form>
  </div>
</template>
