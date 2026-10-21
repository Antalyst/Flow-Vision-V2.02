<script setup lang="ts">
import type { FlowDocument, Message, UserSummary } from '~/types'

useHead({ title: 'Messages · FlowVision' })

interface Threads {
  direct: Array<{ user: UserSummary; last_message: Message | null; unread: number }>
  documents: Array<{ document: Pick<FlowDocument, 'id' | 'tracking_number' | 'title' | 'status'>; last_message: Message | null }>
  office: { id: string; name: string; last_message: Message | null } | null
}
type Active = { kind: 'OFFICE'; id: string; title: string } | { kind: 'DIRECT'; id: string; title: string; user: UserSummary } | { kind: 'DOCUMENT'; id: string; title: string }

const api = useApi()
const auth = useAuthStore()
const route = useRoute()
const { on } = useRealtime()

const { data, refresh, status, error } = await useAsyncData('message-threads', () => api.get<Threads>('/messages/threads'), { lazy: true })
const active = ref<Active | null>(null)

const timeOf = (m: Message | null | undefined) => (m ? Date.parse(m.created_at) : 0)
const newestFirst = <T extends { last_message: Message | null }>(rows: T[]) => rows.sort((a, b) => timeOf(b.last_message) - timeOf(a.last_message))

/**
 * Put a new message into the conversation list right away — its preview, its time and its place at
 * the top — without waiting for a reload. Used for messages sent here and messages received live.
 */
function applyMessage(m: Message) {
  const threads = data.value
  if (!threads) return
  const me = auth.user?.id
  if (m.thread_type === 'OFFICE') {
    if (threads.office && timeOf(m) >= timeOf(threads.office.last_message)) threads.office.last_message = m
    return
  }
  if (m.thread_type === 'DOCUMENT') {
    const row = threads.documents.find((d) => d.document.id === m.document_id)
    if (!row) return scheduleRefresh() // a thread not listed yet: the server knows its title
    if (timeOf(m) >= timeOf(row.last_message)) row.last_message = m
    newestFirst(threads.documents)
    return
  }
  const partnerId = m.sender_id === me ? m.recipient_id : m.sender_id
  if (!partnerId) return
  let row = threads.direct.find((d) => d.user.id === partnerId)
  if (!row) {
    // A first message in a new conversation: the partner is the sender, or the person open here.
    const partner = m.sender_id === me ? (active.value?.kind === 'DIRECT' && active.value.id === partnerId ? active.value.user : null) : (m.sender ?? null)
    if (!partner) return scheduleRefresh()
    row = { user: partner, last_message: null, unread: 0 }
    threads.direct.unshift(row)
  }
  if (timeOf(m) >= timeOf(row.last_message)) row.last_message = m
  const reading = active.value?.kind === 'DIRECT' && active.value.id === partnerId
  if (m.sender_id !== me && !reading) row.unread += 1
  newestFirst(threads.direct)
}

// Reconcile with the server shortly after live changes (unread counts, threads not listed yet).
let refreshTimer: ReturnType<typeof setTimeout> | undefined
function scheduleRefresh() {
  clearTimeout(refreshTimer)
  refreshTimer = setTimeout(() => refresh(), 1500)
}
on<Message>('message', (m) => {
  applyMessage(m)
  scheduleRefresh()
})
// Hosts without live sockets (e.g. serverless) still catch up: a quiet reload while the tab is visible.
let poll: ReturnType<typeof setInterval> | undefined
onMounted(() => {
  poll = setInterval(() => {
    if (!document.hidden && status.value !== 'pending') refresh()
  }, 30_000)
})
onBeforeUnmount(() => {
  clearInterval(poll)
  clearTimeout(refreshTimer)
})

function openDirect(user: UserSummary) {
  active.value = { kind: 'DIRECT', id: user.id, title: fullName(user), user }
  const row = data.value?.direct.find((d) => d.user.id === user.id)
  if (row) row.unread = 0
}

// Open the conversation asked for in the link (or the office channel on wide screens) once the list is here.
const opened = ref(false)
function openInitial() {
  if (opened.value || !data.value) return
  opened.value = true
  if (typeof route.query.user === 'string') {
    const row = data.value.direct.find((d) => d.user.id === route.query.user)
    if (row) openDirect(row.user)
  } else if (data.value.office && window.matchMedia('(min-width: 1024px)').matches) {
    active.value = { kind: 'OFFICE', id: data.value.office.id, title: data.value.office.name }
  }
}
onMounted(() => {
  openInitial()
  watch(data, openInitial)
})

// New conversation
const pickerOpen = ref(false)
const people = ref<UserSummary[]>([])
const search = ref('')
const peopleLoading = ref(false)
const peopleError = ref<string | null>(null)
async function openPicker() {
  pickerOpen.value = true
  search.value = ''
  if (people.value.length || peopleLoading.value) return
  peopleLoading.value = true
  peopleError.value = null
  try {
    people.value = (await api.get<{ data: UserSummary[] }>('/users')).data.filter((u) => u.id !== auth.user?.id)
  } catch (err) {
    peopleError.value = apiErrorMessage(err, 'Could not load the people in your organization')
  } finally {
    peopleLoading.value = false
  }
}
const filteredPeople = computed(() => people.value.filter((p) => !search.value || fullName(p).toLowerCase().includes(search.value.toLowerCase())))

const preview = (m?: Message | null) => (m ? `${m.sender_id === auth.user?.id ? 'You: ' : ''}${m.body}` : '')
</script>

<template>
  <div class="fv-rise">
    <PageHeader eyebrow="B4 · Messages" title="Messages" description="Talk to your team directly, in your office channel, or on a document's thread.">
      <template #actions>
        <button class="btn btn-primary" @click="openPicker"><FIcon name="edit" :size="16" /> New message</button>
      </template>
    </PageHeader>

    <div class="grid grid-cols-1 gap-6 lg:grid-cols-[320px_minmax(0,1fr)]">
      <aside class="card overflow-hidden" :class="active && 'hidden lg:block'" :aria-busy="status === 'pending'">
        <!-- First load: rows shaped like conversations -->
        <div v-if="status === 'pending' && !data" class="space-y-1 p-2" role="status" aria-label="Loading conversations">
          <div v-for="i in 6" :key="i" class="flex items-center gap-3 rounded-xl p-3" aria-hidden="true">
            <div class="skeleton size-9 shrink-0 rounded-full" />
            <div class="flex-1 space-y-2">
              <div class="flex justify-between gap-2"><div class="skeleton h-3.5 w-2/5" /><div class="skeleton h-3 w-10" /></div>
              <div class="skeleton h-3" :style="{ width: `${70 - (i % 3) * 15}%` }" />
            </div>
          </div>
        </div>
        <div v-else-if="error && !data" class="p-4 text-sm text-danger-ink" role="alert">
          {{ apiErrorMessage(error, 'Could not load your conversations') }}
          <button class="btn btn-sm btn-ghost mt-2" @click="refresh()"><FIcon name="refresh-cw" :size="14" /> Try again</button>
        </div>
        <template v-else>
        <div v-if="data?.office" class="border-b border-line/60 p-2">
          <button
            class="flex w-full items-center gap-3 rounded-xl p-3 text-left"
            :class="active?.kind === 'OFFICE' ? 'bg-terracotta/[0.07]' : 'hover:bg-ink/[0.03]'"
            @click="active = { kind: 'OFFICE', id: data.office.id, title: data.office.name }"
          >
            <span class="grid size-9 shrink-0 place-items-center rounded-full bg-terracotta/12 text-terracotta-ink"><FIcon name="hash" :size="16" /></span>
            <span class="min-w-0 flex-1">
              <span class="flex items-center justify-between gap-2">
                <span class="truncate text-sm font-semibold">Office channel</span>
                <RelativeTime class="shrink-0 text-[11px] text-ink-2" :value="data.office.last_message?.created_at" />
              </span>
              <span class="block truncate text-xs text-ink-2">{{ data.office.last_message ? preview(data.office.last_message) : data.office.name }}</span>
            </span>
          </button>
        </div>

        <p class="eyebrow px-5 pt-4 pb-2">Direct</p>
        <p v-if="!data?.direct.length" class="px-5 pb-4 text-sm text-ink-2">No conversations yet.</p>
        <ul class="px-2">
          <li v-for="t in data?.direct" :key="t.user.id">
            <button
              class="flex w-full items-center gap-3 rounded-xl p-3 text-left"
              :class="active?.kind === 'DIRECT' && active.id === t.user.id ? 'bg-terracotta/[0.07]' : 'hover:bg-ink/[0.03]'"
              @click="openDirect(t.user)"
            >
              <UserAvatar :user="t.user" />
              <span class="min-w-0 flex-1">
                <span class="flex items-center justify-between gap-2">
                  <span class="truncate text-sm font-semibold">{{ fullName(t.user) }}</span>
                  <RelativeTime class="shrink-0 text-[11px] text-ink-2" :value="t.last_message?.created_at" />
                </span>
                <span class="block truncate text-xs" :class="t.unread ? 'font-semibold text-ink' : 'text-ink-2'">{{ preview(t.last_message) }}</span>
              </span>
              <span v-if="t.unread" class="grid size-5 place-items-center rounded-full bg-terracotta text-[10px] font-bold text-white">{{ t.unread }}</span>
            </button>
          </li>
        </ul>

        <template v-if="data?.documents.length">
          <p class="eyebrow px-5 pt-4 pb-2">Document threads</p>
          <ul class="px-2 pb-2">
            <li v-for="t in data.documents" :key="t.document.id">
              <button
                class="flex w-full items-center gap-3 rounded-xl p-3 text-left"
                :class="active?.kind === 'DOCUMENT' && active.id === t.document.id ? 'bg-terracotta/[0.07]' : 'hover:bg-ink/[0.03]'"
                @click="active = { kind: 'DOCUMENT', id: t.document.id, title: t.document.title }"
              >
                <span class="grid size-9 shrink-0 place-items-center rounded-full bg-info/12 text-info-ink"><FIcon name="file-text" :size="16" /></span>
                <span class="min-w-0 flex-1">
                  <span class="flex items-center justify-between gap-2">
                    <span class="truncate text-sm font-semibold">{{ t.document.title }}</span>
                    <RelativeTime class="shrink-0 text-[11px] text-ink-2" :value="t.last_message?.created_at" />
                  </span>
                  <span class="block truncate text-xs text-ink-2">{{ preview(t.last_message) }}</span>
                </span>
              </button>
            </li>
          </ul>
        </template>
        </template>
      </aside>

      <section class="card card-pad" :class="!active && 'hidden lg:block'">
        <EmptyState v-if="!active" icon="message-circle" title="Pick a conversation" description="Or start a new one with anyone in your organization." />
        <template v-else>
          <div class="mb-4 flex items-center gap-3 border-b border-line/60 pb-4">
            <button class="grid size-9 place-items-center rounded-lg hover:bg-ink/5 lg:hidden" aria-label="Back to conversations" @click="active = null">
              <FIcon name="arrow-left" :size="18" />
            </button>
            <UserAvatar v-if="active.kind === 'DIRECT'" :user="active.user" />
            <div class="min-w-0 flex-1">
              <p class="truncate font-display font-semibold">{{ active.title }}</p>
              <p class="text-xs text-ink-2">
                {{ active.kind === 'OFFICE' ? 'Everyone at your office' : active.kind === 'DOCUMENT' ? 'Document thread' : roleMeta(active.user.account_type).label }}
              </p>
            </div>
            <NuxtLink v-if="active.kind === 'DOCUMENT'" :to="`/documents/${active.id}`" class="btn btn-sm btn-ghost">Open document</NuxtLink>
          </div>
          <MessageThread :key="`${active.kind}-${active.id}`" :kind="active.kind" :target-id="active.id" height="h-[calc(100dvh-420px)] min-h-[320px]" @sent="applyMessage" />
        </template>
      </section>
    </div>

    <AppModal :open="pickerOpen" title="New message" width="sm" @close="pickerOpen = false">
      <div class="relative mb-3">
        <FIcon name="search" :size="16" class="absolute top-1/2 left-3.5 -translate-y-1/2 text-ink-2" />
        <input v-model="search" class="input pl-10" placeholder="Search people" aria-label="Search people" />
      </div>
      <p v-if="peopleLoading" class="flex items-center gap-2 px-2.5 py-3 text-sm text-ink-2"><span class="spinner" /> Loading people…</p>
      <div v-else-if="peopleError" class="rounded-xl bg-danger/10 px-3 py-3 text-sm text-danger-ink">
        {{ peopleError }}
        <button class="btn btn-sm btn-ghost mt-2" @click="openPicker">Try again</button>
      </div>
      <p v-else-if="!filteredPeople.length" class="px-2.5 py-3 text-sm text-ink-2">{{ search ? 'Nobody matches that name.' : 'There is nobody else in your organization yet.' }}</p>
      <ul class="max-h-80 space-y-1 overflow-y-auto">
        <li v-for="p in filteredPeople" :key="p.id">
          <button class="flex w-full items-center gap-3 rounded-xl p-2.5 text-left hover:bg-ink/[0.04]" @click="openDirect(p); pickerOpen = false">
            <UserAvatar :user="p" size="sm" />
            <span class="min-w-0 flex-1">
              <span class="block truncate text-sm font-medium">{{ fullName(p) }}</span>
              <span class="block truncate text-xs text-ink-2">{{ roleMeta(p.account_type).label }}<template v-if="p.office"> · {{ p.office.name }}</template></span>
            </span>
          </button>
        </li>
      </ul>
    </AppModal>
  </div>
</template>
