<script setup lang="ts">
import type { LiaisonProfile } from '~/types'

useHead({ title: 'Pickups · FlowVision' })

const api = useApi()
const auth = useAuthStore()
const docsApi = useDocuments()
const { busy, run } = useAction()

const [{ data: dash, refresh: r1 }, { data: pickups, refresh: r2 }, { data: carrying, refresh: r3 }] = await Promise.all([
  useAsyncData('liaison-dash', () =>
    api.get<{ profile: LiaisonProfile; counts: { available_pickups: number; carrying: number; delivered_today: number } }>('/dashboard'),
  ),
  useAsyncData('liaison-pickups', () => docsApi.list({ scope: 'pickups', limit: 100 })),
  useAsyncData('liaison-carrying', () => docsApi.list({ scope: 'carrying', limit: 100 })),
])
const refreshAll = () => Promise.all([r1(), r2(), r3()])
useLiveRefresh(refreshAll)

// On duty / off duty is the messenger's switch; "busy" is shown while they have a document to pick up or deliver.
const AVAILABILITY = [
  { value: 'AVAILABLE', label: 'On duty', tone: 'success' },
  { value: 'OFF_DUTY', label: 'Off duty', tone: 'neutral' },
] as const
const onDuty = computed(() => dash.value?.profile.availability !== 'OFF_DUTY')
const isSelected = (value: string) => (value === 'OFF_DUTY' ? !onDuty.value : onDuty.value)

async function setAvailability(value: LiaisonProfile['availability']) {
  if (isSelected(value)) return
  if (await run('avail', () => api.patch('/liaisons/me', { availability: value }), value === 'OFF_DUTY' ? "You're off duty" : "You're on duty")) r1()
}

async function startTransit(id: string) {
  if (await run(`transit-${id}`, () => docsApi.startTransit(id), 'Marked in transit')) refreshAll()
}
</script>

<template>
  <div class="fv-rise">
    <PageHeader eyebrow="D1 · Liaison" :title="`Hi, ${auth.user?.first_name}`" description="Documents released to you. Scan a document's QR at the office to pick it up, then bring it to the office shown; their staff scan it to receive it from you.">
      <template #actions>
        <NuxtLink to="/scan" class="btn btn-primary"><FIcon name="maximize" :size="16" /> Scan QR</NuxtLink>
      </template>
    </PageHeader>

    <div class="mb-6 flex flex-wrap items-center gap-3">
      <div class="flex w-fit max-w-full gap-1 overflow-x-auto rounded-xl bg-ink/[0.04] p-1" role="radiogroup" aria-label="Availability">
        <button
          v-for="a in AVAILABILITY"
          :key="a.value"
          role="radio"
          :aria-checked="isSelected(a.value)"
          class="tab"
          :class="isSelected(a.value) && 'tab-active'"
          :disabled="busy === 'avail'"
          @click="setAvailability(a.value)"
        >
          <span class="size-2 rounded-full" :class="TONE_DOT[a.tone]" /> {{ a.label }}
        </button>
      </div>
      <ToneBadge v-if="dash?.profile.availability === 'BUSY'" tone="warning" icon="truck">Busy — offices can't give you another document until this one is received</ToneBadge>
    </div>

    <section class="grid grid-cols-3 gap-3 sm:gap-4">
      <StatCard label="To pick up" :value="dash?.counts.available_pickups ?? 0" icon="package" tone="primary" />
      <StatCard label="Carrying" :value="dash?.counts.carrying ?? 0" icon="truck" tone="info" />
      <StatCard label="Delivered today" :value="dash?.counts.delivered_today ?? 0" icon="check-circle" tone="success" to="/liaison/tracking" />
    </section>

    <section v-if="carrying?.data.length" class="mt-8">
      <h2 class="mb-3 text-lg">Carrying now</h2>
      <div class="grid grid-cols-1 gap-3 lg:grid-cols-2">
        <DocumentCard v-for="d in carrying.data" :key="d.id" :doc="d">
          <template #actions>
            <ToneBadge tone="info" icon="map-pin">Bring to {{ d.next_office_name }} — staff there scan to receive</ToneBadge>
            <button v-if="d.status === 'PICKED_UP'" class="btn btn-sm btn-secondary" :disabled="busy === `transit-${d.id}`" @click="startTransit(d.id)">
              <FIcon name="navigation" :size="14" /> Start transit
            </button>
          </template>
        </DocumentCard>
      </div>
    </section>

    <section class="mt-8">
      <h2 class="mb-3 text-lg">Released to you</h2>
      <div v-if="!pickups?.data.length" class="card">
        <EmptyState icon="coffee" title="No pickups right now" description="You'll get a notification the moment an office releases a document to you." />
      </div>
      <div v-else class="grid grid-cols-1 gap-3 lg:grid-cols-2">
        <DocumentCard v-for="d in pickups.data" :key="d.id" :doc="d">
          <template #actions>
            <span class="inline-flex items-center gap-1.5 text-[13px] text-ink-body">
              <FIcon name="map-pin" :size="14" /> {{ d.currentOffice?.code ?? d.origin?.name }}
              <FIcon name="arrow-right" :size="14" class="text-ink-3" /> {{ d.next_office_name }}
            </span>
            <NuxtLink to="/scan" class="btn btn-sm btn-primary ml-auto"><FIcon name="maximize" :size="14" /> Scan to pick up</NuxtLink>
          </template>
        </DocumentCard>
      </div>
    </section>
  </div>
</template>
