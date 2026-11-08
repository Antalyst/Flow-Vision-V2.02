<script setup lang="ts">
import type { AppNotification } from '~/types'

/**
 * The bell in the header of every signed-in page (layouts/default.vue, and the assistant's own header). The
 * badge is the account's total unread count; the dropdown lists only the latest unread ones (BELL_LIMIT), loaded
 * when it opens. Opening it marks nothing read: only clicking a notification marks that one read (the existing
 * PATCH /notifications/:id/read), then opens its link, as the Notifications page does, or the Notifications page.
 * The store keeps the badge and lists in step across tabs (realtime "notifications:changed").
 */
const props = withDefaults(defineProps<{ align?: 'left' | 'right' }>(), { align: 'right' })
const notifications = useNotificationsStore()
const open = ref(false)
const status = ref<'idle' | 'pending' | 'success' | 'error'>('idle')
const root = ref<HTMLElement | null>(null)
const button = ref<HTMLAnchorElement | null>(null)
const panelId = useId()

const badge = computed(() => (notifications.unread > 99 ? '99+' : String(notifications.unread)))
const label = computed(() => (notifications.unread ? `Notifications, ${notifications.unread} unread` : 'Notifications, none unread'))

async function refresh() {
  status.value = notifications.unreadLoaded ? 'success' : 'pending'
  try {
    await notifications.loadUnread()
    status.value = 'success'
  } catch {
    if (!notifications.unreadLoaded) status.value = 'error'
  }
}

function toggle() {
  open.value = !open.value
  if (open.value) refresh()
}
function close(focusButton = false) {
  open.value = false
  if (focusButton) button.value?.focus()
}

// The notification being marked read: it stays in the list until the server has it, and on failure stays unread.
const busy = ref<AppNotification['id'] | null>(null)
async function pick(n: AppNotification) {
  if (busy.value) return
  busy.value = n.id
  try {
    await notifications.markRead(n)
  } catch (err) {
    useUiStore().error('Couldn’t mark the notification read', apiErrorMessage(err))
    return
  } finally {
    busy.value = null
  }
  close()
  await navigateTo(n.link || '/notifications')
}

function onDocClick(e: MouseEvent) {
  if (open.value && root.value && !root.value.contains(e.target as Node)) close()
}
function onKey(e: KeyboardEvent) {
  if (open.value && e.key === 'Escape') close(true)
}
onMounted(() => {
  document.addEventListener('click', onDocClick, true)
  document.addEventListener('keydown', onKey)
  // The badge needs the total even when the route middleware hasn't loaded the store (the assistant page).
  if (!notifications.loaded && !notifications.unreadLoaded) notifications.loadUnread().catch(() => {})
})
onBeforeUnmount(() => {
  document.removeEventListener('click', onDocClick, true)
  document.removeEventListener('keydown', onKey)
})
const route = useRoute()
watch(() => route.fullPath, () => close())
</script>

<template>
  <div ref="root" class="relative">
    <!--
      A real link to the Notifications page until the app has hydrated (a tap on the server-rendered bell before
      then still goes somewhere, as the bell used to); once hydrated it opens the dropdown instead.
    -->
    <a
      ref="button"
      href="/notifications"
      role="button"
      class="relative grid size-10 place-items-center rounded-lg hover:bg-ink/5 focus-visible:ring-2 focus-visible:ring-terracotta/40 focus-visible:outline-none"
      :aria-label="label"
      aria-haspopup="true"
      :aria-expanded="open"
      :aria-controls="panelId"
      @click.prevent="toggle"
      @keydown.space.prevent="toggle"
    >
      <FIcon name="bell" />
      <span
        v-if="notifications.unread"
        class="absolute -top-0.5 -right-0.5 grid h-5 min-w-5 place-items-center rounded-full bg-terracotta px-1 text-[11px] leading-none font-semibold text-white ring-2 ring-cream"
        aria-hidden="true"
        >{{ badge }}</span
      >
    </a>

    <div
      v-if="open"
      :id="panelId"
      class="absolute top-full z-50 mt-2 w-[min(360px,calc(100vw-2rem))] overflow-hidden rounded-2xl border border-line bg-white shadow-lift"
      :class="props.align === 'right' ? 'right-0' : 'left-0'"
      role="dialog"
      aria-label="Unread notifications"
    >
      <div class="flex items-center justify-between gap-2 border-b border-line/60 px-4 py-3">
        <p class="text-sm font-semibold">Notifications</p>
        <span class="text-xs text-ink-2">{{ notifications.unread ? `${notifications.unread} unread` : 'All caught up' }}</span>
      </div>

      <div v-if="status === 'pending'" class="space-y-3 p-4" role="status" aria-label="Loading notifications">
        <div v-for="i in 3" :key="i"><div class="skeleton h-3.5 w-3/4" /><div class="skeleton mt-2 h-3 w-1/2" /></div>
      </div>
      <div v-else-if="status === 'error'" class="flex items-center justify-between gap-3 p-4 text-sm text-danger-ink" role="alert">
        Couldn’t load notifications.
        <button class="btn btn-sm btn-ghost" @click="refresh()">Try again</button>
      </div>
      <p v-else-if="!notifications.latestUnread.length" class="px-4 py-8 text-center text-sm text-ink-2">No new notifications</p>
      <ul v-else class="max-h-[min(420px,60vh)] divide-y divide-line/60 overflow-y-auto">
        <li v-for="n in notifications.latestUnread" :key="n.id">
          <button
            type="button"
            class="flex w-full items-start gap-3 px-4 py-3 text-left hover:bg-ink/[0.03] focus-visible:bg-ink/[0.04] focus-visible:outline-none disabled:opacity-60"
            :disabled="busy === n.id"
            :aria-busy="busy === n.id"
            @click="pick(n)"
          >
            <span class="mt-1.5 size-2 shrink-0 rounded-full bg-terracotta" aria-hidden="true" />
            <span class="min-w-0 flex-1">
              <span class="block truncate text-sm font-semibold">{{ n.title }}</span>
              <span v-if="n.body" class="mt-0.5 line-clamp-2 block text-[13px] text-ink-2">{{ n.body }}</span>
              <time class="mt-1 block text-xs text-ink-3" :datetime="n.created_at" :title="formatDateTime(n.created_at)">{{ timeAgo(n.created_at) }}</time>
            </span>
            <span class="sr-only">Unread. Opens the notification and marks it read.</span>
          </button>
        </li>
      </ul>

      <div class="border-t border-line/60 p-2">
        <NuxtLink to="/notifications" class="btn btn-sm btn-ghost w-full justify-center" @click="close()">View All Notifications</NuxtLink>
      </div>
    </div>
  </div>
</template>
