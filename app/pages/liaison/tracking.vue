<script setup lang="ts">
import type { FlowDocument, LiaisonProfile, TrackingEvent } from '~/types'

useHead({ title: 'My deliveries · FlowVision' })

interface LiaisonMe {
  profile: LiaisonProfile
  carrying: FlowDocument[]
  activity: TrackingEvent[]
  today: { pickups: number; deliveries: number; failed: number }
}

const api = useApi()
const docsApi = useDocuments()
const { busy, run } = useAction()

const range = ref<'today' | '7d' | '30d'>('today')
const since = computed(() => {
  if (range.value === 'today') return undefined
  const d = new Date()
  d.setDate(d.getDate() - (range.value === '7d' ? 7 : 30))
  return d.toISOString()
})
const { data, refresh } = await useAsyncData('liaison-me', () => api.get<LiaisonMe>('/liaisons/me', { since: since.value }), { watch: [range] })
useLiveRefresh(refresh)

const failDoc = ref<FlowDocument | null>(null)
const failRemarks = ref('')
async function reportFailure() {
  if (!failDoc.value || !failRemarks.value.trim()) return
  const ok = await run('fail', () => docsApi.failDelivery(failDoc.value!.id, failRemarks.value.trim()), 'Reported — the document returns to its origin office')
  if (ok) {
    failDoc.value = null
    failRemarks.value = ''
    refresh()
  }
}

const rangeLabel = computed(() => ({ today: 'Today', '7d': 'Last 7 days', '30d': 'Last 30 days' })[range.value])
</script>

<template>
  <div class="fv-rise">
    <PageHeader eyebrow="D3 · Performance" title="My deliveries" description="What you're carrying, what you've delivered, and how you're tracking." />

    <template v-if="data">
      <section class="grid grid-cols-2 gap-3 sm:gap-4 lg:grid-cols-4">
        <StatCard label="Success rate" :value="`${data.profile.success_rate}%`" icon="target" :tone="data.profile.success_rate >= 95 ? 'success' : data.profile.success_rate >= 80 ? 'warning' : 'danger'" />
        <StatCard label="Avg delivery time" :value="formatDuration(data.profile.avg_delivery_minutes)" icon="clock" tone="info" hint="Pickup → delivery" />
        <StatCard label="Total trips" :value="data.profile.total_deliveries" icon="truck" tone="primary" :hint="`${data.profile.successful_deliveries} delivered`" />
        <StatCard label="Failed" :value="data.profile.failed_deliveries" icon="alert-triangle" :tone="data.profile.failed_deliveries ? 'danger' : 'neutral'" />
      </section>

      <section v-if="data.carrying.length" class="mt-8">
        <h2 class="mb-3 text-lg">Carrying now</h2>
        <div class="grid grid-cols-1 gap-3 lg:grid-cols-2">
          <DocumentCard v-for="d in data.carrying" :key="d.id" :doc="d">
            <template #actions>
              <ToneBadge tone="info" icon="map-pin">Bring to {{ d.next_office_name }} — staff there scan to receive</ToneBadge>
              <button class="btn btn-sm btn-danger ml-auto" @click="failDoc = d"><FIcon name="alert-triangle" :size="14" /> Can't deliver</button>
            </template>
          </DocumentCard>
        </div>
      </section>

      <section class="card card-pad mt-8">
        <div class="mb-5 flex flex-wrap items-center justify-between gap-3">
          <div>
            <h2 class="text-lg">Activity · {{ rangeLabel }}</h2>
            <p class="mt-1 text-sm text-ink-body" v-if="range === 'today'">
              {{ data.today.pickups }} pickups · {{ data.today.deliveries }} deliveries<template v-if="data.today.failed"> · {{ data.today.failed }} failed</template>
            </p>
          </div>
          <div class="flex gap-1 rounded-xl bg-ink/[0.04] p-1" role="tablist">
            <button v-for="r in ['today', '7d', '30d'] as const" :key="r" class="tab" :class="range === r && 'tab-active'" role="tab" :aria-selected="range === r" @click="range = r">
              {{ r === 'today' ? 'Today' : r === '7d' ? '7 days' : '30 days' }}
            </button>
          </div>
        </div>
        <EmptyState v-if="!data.activity.length" icon="activity" title="No activity yet" description="Pickups and deliveries you scan will show up here." />
        <ul v-else class="divide-y divide-line/60">
          <li v-for="e in data.activity" :key="e.id" class="flex items-center gap-3 py-3">
            <span
              class="grid size-9 shrink-0 place-items-center rounded-full"
              :class="e.event_type === 'ARRIVED' ? TONE_CLASSES.success : e.event_type === 'DELIVERY_FAILED' ? TONE_CLASSES.danger : TONE_CLASSES.info"
            >
              <FIcon :name="e.event_type === 'ARRIVED' ? 'map-pin' : e.event_type === 'DELIVERY_FAILED' ? 'alert-triangle' : 'package'" :size="16" />
            </span>
            <div class="min-w-0 flex-1">
              <NuxtLink v-if="e.document" :to="`/documents/${e.document.id}`" class="block truncate text-sm font-medium hover:text-terracotta-ink">{{ e.document.title }}</NuxtLink>
              <p class="truncate text-xs text-ink-2">
                {{ EVENT_LABELS[e.event_type] }} · {{ e.office?.name }}
                <template v-if="e.metadata && typeof e.metadata.delivery_minutes === 'number'"> · {{ formatDuration(e.metadata.delivery_minutes as number) }}</template>
              </p>
            </div>
            <time class="mono shrink-0 text-ink-2">{{ range === 'today' ? formatTime(e.created_at) : formatDateTime(e.created_at) }}</time>
          </li>
        </ul>
      </section>
    </template>

    <AppModal :open="Boolean(failDoc)" title="Report failed delivery" :description="failDoc ? `${failDoc.tracking_number} goes back to ${failDoc.currentOffice?.name ?? failDoc.origin?.name}.` : undefined" width="sm" @close="failDoc = null">
      <label class="field-label" for="fail">What happened?</label>
      <textarea id="fail" v-model="failRemarks" rows="3" class="input" placeholder="e.g. Receiving office closed" maxlength="2000" />
      <template #footer>
        <button class="btn btn-ghost" @click="failDoc = null">Cancel</button>
        <button class="btn btn-danger" :disabled="!failRemarks.trim() || busy === 'fail'" @click="reportFailure">Report failure</button>
      </template>
    </AppModal>
  </div>
</template>
