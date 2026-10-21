<script setup lang="ts">
import type { FlowDocument, LiaisonProfile } from '~/types'

useHead({ title: 'Pickups · FlowVision' })

const api = useApi()
const auth = useAuthStore()
const docsApi = useDocuments()
const { busy, run } = useAction()

const [{ data: dash, refresh: r1, status: s1, error: e1 }, { data: pickups, refresh: r2, status: s2, error: e2 }, { data: carrying, refresh: r3, status: s3, error: e3 }, { data: me, refresh: r4, status: s4, error: e4 }] = await Promise.all([
  useAsyncData('liaison-dash', () => api.get<{ profile: LiaisonProfile; counts: { available_pickups: number; carrying: number; delivered_today: number } }>('/dashboard'), { lazy: true }),
  useAsyncData('liaison-pickups', () => docsApi.list({ scope: 'pickups', limit: 100 }), { lazy: true }),
  useAsyncData('liaison-carrying', () => docsApi.list({ scope: 'carrying', limit: 100 }), { lazy: true }),
  // Flagged documents going back to my office: any of its messengers may claim them.
  useAsyncData('liaison-returns', () => api.get<{ returns: FlowDocument[] }>('/liaisons/me'), { lazy: true }),
])
const pageStatus = computed(() => ([s1, s2, s3, s4].some((s) => s.value === 'pending') ? 'pending' : e1.value || e2.value || e3.value || e4.value ? 'error' : 'success'))
const refreshAll = () => Promise.all([r1(), r2(), r3(), r4()])
const returns = computed(() => me.value?.returns ?? [])

async function claim(d: FlowDocument) {
  const ok = await run(`claim-${d.id}`, () => api.post(`/documents/${d.id}/return-claim`), 'Pickup claimed. It is now under "Released to you"')
  // Lost the race, or it changed meanwhile: show the current state either way.
  refreshAll()
  return ok
}
async function giveUp(d: FlowDocument) {
  if (await run(`unclaim-${d.id}`, () => api.del(`/documents/${d.id}/return-claim`), 'Claim cancelled. Other messengers have been notified')) refreshAll()
}
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
    <PageHeader eyebrow="D1 · Messenger" :title="`Hi, ${auth.user?.first_name}`" description="Documents released to you. Scan the document's QR code at the office to pick it up, then take it to the office shown. Staff there will scan it to receive it.">
      <template #actions>
        <NuxtLink to="/scan" class="btn btn-primary"><FIcon name="maximize" :size="16" /> Scan QR</NuxtLink>
      </template>
    </PageHeader>

    <AsyncState :status="pageStatus" :ready="Boolean(dash && pickups && carrying && me)" :error="e1 || e2 || e3 || e4" variant="dashboard" what="your pickups" :messages="['Loading your pickups…']" @retry="refreshAll()">

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
      <ToneBadge v-if="dash?.profile.availability === 'BUSY'" tone="warning" icon="truck">Busy — you cannot be given another document until this one is received</ToneBadge>
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
            <ToneBadge tone="info" icon="map-pin">Take to {{ d.next_office_name }} — staff there will scan it to receive it</ToneBadge>
            <button v-if="d.status === 'PICKED_UP'" class="btn btn-sm btn-secondary" :disabled="busy === `transit-${d.id}`" :aria-busy="busy === `transit-${d.id}`" @click="startTransit(d.id)">
              <FIcon name="navigation" :size="14" /> Start transit
            </button>
          </template>
        </DocumentCard>
      </div>
    </section>

    <section v-if="returns.length" class="mt-8" aria-labelledby="returns-title">
      <h2 id="returns-title" class="mb-1 text-lg">Returns to pick up</h2>
      <p class="mb-3 text-sm text-ink-body">Documents with issues that are being sent back to your office. Any messenger in your office can take one: claim it, then pick it up.</p>
      <div class="grid grid-cols-1 gap-3 lg:grid-cols-2">
        <DocumentCard v-for="d in returns" :key="d.id" :doc="d">
          <template #actions>
            <span class="inline-flex items-center gap-1.5 text-[13px] text-ink-body">
              <FIcon name="map-pin" :size="14" /> {{ d.currentOffice?.name }}
              <FIcon name="arrow-right" :size="14" class="text-ink-3" /> {{ d.sent_back?.office_name }}
            </span>
            <button class="btn btn-sm btn-primary ml-auto" :disabled="busy === `claim-${d.id}`" :aria-busy="busy === `claim-${d.id}`" @click="claim(d)">
              <FIcon name="corner-down-left" :size="14" /> Claim pickup
            </button>
          </template>
        </DocumentCard>
      </div>
    </section>

    <section class="mt-8">
      <h2 class="mb-3 text-lg">Released to you</h2>
      <div v-if="!pickups?.data.length" class="card">
        <EmptyState icon="coffee" title="No pickups right now" description="You will be notified when an office releases a document to you." />
      </div>
      <div v-else class="grid grid-cols-1 gap-3 lg:grid-cols-2">
        <DocumentCard v-for="d in pickups.data" :key="d.id" :doc="d">
          <template #actions>
            <span class="inline-flex items-center gap-1.5 text-[13px] text-ink-body">
              <FIcon name="map-pin" :size="14" /> {{ d.currentOffice?.code ?? d.origin?.name }}
              <FIcon name="arrow-right" :size="14" class="text-ink-3" /> {{ d.next_office_name }}
            </span>
            <button v-if="d.sent_back" class="btn btn-sm btn-ghost ml-auto" :disabled="busy === `unclaim-${d.id}`" :aria-busy="busy === `unclaim-${d.id}`" @click="giveUp(d)">Cancel claim</button>
            <NuxtLink to="/scan" class="btn btn-sm btn-primary" :class="!d.sent_back && 'ml-auto'"><FIcon name="maximize" :size="14" /> Scan to pick up</NuxtLink>
          </template>
        </DocumentCard>
      </div>
    </section>
    </AsyncState>
  </div>
</template>
