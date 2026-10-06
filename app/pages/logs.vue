<script setup lang="ts">
import type { DocumentStatus, UserSummary } from '~/types'
import type { Tone } from '~/utils/format'

useHead({ title: 'Activity log · FlowVision' })

type Scope = 'mine' | 'office' | 'organization'
type Category = 'all' | 'documents' | 'messengers' | 'approvals' | 'admin'

interface ActivityRow {
  id: string
  event_type: string
  category: Exclude<Category, 'all'>
  created_at: string
  step_number: number | null
  remarks: string | null
  summary: string | null
  actor: UserSummary | null
  office: { id: string | null; name: string; code: string } | null
  messenger: string | null
  previous_messenger: string | null
  received_by: string | null
  next_office: string | null
  document: { id: string; title: string; status: DocumentStatus; tracking_number: string; qr_code: string | null } | null
}
interface ActivityPage {
  data: ActivityRow[]
  next_before: string | null
  scope: Scope
  scopes: Scope[]
}

const api = useApi()
const auth = useAuthStore()

// What each account may see (the server enforces the same rules).
const SCOPE_META: Record<Scope, { label: string; hint: string }> = {
  organization: { label: 'Organization', hint: 'Every action taken on documents and accounts across the organization.' },
  office: { label: 'My office', hint: 'Everything that happened at your office, and everything done by your office’s staff and the messengers you created.' },
  mine: { label: 'My actions', hint: 'Everything you did, with the time you did it.' },
}
const scopes = computed<Scope[]>(() => (auth.role === 'CLIENT' ? ['organization', 'mine'] : auth.role === 'EMPLOYEE' && auth.user?.office ? ['office', 'mine'] : ['mine']))
const scope = ref<Scope>(scopes.value[0]!)
const category = ref<Category>('all')
const days = ref(30)
const q = ref('')
const debouncedQ = refDebounced(q, 300)

const CATEGORIES: Array<{ value: Category; label: string }> = [
  { value: 'all', label: 'All' },
  { value: 'documents', label: 'Documents' },
  { value: 'messengers', label: 'Messengers' },
  { value: 'approvals', label: 'Approvals' },
  { value: 'admin', label: 'Administration' },
]
const RANGES = [
  { value: 1, label: 'Today' },
  { value: 7, label: 'Last 7 days' },
  { value: 30, label: 'Last 30 days' },
  { value: 90, label: 'Last 90 days' },
  { value: 365, label: 'Last year' },
]

const params = computed(() => ({ scope: scope.value, category: category.value, days: days.value, q: debouncedQ.value || undefined, limit: 50 }))
const { data, refresh, status } = await useAsyncData('activity-log', () => api.get<ActivityPage>('/activity', params.value), { watch: [params] })
useLiveRefresh(refresh)

// "Load older" appends pages below the first one.
const older = ref<ActivityRow[]>([])
const nextBefore = ref<string | null>(null)
const loadingMore = ref(false)
watch(data, (page) => {
  older.value = []
  nextBefore.value = page?.next_before ?? null
}, { immediate: true })
async function loadMore() {
  if (!nextBefore.value) return
  loadingMore.value = true
  try {
    const page = await api.get<ActivityPage>('/activity', { ...params.value, before: nextBefore.value })
    older.value.push(...page.data)
    nextBefore.value = page.next_before
  } finally {
    loadingMore.value = false
  }
}
const rows = computed(() => [...(data.value?.data ?? []), ...older.value])

// Grouped by day (Philippine time), newest first.
const dayFmt = new Intl.DateTimeFormat('en-PH', { weekday: 'long', month: 'long', day: 'numeric', year: 'numeric', timeZone: TIME_ZONE })
const groups = computed(() => {
  const out: Array<{ day: string; items: ActivityRow[] }> = []
  for (const r of rows.value) {
    const day = dayFmt.format(new Date(r.created_at))
    if (out.at(-1)?.day !== day) out.push({ day, items: [] })
    out.at(-1)!.items.push(r)
  }
  return out
})

const ADMIN_LABELS: Record<string, string> = {
  USER_INVITE: 'Created an account',
  USER_UPDATE: 'Updated an account',
  USER_PASSWORD_RESET: 'Reset a password',
  PASSWORD_CHANGE: 'Changed their password',
  ORG_REGISTER: 'Registered the organization',
  ORG_UPDATE: 'Updated the organization profile',
  DOCUMENT_TYPE_CREATE: 'Added a document type',
  DOCUMENT_TYPE_UPDATE: 'Updated a document type',
  DOCUMENT_TYPE_DELETE: 'Deleted a document type',
  KNOWLEDGE_UPLOAD: 'Added AI knowledge',
  KNOWLEDGE_UPDATE: 'Updated AI knowledge',
  KNOWLEDGE_DELETE: 'Deleted AI knowledge',
  OFFICE_CREATE: 'Created an office',
  OFFICE_UPDATE: 'Updated an office',
  ROUTE_CREATE: 'Created a Document Route',
  ROUTE_UPDATE: 'Updated a Document Route',
  ROUTE_DELETE: 'Deleted a Document Route',
  ROUTE_RETIRE: 'Retired a Document Route',
  ROUTE_ADD_STEPS: 'Added offices to a route',
  DOCUMENT_UPDATE: 'Edited a draft',
  DOCUMENT_DELETE: 'Deleted a draft',
  ISSUE_CREATE: 'Reported an issue',
  ISSUE_UPDATE: 'Updated an issue',
}
const label = (r: ActivityRow) => ADMIN_LABELS[r.event_type] ?? EVENT_LABELS[r.event_type] ?? r.event_type.replace(/_/g, ' ').toLowerCase()

const STYLE: Record<ActivityRow['category'], { icon: string; tone: Tone }> = {
  documents: { icon: 'file-text', tone: 'primary' },
  messengers: { icon: 'truck', tone: 'info' },
  approvals: { icon: 'check-square', tone: 'success' },
  admin: { icon: 'settings', tone: 'neutral' },
}
const styleOf = (r: ActivityRow) =>
  r.event_type === 'RETURNED' || r.event_type === 'DELIVERY_FAILED' ? { icon: 'alert-triangle', tone: 'danger' as Tone } : STYLE[r.category]

/** The one-line detail under each entry: who else was involved, and where. */
function detail(r: ActivityRow) {
  const bits: string[] = []
  if (r.event_type === 'MESSENGER_REASSIGNED' && r.previous_messenger && r.messenger) bits.push(`${r.previous_messenger} → ${r.messenger}`)
  else if (r.messenger && ['PICKUP_REQUESTED'].includes(r.event_type)) bits.push(`to ${r.messenger}`)
  if (r.next_office && ['PICKUP_REQUESTED', 'MESSENGER_REASSIGNED', 'PICKED_UP'].includes(r.event_type)) bits.push(`for ${r.next_office}`)
  if (r.received_by && r.event_type === 'ARRIVED') bits.push(`received by ${r.received_by}`)
  if (r.office) bits.push(r.office.name === 'Origin' ? 'at the origin' : `at ${r.office.name}`)
  if (r.summary) bits.push(r.summary)
  return bits.join(' · ')
}
const isMe = (r: ActivityRow) => r.actor?.id === auth.user?.id
</script>

<template>
  <div class="fv-rise">
    <PageHeader eyebrow="Accountability" title="Activity log" :description="SCOPE_META[scope].hint" />

    <!-- Whose activity -->
    <div v-if="scopes.length > 1" class="mb-4 flex w-fit max-w-full gap-1 overflow-x-auto rounded-xl bg-ink/[0.04] p-1" role="tablist" aria-label="Whose activity">
      <button v-for="s in scopes" :key="s" role="tab" class="tab shrink-0" :class="scope === s && 'tab-active'" :aria-selected="scope === s" @click="scope = s">
        {{ SCOPE_META[s].label }}
      </button>
    </div>

    <!-- Filters -->
    <div class="mb-5 flex flex-col gap-2 sm:flex-row sm:items-center">
      <div class="relative flex-1">
        <FIcon name="search" :size="16" class="absolute top-1/2 left-3.5 -translate-y-1/2 text-ink-2" />
        <input v-model="q" class="input pl-10" placeholder="Search by document, QR code, person or office" aria-label="Search the activity log" />
      </div>
      <select v-model="category" class="input sm:w-44" aria-label="Kind of activity">
        <option v-for="c in CATEGORIES" :key="c.value" :value="c.value">{{ c.label }}</option>
      </select>
      <select v-model.number="days" class="input sm:w-40" aria-label="Time range">
        <option v-for="r in RANGES" :key="r.value" :value="r.value">{{ r.label }}</option>
      </select>
    </div>

    <PageSkeleton v-if="!rows.length && status === 'pending'" variant="list" :rows="7" :messages="['Loading activity…', 'Reading the audit trail…']" />
    <div v-else-if="!rows.length" class="card">
      <EmptyState
        icon="list"
        :title="status === 'pending' ? 'Loading…' : 'No activity'"
        :description="status === 'pending' ? '' : 'Nothing matches these filters. Try a longer time range.'"
      />
    </div>

    <div v-else class="space-y-6">
      <section v-for="g in groups" :key="g.day">
        <h2 class="eyebrow mb-2 px-1">{{ g.day }}</h2>
        <ol class="card divide-y divide-line/60 overflow-hidden">
          <li v-for="r in g.items" :key="r.id" class="flex gap-3 p-4">
            <span class="grid size-9 shrink-0 place-items-center rounded-full" :class="TONE_CLASSES[styleOf(r).tone]">
              <FIcon :name="styleOf(r).icon" :size="16" />
            </span>
            <div class="min-w-0 flex-1">
              <div class="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-0.5">
                <p class="text-sm">
                  <span class="font-semibold">{{ r.actor ? (isMe(r) ? 'You' : fullName(r.actor)) : 'System' }}</span>
                  <span v-if="r.actor && !isMe(r)" class="text-ink-2"> · {{ ROLE_META[r.actor.account_type]?.label }}</span>
                  <span class="text-ink-body"> — {{ label(r) }}</span>
                </p>
                <time class="mono text-ink-2" :datetime="r.created_at" :title="formatDateTime(r.created_at)">{{ formatTime(r.created_at) }}</time>
              </div>
              <NuxtLink v-if="r.document" :to="`/documents/${r.document.id}`" class="mt-1 flex min-w-0 items-center gap-2 text-sm hover:underline">
                <span class="mono shrink-0 rounded bg-ink/[0.05] px-1.5 py-0.5 text-[12px] text-ink-body">{{ r.document.qr_code ?? r.document.tracking_number }}</span>
                <span class="truncate">{{ r.document.title }}</span>
              </NuxtLink>
              <p v-if="detail(r)" class="mt-1 text-[13px] text-ink-2">{{ detail(r) }}</p>
              <p v-if="r.remarks && r.event_type !== 'MESSENGER_REASSIGNED'" class="mt-2 rounded-xl bg-ink/[0.035] px-3 py-2 text-[13px] text-ink-body">{{ r.remarks }}</p>
            </div>
          </li>
        </ol>
      </section>

      <div v-if="nextBefore" class="flex justify-center">
        <button class="btn btn-ghost" :disabled="loadingMore" :aria-busy="loadingMore" @click="loadMore">{{ loadingMore ? 'Loading…' : 'Load older activity' }}</button>
      </div>
    </div>
  </div>
</template>
