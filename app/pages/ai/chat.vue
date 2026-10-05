<script setup lang="ts">
import type { AccountType } from '~/types'
import type { CanvasDoc } from '~/utils/markdown'
import type { Conversation } from '~/stores/assistant'
import CanvasPanel from './components/CanvasPanel.vue'

// A full-screen workspace of its own: no app navigation, just a way back.
definePageMeta({ layout: false })
useHead({ title: 'AI Assistant · FlowVision' })

const auth = useAuthStore()
const assistant = useAssistantStore()
const sidebarOpen = ref(false)

const SUGGESTIONS: Partial<Record<AccountType, Array<{ icon: string; text: string }>>> = {
  CLIENT: [
    { icon: 'sun', text: 'Brief me on what needs my attention today' },
    { icon: 'alert-triangle', text: 'Which documents are overdue, and where are they stuck?' },
    { icon: 'grid', text: 'Make a report of all pending approvals by office' },
    { icon: 'truck', text: 'Which messengers are free right now?' },
  ],
  EMPLOYEE: [
    { icon: 'inbox', text: 'What documents are at my office right now?' },
    { icon: 'alert-triangle', text: 'Which of our documents are overdue?' },
    { icon: 'grid', text: 'Make a table of documents routed through my office this week' },
    { icon: 'users', text: 'Who works in my office?' },
  ],
  STAFF: [
    { icon: 'check-square', text: 'What approvals are waiting for me?' },
    { icon: 'map-pin', text: 'Where are the documents I uploaded?' },
    { icon: 'file-text', text: 'Summarize my returned documents and their remarks' },
    { icon: 'book-open', text: 'What do our policies say about travel orders?' },
  ],
}
const suggestions = computed(() => (auth.role ? (SUGGESTIONS[auth.role] ?? []) : []))

const SCOPE_HINT: Partial<Record<AccountType, string>> = {
  CLIENT: 'Sees the whole organization',
  EMPLOYEE: 'Sees your office only',
  STAFF: 'Sees your documents and approvals',
}

const greeting = computed(() => {
  const h = localHour()
  return `${h < 12 ? 'Good morning' : h < 18 ? 'Good afternoon' : 'Good evening'}, ${auth.user?.first_name ?? 'there'}`
})

// ---------------------------------------------------------------------------
// Conversation list, grouped by day (Philippine time)
// ---------------------------------------------------------------------------

const dayKey = (d: Date) => new Intl.DateTimeFormat('en-CA', { timeZone: TIME_ZONE }).format(d)
const groups = computed(() => {
  const today = dayKey(new Date())
  const yesterday = dayKey(new Date(Date.now() - 86_400_000))
  const weekAgo = Date.now() - 7 * 86_400_000
  const out: Array<{ label: string; items: Conversation[] }> = []
  for (const c of assistant.sorted) {
    const at = new Date(c.updatedAt)
    const key = dayKey(at)
    const label = key === today ? 'Today' : key === yesterday ? 'Yesterday' : at.getTime() > weekAgo ? 'Previous 7 days' : 'Older'
    if (out.at(-1)?.label !== label) out.push({ label, items: [] })
    out.at(-1)!.items.push(c)
  }
  return out
})

function openConversation(id: string) {
  assistant.select(id)
  sidebarOpen.value = false
  nextTick(() => scrollToBottom(false))
}

function newConversation() {
  assistant.startNew()
  draft.value = ''
  sidebarOpen.value = false
  nextTick(() => input.value?.focus())
}

function removeConversation(c: Conversation) {
  if (window.confirm(`Delete "${c.title}"? This can't be undone.`)) assistant.remove(c.id)
}

// ---------------------------------------------------------------------------
// Thread
// ---------------------------------------------------------------------------

const thread = computed(() =>
  assistant.messages.map((m) => ({ ...m, segments: m.role === 'assistant' && !m.error ? splitCanvas(m.content, m.id) : null })),
)

function canvasMeta(c: CanvasDoc) {
  const rows = parseMarkdown(c.content).reduce((n, b) => n + (b.type === 'table' ? b.rows.length : 0), 0)
  return c.type === 'table' ? `Table · ${rows} row${rows === 1 ? '' : 's'}` : 'Document'
}

function retry(errorId: string) {
  const i = assistant.messages.findIndex((x) => x.id === errorId)
  const question = assistant.messages[i - 1]
  if (question?.role === 'user') assistant.retry(question.id)
}

// ---------------------------------------------------------------------------
// Composer
// ---------------------------------------------------------------------------

const draft = ref('')
const input = ref<HTMLTextAreaElement>()
const scroller = ref<HTMLElement>()

function autosize() {
  const el = input.value
  if (!el) return
  el.style.height = 'auto'
  el.style.height = `${Math.min(el.scrollHeight, 220)}px`
}
watch(draft, () => nextTick(autosize))

function submit(text = draft.value) {
  if (!text.trim() || assistant.pending) return
  draft.value = ''
  assistant.send(text)
  nextTick(() => input.value?.focus())
}

function onKeydown(e: KeyboardEvent) {
  if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) {
    e.preventDefault()
    submit()
  }
}

const scrollToBottom = (smooth = true) => scroller.value?.scrollTo({ top: scroller.value.scrollHeight, behavior: smooth ? 'smooth' : 'auto' })
watch(
  () => [assistant.messages.length, assistant.liveTools.length, assistant.pendingHere],
  () => nextTick(() => scrollToBottom()),
)

// ---------------------------------------------------------------------------
// Model failover status
// ---------------------------------------------------------------------------

const modelsOpen = ref(false)
const modelMenu = ref<HTMLElement>()
const currentModel = computed(() => assistant.models?.models.find((m) => m.id === assistant.models?.current) ?? null)
function toggleModels() {
  modelsOpen.value = !modelsOpen.value
  if (modelsOpen.value) assistant.refreshModels()
}
function onDocClick(e: MouseEvent) {
  if (modelsOpen.value && !modelMenu.value?.contains(e.target as Node)) modelsOpen.value = false
}
onMounted(() => document.addEventListener('click', onDocClick))
onBeforeUnmount(() => document.removeEventListener('click', onDocClick))

onMounted(() => {
  assistant.load()
  assistant.refreshModels()
  nextTick(() => input.value?.focus())
})
</script>

<template>
  <div class="relative flex h-dvh overflow-hidden bg-cream">
    <div class="fv-ambient" aria-hidden="true" />

    <!-- Drawer overlay (mobile) -->
    <Transition enter-active-class="transition-opacity duration-200" enter-from-class="opacity-0" leave-active-class="transition-opacity duration-150" leave-to-class="opacity-0">
      <div v-if="sidebarOpen" class="fixed inset-0 z-40 bg-night/40 lg:hidden" @click="sidebarOpen = false" />
    </Transition>

    <!-- Conversations -->
    <aside
      class="fixed inset-y-0 left-0 z-50 flex w-[288px] flex-col bg-night text-night-text transition-transform duration-300 ease-out lg:static lg:translate-x-0"
      :class="sidebarOpen ? 'translate-x-0' : '-translate-x-full'"
      aria-label="Conversations"
    >
      <div class="flex items-center gap-2 px-3 pt-4 pb-3">
        <NuxtLink
          :to="auth.homePath"
          class="flex min-h-10 flex-1 items-center gap-2 rounded-xl px-3 text-[13.5px] text-night-text-2 transition-colors hover:bg-white/[0.05] hover:text-night-text"
        >
          <FIcon name="arrow-left" :size="17" /> Back to FlowVision
        </NuxtLink>
        <button class="grid size-10 place-items-center rounded-xl text-night-text-2 hover:bg-white/5 lg:hidden" aria-label="Close conversations" @click="sidebarOpen = false">
          <FIcon name="x" :size="18" />
        </button>
      </div>

      <div class="px-3 pb-3">
        <button
          class="flex min-h-11 w-full items-center gap-2.5 rounded-xl bg-white/[0.08] px-3.5 text-[14px] font-medium text-white transition-colors hover:bg-white/[0.12] disabled:opacity-50"
          @click="newConversation"
        >
          <FIcon name="edit" :size="16" class="text-terracotta" /> New chat
        </button>
      </div>

      <nav class="flex-1 overflow-y-auto px-3 pb-4">
        <p v-if="!groups.length" class="px-3 pt-4 text-[13px] leading-relaxed text-night-text-2">
          Your conversations will appear here. They stay in this browser and are cleared when you sign out.
        </p>
        <div v-for="g in groups" :key="g.label" class="mt-3 first:mt-1">
          <p class="px-3 pb-1.5 text-[10.5px] font-semibold tracking-[0.14em] text-night-text-2/80 uppercase">{{ g.label }}</p>
          <ul class="space-y-0.5">
            <li v-for="c in g.items" :key="c.id" class="group relative">
              <button
                class="flex min-h-10 w-full items-center gap-2 rounded-xl py-2 pr-10 pl-3 text-left text-[13.5px] transition-colors"
                :class="c.id === assistant.activeId ? 'bg-white/[0.08] text-white' : 'text-night-text-2 hover:bg-white/[0.04] hover:text-night-text'"
                :aria-current="c.id === assistant.activeId ? 'page' : undefined"
                @click="openConversation(c.id)"
              >
                <FIcon v-if="c.id === assistant.pendingId" name="loader" :size="14" class="shrink-0 animate-spin" />
                <span class="truncate">{{ c.title }}</span>
              </button>
              <button
                class="absolute top-1/2 right-1.5 grid size-8 -translate-y-1/2 place-items-center rounded-lg text-night-text-2 opacity-0 transition-opacity group-hover:opacity-100 hover:bg-white/10 hover:text-white focus-visible:opacity-100"
                :aria-label="`Delete ${c.title}`"
                title="Delete conversation"
                @click.stop="removeConversation(c)"
              >
                <FIcon name="trash-2" :size="14" />
              </button>
            </li>
          </ul>
        </div>
      </nav>

      <!-- Who the assistant is answering for -->
      <div class="border-t border-white/[0.06] p-3">
        <div class="flex items-center gap-3 rounded-xl p-2">
          <UserAvatar :user="auth.user" dark />
          <span class="min-w-0 flex-1">
            <span class="block truncate text-sm font-medium">{{ fullName(auth.user) }}</span>
            <span class="flex items-center gap-1.5 truncate text-xs text-night-text-2">
              <span class="size-1.5 shrink-0 rounded-full" :class="auth.role ? TONE_DOT[ROLE_META[auth.role].tone] : ''" />
              {{ auth.role && ROLE_META[auth.role].label }} · {{ auth.user?.office?.name ?? auth.user?.organization?.name }}
            </span>
          </span>
        </div>
        <p class="mt-1 flex items-center gap-1.5 px-2 text-[11.5px] text-night-text-2">
          <FIcon name="shield" :size="12" /> {{ auth.role ? SCOPE_HINT[auth.role] : '' }}
        </p>
      </div>
    </aside>

    <!-- Workspace -->
    <main class="relative z-10 flex min-w-0 flex-1 flex-col">
      <header class="flex h-14 shrink-0 items-center gap-2 border-b border-line/60 px-3 sm:px-5">
        <button class="grid size-10 place-items-center rounded-xl hover:bg-ink/5 lg:hidden" aria-label="Open conversations" @click="sidebarOpen = true">
          <FIcon name="menu" :size="19" />
        </button>
        <NuxtLink :to="auth.homePath" class="grid size-10 place-items-center rounded-xl hover:bg-ink/5 lg:hidden" aria-label="Back to FlowVision">
          <FIcon name="arrow-left" :size="18" />
        </NuxtLink>
        <div class="flex min-w-0 flex-1 items-center gap-2">
          <span class="grid size-7 shrink-0 place-items-center overflow-hidden rounded-lg border border-line bg-white"><img src="~/assets/logo/icon.png" alt="" class="size-6" /></span>
          <h1 class="truncate text-[15px] font-semibold tracking-tight">{{ assistant.active?.title ?? 'FlowVision Assistant' }}</h1>
        </div>
        <div ref="modelMenu" class="relative">
          <button class="btn btn-sm btn-ghost" :aria-expanded="modelsOpen" aria-haspopup="true" title="AI model (switches automatically)" @click="toggleModels">
            <span class="size-1.5 rounded-full" :class="currentModel ? 'bg-sage' : 'bg-amber'" />
            <span class="hidden sm:inline">Auto ·</span> {{ currentModel?.label ?? 'Models' }}
            <FIcon name="chevron-down" :size="14" class="text-ink-2" />
          </button>
          <div v-if="modelsOpen" class="absolute top-full right-0 z-30 mt-2 w-[300px] rounded-2xl border border-line bg-white p-2 shadow-lift" role="menu">
            <p class="px-2.5 pt-1.5 pb-2 text-xs leading-relaxed text-ink-2">
              Free Groq models, in order. When one reaches its free limit or is unavailable, the next one answers automatically.
            </p>
            <ul class="space-y-0.5">
              <li v-for="(m, i) in assistant.models?.models ?? []" :key="m.id" class="flex items-center gap-2.5 rounded-xl px-2.5 py-2 text-[13px]" :class="m.id === assistant.models?.current && 'bg-ink/[0.04]'">
                <span class="mono w-4 text-ink-3">{{ i + 1 }}</span>
                <span class="min-w-0 flex-1">
                  <span class="block truncate font-medium text-ink">{{ m.label }}</span>
                  <span class="mono block truncate text-[11px] text-ink-3">{{ m.id }}</span>
                </span>
                <span v-if="m.status === 'resting'" class="badge bg-amber/20 text-amber-ink" :title="'Free limit reached; back at ' + formatTime(m.until)">Back {{ formatTime(m.until) }}</span>
                <span v-else-if="m.id === assistant.models?.current" class="badge bg-sage/15 text-sage-ink">In use</span>
                <span v-else class="badge bg-ink/[0.05] text-ink-2">Ready</span>
              </li>
              <li v-if="!assistant.models?.models.length" class="px-2.5 py-2 text-[13px] text-ink-2">No models found for this API key.</li>
            </ul>
          </div>
        </div>
        <button v-if="assistant.canvases.length" class="btn btn-sm btn-ghost" @click="assistant.openCanvas(assistant.activeCanvasId ?? assistant.canvases.at(-1)!.id)">
          <FIcon name="layout" :size="15" /> <span class="hidden sm:inline">Canvases</span> <span class="text-ink-2">{{ assistant.canvases.length }}</span>
        </button>
        <button class="btn btn-sm btn-ghost px-2.5 lg:hidden" aria-label="New chat" @click="newConversation">
          <FIcon name="edit" :size="15" />
        </button>
      </header>

      <!-- Messages -->
      <div ref="scroller" class="min-h-0 flex-1 overflow-y-auto" aria-live="polite">
        <div class="mx-auto w-full max-w-3xl px-4 py-8 sm:px-6">
          <!-- Empty state -->
          <div v-if="!assistant.messages.length" class="flex min-h-[calc(100dvh-16rem)] flex-col justify-center">
            <span class="mb-5 grid size-14 place-items-center overflow-hidden rounded-2xl border border-line bg-white shadow-soft">
              <img src="~/assets/logo/icon.png" alt="FlowVision" class="size-12" />
            </span>
            <h2 class="text-[26px] sm:text-[32px]">{{ greeting }}.</h2>
            <p class="mt-2 max-w-xl text-[15px] text-ink-body">
              I'm your organization's assistant. I read live FlowVision data — documents, routes, approvals, people and your knowledge files — and can turn it into reports you can export to Word, Excel or PDF.
            </p>
            <div class="mt-7 grid gap-2 sm:grid-cols-2">
              <button
                v-for="s in suggestions"
                :key="s.text"
                class="group flex items-start gap-3 rounded-2xl border border-line bg-white/60 p-3.5 text-left text-sm text-ink-body transition-colors hover:border-ink/25 hover:bg-white"
                :disabled="assistant.pending"
                @click="submit(s.text)"
              >
                <FIcon :name="s.icon" :size="16" class="mt-0.5 text-ink-2 group-hover:text-terracotta" />
                <span>{{ s.text }}</span>
              </button>
            </div>
          </div>

          <ol v-else class="space-y-7">
            <li v-for="m in thread" :key="m.id">
              <!-- User -->
              <div v-if="m.role === 'user'" class="flex justify-end">
                <p class="max-w-[85%] rounded-3xl rounded-br-lg bg-ink px-4 py-3 text-[14.5px] whitespace-pre-wrap text-white" :class="m.failed && 'opacity-60'">{{ m.content }}</p>
              </div>

              <!-- Assistant -->
              <div v-else class="flex gap-3">
                <span v-if="m.error" class="mt-0.5 grid size-8 shrink-0 place-items-center rounded-full" :class="TONE_CLASSES.danger">
                  <FIcon name="alert-triangle" :size="14" />
                </span>
                <span v-else class="mt-0.5 grid size-8 shrink-0 place-items-center overflow-hidden rounded-full border border-line bg-white">
                  <img src="~/assets/logo/icon.png" alt="" class="size-7" />
                </span>
                <div class="min-w-0 flex-1 space-y-3">
                  <div v-if="m.error" class="flex flex-wrap items-center gap-3 rounded-2xl bg-danger/10 px-4 py-3 text-sm text-danger-ink">
                    <span class="flex-1">{{ m.content }}</span>
                    <button class="btn btn-sm btn-ghost" :disabled="assistant.pending" @click="retry(m.id)"><FIcon name="rotate-cw" :size="14" /> Try again</button>
                  </div>

                  <template v-else>
                    <ul v-if="m.tools?.length || m.model" class="flex flex-wrap gap-1.5" aria-label="How this answer was made">
                      <li v-for="(t, i) in m.tools" :key="i" class="badge bg-ink/[0.05] font-medium text-ink-2">
                        <FIcon :name="t.ok === false ? 'alert-circle' : 'check'" :size="12" :class="t.ok === false ? 'text-danger' : 'text-sage'" />
                        {{ t.label }}<template v-if="t.summary"> · {{ t.summary }}</template>
                      </li>
                      <li v-if="m.model" class="badge bg-transparent font-medium text-ink-3" :title="'Answered by ' + m.model"><FIcon name="cpu" :size="12" /> {{ m.model }}</li>
                    </ul>

                    <template v-for="(s, si) in m.segments" :key="si">
                      <div v-if="s.kind === 'text'" class="fv-prose" v-html="renderMarkdown(s.text)" />
                      <button
                        v-else
                        class="flex w-full max-w-md items-center gap-3 rounded-2xl border bg-white/70 p-3 text-left transition-colors hover:border-ink/25 hover:bg-white"
                        :class="assistant.canvasOpen && assistant.activeCanvasId === s.canvas.id ? 'border-ink/40' : 'border-line'"
                        @click="assistant.openCanvas(s.canvas.id)"
                      >
                        <span class="grid size-10 shrink-0 place-items-center rounded-xl" :class="s.canvas.type === 'table' ? TONE_CLASSES.info : TONE_CLASSES.primary">
                          <FIcon :name="s.canvas.type === 'table' ? 'grid' : 'file-text'" :size="17" />
                        </span>
                        <span class="min-w-0 flex-1">
                          <span class="block truncate text-sm font-semibold text-ink">{{ s.canvas.title }}</span>
                          <span class="block text-xs text-ink-2">{{ canvasMeta(s.canvas) }} · Open to view and export</span>
                        </span>
                        <FIcon name="chevron-right" :size="16" class="text-ink-2" />
                      </button>
                    </template>
                  </template>
                </div>
              </div>
            </li>

            <!-- Working: live tool status -->
            <li v-if="assistant.pendingHere" class="flex gap-3">
              <span class="mt-0.5 grid size-8 shrink-0 place-items-center overflow-hidden rounded-full border border-line bg-white">
                <img src="~/assets/logo/icon.png" alt="" class="fv-thinking size-7" />
              </span>
              <div class="min-w-0 flex-1 space-y-2 pt-1">
                <ul v-if="assistant.liveTools.length" class="space-y-1.5">
                  <li v-for="t in assistant.liveTools" :key="t.id" class="flex items-center gap-2 text-[13px] text-ink-body">
                    <FIcon :name="t.done ? (t.ok === false ? 'alert-circle' : 'check-circle') : 'loader'" :size="14" :class="t.done ? (t.ok === false ? 'text-danger' : 'text-sage') : 'animate-spin text-ink-2'" />
                    {{ t.label }}<span v-if="t.summary" class="text-ink-2"> · {{ t.summary }}</span>
                  </li>
                </ul>
                <p class="flex items-center gap-2 text-[13px] text-ink-2">
                  <span class="flex gap-1" aria-hidden="true">
                    <span class="size-1.5 animate-bounce rounded-full bg-ink-3" />
                    <span class="size-1.5 animate-bounce rounded-full bg-ink-3 [animation-delay:150ms]" />
                    <span class="size-1.5 animate-bounce rounded-full bg-ink-3 [animation-delay:300ms]" />
                  </span>
                  {{ assistant.liveTools.length && assistant.liveTools.every((t) => t.done) ? 'Writing the answer…' : 'Thinking…' }}
                </p>
              </div>
            </li>
          </ol>
        </div>
      </div>

      <!-- Composer -->
      <form class="shrink-0 px-4 pt-2 pb-4 sm:px-6" @submit.prevent="submit()">
        <div class="mx-auto flex max-w-3xl items-end gap-2 rounded-[1.75rem] border border-line bg-white p-2 pl-5 shadow-soft transition-colors focus-within:border-terracotta focus-within:ring-4 focus-within:ring-terracotta/12">
          <textarea
            ref="input"
            v-model="draft"
            rows="1"
            maxlength="4000"
            class="max-h-[220px] min-h-10 flex-1 resize-none bg-transparent py-2.5 text-[15px] text-ink placeholder:text-ink-3 focus:outline-none"
            placeholder="Ask about documents, approvals, people or policies…"
            aria-label="Message the assistant"
            @keydown="onKeydown"
          />
          <button
            type="submit"
            class="grid size-10 shrink-0 place-items-center rounded-full bg-ink text-white transition-opacity hover:bg-[#2B2B2F] disabled:opacity-35"
            :disabled="!draft.trim() || assistant.pending"
            aria-label="Send"
          >
            <FIcon name="arrow-up" :size="18" />
          </button>
        </div>
        <p class="mx-auto mt-2 max-w-3xl px-2 text-center text-[11.5px] text-ink-2">
          Enter to send · Shift+Enter for a new line · Answers use live data your account may see — check important figures.
        </p>
      </form>
    </main>

    <CanvasPanel :canvases="assistant.canvases" :active-id="assistant.activeCanvasId" :open="assistant.canvasOpen" @close="assistant.canvasOpen = false" @select="assistant.openCanvas" />
  </div>
</template>
