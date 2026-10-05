<script setup lang="ts">
import type { FlowDocument } from '~/types'

useHead({ title: 'Office queue · FlowVision' })

const route = useRoute()
const router = useRouter()
const docsApi = useDocuments()
const auth = useAuthStore()
const { busy, run } = useAction()

type TabKey = 'incoming' | 'arrived' | 'process' | 'pickup' | 'outbound'
const TABS: Array<{ key: TabKey; label: string; icon: string; empty: string }> = [
  { key: 'incoming', label: 'Incoming', icon: 'navigation', empty: 'Nothing is on its way to your office.' },
  { key: 'arrived', label: 'To receive', icon: 'inbox', empty: 'Nothing is waiting to be scanned in.' },
  { key: 'process', label: 'In process', icon: 'edit-3', empty: 'Nothing received and waiting to be released.' },
  { key: 'pickup', label: 'Awaiting pickup', icon: 'package', empty: 'Nothing is waiting for a messenger.' },
  { key: 'outbound', label: 'Outbound', icon: 'send', empty: 'Nothing has left your office recently.' },
]
const tab = ref<TabKey>((TABS.find((t) => t.key === route.query.tab)?.key ?? 'arrived') as TabKey)
watch(tab, (t) => router.replace({ query: { tab: t } }))

const [{ data: atOffice, refresh: r1 }, { data: incoming, refresh: r2 }] = await Promise.all([
  useAsyncData('queue-office', () => docsApi.list({ scope: 'office', limit: 100 })),
  useAsyncData('queue-incoming', () => docsApi.list({ scope: 'incoming', limit: 100 })),
])
const refreshAll = () => Promise.all([r1(), r2()])
useLiveRefresh(refreshAll)

const buckets = computed<Record<TabKey, FlowDocument[]>>(() => {
  const here = atOffice.value?.data ?? []
  const waiting = here.filter((d) => d.status === 'START' || d.status === 'ARRIVED_AT_OFFICE')
  return {
    incoming: incoming.value?.data ?? [],
    arrived: waiting.filter((d) => !d.received_at),
    process: waiting.filter((d) => d.received_at && !d.pickup_requested_at),
    pickup: waiting.filter((d) => d.pickup_requested_at),
    outbound: here.filter((d) => d.status === 'PICKED_UP' || d.status === 'IN_TRANSIT'),
  }
})

const pickupDoc = ref<FlowDocument | null>(null)

async function cancelPickup(d: FlowDocument) {
  if (await run(`cancel-${d.id}`, () => docsApi.cancelPickup(d.id), 'Release cancelled — the messenger was told')) refreshAll()
}
</script>

<template>
  <div class="fv-rise">
    <PageHeader eyebrow="B2 · Queue" title="Office queue" description="Scan in what arrives, then release it to a free messenger for the next office on the Document Route." />

    <div class="mb-5 flex gap-1 overflow-x-auto rounded-xl bg-ink/[0.04] p-1" role="tablist">
      <button
        v-for="t in TABS"
        :key="t.key"
        role="tab"
        :aria-selected="tab === t.key"
        class="tab shrink-0"
        :class="tab === t.key && 'tab-active'"
        @click="tab = t.key"
      >
        <FIcon :name="t.icon" :size="15" />
        {{ t.label }}
        <span class="rounded-full px-1.5 text-xs" :class="buckets[t.key].length ? 'bg-terracotta text-white' : 'text-ink-2'">{{ buckets[t.key].length }}</span>
      </button>
    </div>

    <div v-if="!buckets[tab].length" class="card">
      <EmptyState :icon="TABS.find((t) => t.key === tab)!.icon" title="All clear" :description="TABS.find((t) => t.key === tab)!.empty" />
    </div>

    <div v-else class="grid grid-cols-1 gap-3 lg:grid-cols-2">
      <DocumentCard v-for="d in buckets[tab]" :key="d.id" :doc="d" show-submitter>
        <template #actions>
          <template v-if="tab === 'arrived'">
            <NuxtLink to="/scan" class="btn btn-sm btn-primary"><FIcon name="maximize" :size="14" /> Scan to receive</NuxtLink>
          </template>
          <template v-else-if="tab === 'process'">
            <template v-if="d.next_office_name">
              <button v-if="releasesDocument(d, auth.user?.id)" class="btn btn-sm btn-primary" @click="pickupDoc = d"><FIcon name="truck" :size="14" /> Release → {{ d.next_office_name }}</button>
              <ToneBadge v-else tone="info" icon="user">Received by {{ fullName(d.received_by) }} — they release it</ToneBadge>
            </template>
            <NuxtLink v-else :to="`/documents/${d.id}#approval`" class="btn btn-sm btn-success"><FIcon name="check-square" :size="14" /> Last office — review &amp; approve</NuxtLink>
          </template>
          <template v-else-if="tab === 'pickup'">
            <ToneBadge tone="warning" icon="user">Waiting for {{ fullName(d.liaison) }}</ToneBadge>
            <button v-if="releasesDocument(d, auth.user?.id)" class="btn btn-sm btn-ghost" :disabled="busy === `cancel-${d.id}`" @click="cancelPickup(d)">Cancel release</button>
          </template>
          <template v-else-if="tab === 'incoming'">
            <ToneBadge tone="info" icon="truck">{{ fullName(d.liaison) }} · from {{ d.currentOffice?.name ?? d.origin?.name }}</ToneBadge>
            <NuxtLink to="/scan" class="btn btn-sm btn-primary"><FIcon name="maximize" :size="14" /> Scan to receive</NuxtLink>
          </template>
          <NuxtLink :to="`/documents/${d.id}`" class="btn btn-sm btn-ghost ml-auto">Details</NuxtLink>
        </template>
      </DocumentCard>
    </div>

    <RequestPickupModal :open="Boolean(pickupDoc)" :doc="pickupDoc" @close="pickupDoc = null" @requested="refreshAll" />
  </div>
</template>
