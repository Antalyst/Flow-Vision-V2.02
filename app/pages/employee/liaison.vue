<script setup lang="ts">
import type { FlowDocument, LiaisonProfile } from '~/types'

useHead({ title: 'Release to messenger · FlowVision' })

interface LiaisonRow extends LiaisonProfile {
  user: { id: string; first_name: string; last_name: string; phone: string | null; office?: { name: string; department_name: string } | null }
}

const api = useApi()
const docsApi = useDocuments()
const auth = useAuthStore()

const [{ data: docs, refresh: refreshDocs }, { data: liaisonData, refresh: refreshLiaisons }] = await Promise.all([
  useAsyncData('liaison-page-docs', () => docsApi.list({ scope: 'office', limit: 100 })),
  useAsyncData('liaison-page-liaisons', () => api.get<{ data: LiaisonRow[] }>('/liaisons')),
])
useLiveRefresh(() => Promise.all([refreshDocs(), refreshLiaisons()]))

const atOffice = computed(() => (docs.value?.data ?? []).filter((d) => ['START', 'ARRIVED_AT_OFFICE'].includes(d.status)))
const ready = computed(() => atOffice.value.filter((d) => d.received_at && !d.pickup_requested_at && d.next_office_name))
const open = computed(() => atOffice.value.filter((d) => d.pickup_requested_at))

const q = ref('')
const onlyAvailable = ref(false)
const liaisons = computed(() =>
  (liaisonData.value?.data ?? []).filter(
    (l) =>
      (!onlyAvailable.value || l.availability === 'AVAILABLE') &&
      (!q.value || `${l.user.first_name} ${l.user.last_name}`.toLowerCase().includes(q.value.toLowerCase())),
  ),
)
const availabilityTone = { AVAILABLE: 'success', BUSY: 'warning', OFF_DUTY: 'neutral' } as const

const pickupDoc = ref<FlowDocument | null>(null)
</script>

<template>
  <div class="fv-rise">
    <PageHeader eyebrow="B3 · Dispatch" title="Release to a messenger" description="Pick a received document and release it to a free messenger. They and the next office are notified; the messenger scans its QR label to pick it up." />

    <div class="grid grid-cols-1 gap-6 lg:grid-cols-[minmax(0,1fr)_380px]">
      <div class="space-y-6">
        <section>
          <h2 class="mb-3 text-lg">Ready to route <span class="text-ink-2">{{ ready.length }}</span></h2>
          <div v-if="!ready.length" class="card">
            <EmptyState icon="package" title="Nothing ready" description="Documents appear here once your office has scanned them in.">
              <NuxtLink to="/employee/queue?tab=arrived" class="btn btn-sm btn-ghost">Check arrivals</NuxtLink>
            </EmptyState>
          </div>
          <div v-else class="grid grid-cols-1 gap-3">
            <DocumentCard v-for="d in ready" :key="d.id" :doc="d">
              <template #actions>
                <button class="btn btn-sm btn-primary" @click="pickupDoc = d"><FIcon name="truck" :size="14" /> Release → {{ d.next_office_name }}</button>
              </template>
            </DocumentCard>
          </div>
        </section>

        <section v-if="open.length">
          <h2 class="mb-3 text-lg">Waiting for pickup <span class="text-ink-2">{{ open.length }}</span></h2>
          <div class="grid grid-cols-1 gap-3">
            <DocumentCard v-for="d in open" :key="d.id" :doc="d">
              <template #actions>
                <ToneBadge tone="info" icon="user">Released to {{ fullName(d.liaison) }}</ToneBadge>
                <NuxtLink :to="`/documents/${d.id}`" class="btn btn-sm btn-ghost ml-auto"><FIcon name="printer" :size="14" /> QR label</NuxtLink>
              </template>
            </DocumentCard>
          </div>
        </section>
      </div>

      <aside class="card card-pad h-fit lg:sticky lg:top-8">
        <h2 class="text-lg">Messengers</h2>
        <p class="mt-1 text-sm text-ink-body">Free messengers are listed first. A messenger who has a document to pick up or deliver is busy until it is received.</p>
        <div class="relative mt-4">
          <FIcon name="search" :size="16" class="absolute top-1/2 left-3.5 -translate-y-1/2 text-ink-2" />
          <input v-model="q" class="input pl-10" placeholder="Search messengers" aria-label="Search messengers" />
        </div>
        <label class="mt-3 flex items-center gap-2 text-sm text-ink-body">
          <input v-model="onlyAvailable" type="checkbox" class="size-4 accent-[var(--lumio-accent-primary)]" /> Free now only
        </label>
        <ul class="mt-4 space-y-2">
          <li v-if="!liaisons.length" class="py-6 text-center text-sm text-ink-2">No messengers found.</li>
          <li v-for="l in liaisons" :key="l.id" class="rounded-xl border border-line/70 p-3">
            <div class="flex items-center gap-3">
              <UserAvatar :user="l.user" />
              <div class="min-w-0 flex-1">
                <p class="truncate text-sm font-semibold">{{ fullName(l.user) }}</p>
                <p class="truncate text-xs text-ink-2">{{ l.user.office?.department_name }}</p>
              </div>
              <ToneBadge :tone="availabilityTone[l.availability]" dot>{{ { AVAILABLE: 'free', BUSY: 'busy', OFF_DUTY: 'off duty' }[l.availability] }}</ToneBadge>
            </div>
            <dl class="mt-3 grid grid-cols-3 gap-2 text-center">
              <div class="rounded-lg bg-ink/[0.03] py-1.5"><dt class="text-[10px] text-ink-2 uppercase">Success</dt><dd class="mono font-semibold">{{ l.success_rate }}%</dd></div>
              <div class="rounded-lg bg-ink/[0.03] py-1.5"><dt class="text-[10px] text-ink-2 uppercase">Avg</dt><dd class="mono font-semibold">{{ formatDuration(l.avg_delivery_minutes) }}</dd></div>
              <div class="rounded-lg bg-ink/[0.03] py-1.5"><dt class="text-[10px] text-ink-2 uppercase">Trips</dt><dd class="mono font-semibold">{{ l.total_deliveries }}</dd></div>
            </dl>
          </li>
        </ul>
      </aside>
    </div>

    <RequestPickupModal :open="Boolean(pickupDoc)" :doc="pickupDoc" @close="pickupDoc = null" @requested="refreshDocs()" />
  </div>
</template>
