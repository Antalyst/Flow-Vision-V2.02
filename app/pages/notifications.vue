<script setup lang="ts">
import type { AppNotification } from '~/types'

useHead({ title: 'Notifications · FlowVision' })

const notifications = useNotificationsStore()
// The list is loaded by the route middleware; refresh it when the page is opened.
onMounted(() => notifications.load().catch(() => {}))

const ICONS: Record<string, string> = {
  DOCUMENT_INCOMING: 'inbox',
  DOCUMENT_RECEIVED: 'check',
  DOCUMENT_PASSED: 'users',
  PICKUP_REQUESTED: 'package',
  DOCUMENT_PICKED_UP: 'truck',
  DOCUMENT_ARRIVED: 'map-pin',
  DELIVERY_CONFIRMED: 'check-circle',
  PICKUP_CANCELLED: 'x-circle',
  DELIVERY_FAILED: 'alert-triangle',
  APPROVAL_REQUESTED: 'clock',
  DOCUMENT_COMPLETED: 'award',
  DOCUMENT_RETURNED: 'corner-up-left',
  DOCUMENT_SENT_BACK: 'flag',
  ISSUE_REPORTED: 'flag',
  ISSUE_ASSIGNED: 'flag',
}

// Grouped by day (Philippine time); each row shows its exact time.
const dayKey = (iso: string) => new Intl.DateTimeFormat('en-CA', { timeZone: TIME_ZONE }).format(new Date(iso))
const dayFmt = new Intl.DateTimeFormat('en-PH', { weekday: 'long', month: 'long', day: 'numeric', year: 'numeric', timeZone: TIME_ZONE })
const groups = computed(() => {
  const today = dayKey(new Date().toISOString())
  const yesterday = dayKey(new Date(Date.now() - 86_400_000).toISOString())
  const out: Array<{ key: string; label: string; items: AppNotification[] }> = []
  for (const n of notifications.items) {
    const key = n.created_at ? dayKey(n.created_at) : 'unknown'
    if (out.at(-1)?.key !== key) {
      const label = key === today ? 'Today' : key === yesterday ? 'Yesterday' : n.created_at ? dayFmt.format(new Date(n.created_at)) : 'Earlier'
      out.push({ key, label, items: [] })
    }
    out.at(-1)!.items.push(n)
  }
  return out
})

async function open(n: AppNotification) {
  notifications.markRead(n)
  if (n.link) await navigateTo(n.link)
}
</script>

<template>
  <div class="fv-rise mx-auto max-w-3xl">
    <PageHeader eyebrow="Collaborate" title="Notifications" :description="notifications.unread ? `${notifications.unread} unread` : 'You are all caught up.'">
      <template #actions>
        <button v-if="notifications.unread" class="btn btn-ghost" @click="notifications.markAllRead()"><FIcon name="check-circle" :size="16" /> Mark all read</button>
      </template>
    </PageHeader>

    <div v-if="!notifications.items.length" class="card">
      <EmptyState icon="bell" title="No notifications" description="You'll hear about documents arriving, pickups, approvals and issues here." />
    </div>
    <template v-else>
    <section v-for="g in groups" :key="g.key" class="mb-5">
    <h2 class="eyebrow mb-2 px-1">{{ g.label }}</h2>
    <ul class="card divide-y divide-line/60 overflow-hidden">
      <li v-for="n in g.items" :key="n.id">
        <button class="flex w-full items-start gap-4 px-5 py-4 text-left transition-colors hover:bg-ink/[0.025]" @click="open(n)">
          <span class="grid size-9 shrink-0 place-items-center rounded-full" :class="n.is_read ? 'bg-ink/[0.05] text-ink-2' : 'bg-terracotta/12 text-terracotta-ink'">
            <FIcon :name="ICONS[n.type] ?? 'bell'" :size="16" />
          </span>
          <span class="min-w-0 flex-1">
            <span class="block text-sm" :class="n.is_read ? 'text-ink-body' : 'font-semibold'">{{ n.title }}</span>
            <span v-if="n.body" class="mt-0.5 block text-[13px] text-ink-2">{{ n.body }}</span>
          </span>
          <span class="flex shrink-0 items-center gap-2">
            <time class="text-right text-xs text-ink-2" :datetime="n.created_at" :title="formatDateTime(n.created_at)">
              <span class="block font-medium text-ink-body">{{ formatTime(n.created_at) }}</span>
              <span class="block">{{ timeAgo(n.created_at) }}</span>
            </time>
            <span v-if="!n.is_read" class="size-2 rounded-full bg-terracotta" aria-label="Unread" />
          </span>
        </button>
      </li>
    </ul>
    </section>
    </template>
  </div>
</template>
