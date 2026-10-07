<script setup lang="ts">
import type { FlowDocument } from '~/types'

useHead({ title: 'Dashboard · FlowVision' })

interface ClientDashboard {
  totals: { active: number; completed: number; returned: number; drafts: number; overdue: number; pending_approvals: number; open_issues: number; offices: number }
  by_status: Record<string, number>
  avg_completion_hours: number | null
  team: Record<string, number>
  routes: number
  recent: FlowDocument[]
}

const api = useApi()
const routesApi = useRoutes()
const auth = useAuthStore()

interface DashboardCards {
  office: { id: string; name: string; code: string } | null
  active: number
  pending_approvals: number
  overdue: number
  completed: { total: number; by_type: Array<{ type: string; count: number; avg_minutes: number | null; target_hours: number }> }
}

// The office picked in the Forecasts filter also scopes the four cards at the top.
const officeId = ref('')

const { data, refresh, status } = await useAsyncData('client-dashboard', () => api.get<ClientDashboard>('/dashboard'))
const { data: cards, refresh: refreshCards } = await useAsyncData(
  'client-dashboard-cards',
  () => api.get<DashboardCards>('/dashboard/cards', { office_id: officeId.value || undefined }),
  { watch: [officeId] },
)
const { data: routeData, refresh: refreshRoutes } = await useAsyncData('client-dashboard-routes', () => routesApi.list())
const forecast = ref<{ refresh: () => unknown }>()
useLiveRefresh(() => {
  refresh()
  refreshCards()
  refreshRoutes()
  forecast.value?.refresh()
})
const officeName = computed(() => cards.value?.office?.name ?? null)

const greeting = computed(() => {
  const h = localHour()
  return h < 12 ? 'Good morning' : h < 18 ? 'Good afternoon' : 'Good evening'
})

const pipeline = computed(() => {
  const s = data.value?.by_status ?? {}
  return [
    { key: 'START', label: 'At first office', count: s.START ?? 0, tone: 'bg-terracotta' },
    { key: 'MOVING', label: 'Moving', count: (s.PICKED_UP ?? 0) + (s.IN_TRANSIT ?? 0), tone: 'bg-info' },
    { key: 'ARRIVED_AT_OFFICE', label: 'At an office', count: s.ARRIVED_AT_OFFICE ?? 0, tone: 'bg-amber' },
    { key: 'COMPLETED', label: 'Completed', count: s.COMPLETED ?? 0, tone: 'bg-sage' },
    { key: 'RETURNED', label: 'Returned', count: s.RETURNED ?? 0, tone: 'bg-danger' },
  ]
})
const pipelineTotal = computed(() => pipeline.value.reduce((n, p) => n + p.count, 0) || 1)
</script>

<template>
  <div class="fv-rise">
    <PageHeader :eyebrow="auth.user?.organization?.name" :title="`${greeting}, ${auth.user?.first_name}`" description="Here's where your organization's documents stand right now.">
      <template #actions>
        <NuxtLink to="/documents/new" class="btn btn-primary"><FIcon name="plus" :size="16" /> Upload document</NuxtLink>
      </template>
    </PageHeader>

    <PageSkeleton v-if="status === 'pending' && !data" variant="dashboard" :messages="['Counting documents…', 'Checking every office…', 'Almost there…']" />

    <template v-else-if="data">
      <!-- No route yet: the one thing to do first -->
      <div v-if="!data.routes" class="card card-pad mb-6 flex flex-col items-start gap-4 border-terracotta/30 sm:flex-row sm:items-center">
        <span class="grid size-12 place-items-center rounded-2xl bg-terracotta/12 text-terracotta-ink"><FIcon name="git-commit" /></span>
        <div class="flex-1">
          <p class="font-display text-base font-semibold">Set up your first Document Route</p>
          <p class="mt-1 text-sm text-ink-body">
            Every document follows a route through your offices — create one per kind of document. {{ data.totals.offices ? 'Arrange your offices into steps to start accepting submissions.' : 'Add your offices first, then arrange them into steps.' }}
          </p>
        </div>
        <NuxtLink :to="data.totals.offices ? '/client/routes' : '/client/offices'" class="btn btn-primary">
          {{ data.totals.offices ? 'Build route' : 'Add offices' }} <FIcon name="arrow-right" :size="16" />
        </NuxtLink>
      </div>

      <div v-if="officeName" class="mb-3 flex flex-wrap items-center gap-2 text-sm text-ink-body">
        <FIcon name="filter" :size="14" class="text-ink-2" />
        Showing <strong class="font-semibold text-ink">{{ officeName }}</strong>
        <span class="text-ink-2">— picked in Forecasts below</span>
        <button type="button" class="btn btn-ghost btn-sm" @click="officeId = ''"><FIcon name="x" :size="14" /> All offices</button>
      </div>

      <section v-if="cards" class="grid grid-cols-2 gap-3 sm:gap-4 lg:grid-cols-4">
        <StatCard
          label="Active documents"
          :value="cards.active"
          icon="activity"
          tone="primary"
          to="/documents"
          :hint="officeName ? `At ${officeName} now` : 'Across all offices'"
        />
        <StatCard
          label="Awaiting approval"
          :value="cards.pending_approvals"
          icon="clock"
          tone="warning"
          :hint="officeName ? `Waiting for ${officeName}'s decision` : 'At the final checkpoint'"
        />
        <CompletedTypesCard :by-type="cards.completed.by_type" :office-name="officeName" />
        <StatCard
          label="Past target date"
          :value="cards.overdue"
          icon="alert-triangle"
          :tone="cards.overdue ? 'danger' : 'neutral'"
          :hint="officeName ? `Late and still at ${officeName}` : 'Late and still in progress'"
        />
      </section>

      <ForecastCarousel ref="forecast" v-model:office="officeId" class="mt-6" />

      <div class="mt-6 grid grid-cols-1 gap-6 lg:grid-cols-[minmax(0,1fr)_340px] lg:items-start">
        <section class="card card-pad">
          <div class="mb-4 flex items-center justify-between">
            <h2 class="text-lg">Recent documents</h2>
            <NuxtLink to="/documents" class="text-sm font-medium text-terracotta-ink hover:underline">View all</NuxtLink>
          </div>
          <EmptyState v-if="!data.recent.length" icon="file-text" title="No documents yet" description="Submitted documents will appear here with their live position on the route.">
            <NuxtLink to="/documents/new" class="btn btn-primary btn-sm">Upload your first document</NuxtLink>
          </EmptyState>
          <ul v-else class="-mx-2 divide-y divide-line/60">
            <li v-for="d in data.recent" :key="d.id">
              <NuxtLink :to="`/documents/${d.id}`" class="flex items-center gap-4 rounded-xl px-2 py-3 hover:bg-ink/[0.025]">
                <div class="min-w-0 flex-1">
                  <p class="truncate text-[14px] font-medium">{{ d.title }}</p>
                  <p class="mt-0.5 truncate text-xs text-ink-2">
                    <span class="mono">{{ d.tracking_number }}</span> · {{ whereabouts(d) }}
                  </p>
                </div>
                <PriorityBadge :priority="d.priority" class="hidden sm:inline-flex" />
                <StatusBadge :status="d.status" />
              </NuxtLink>
            </li>
          </ul>
        </section>

        <div class="space-y-6">
          <section class="card card-pad">
            <h2 class="text-lg">Organization processes</h2>
            <div class="mt-4 flex h-2.5 overflow-hidden rounded-full bg-line/50">
              <div v-for="p in pipeline" :key="p.key" :class="p.tone" :style="{ width: `${(p.count / pipelineTotal) * 100}%` }" />
            </div>
            <ul class="mt-4 space-y-2.5">
              <li v-for="p in pipeline" :key="p.key" class="flex items-center gap-2.5 text-sm">
                <span class="size-2 rounded-full" :class="p.tone" />
                <span class="flex-1 text-ink-body">{{ p.label }}</span>
                <span class="mono font-medium">{{ p.count }}</span>
              </li>
            </ul>
          </section>

          <section v-if="routeData?.data.length" class="card card-pad">
            <div class="flex items-center justify-between">
              <h2 class="text-lg">Document Routes</h2>
              <ToneBadge tone="neutral">{{ routeData.data.length }}</ToneBadge>
            </div>
            <ul class="mt-3 divide-y divide-line/60">
              <li v-for="r in routeData.data" :key="r.id" class="py-3">
                <div class="flex items-center justify-between gap-2">
                  <p class="truncate text-sm font-medium">{{ r.name }}</p>
                  <span class="shrink-0 text-xs text-ink-2">{{ r.steps.length }} step{{ r.steps.length === 1 ? '' : 's' }}</span>
                </div>
                <div class="mt-3"><RouteFlow :steps="r.steps" compact /></div>
              </li>
            </ul>
            <NuxtLink to="/client/routes" class="btn btn-ghost btn-sm mt-1 w-full">Manage routes</NuxtLink>
          </section>

          <section class="card card-pad">
            <h2 class="text-lg">Team</h2>
            <ul class="mt-3 space-y-2">
              <li v-for="(meta, role) in ROLE_META" :key="role" class="flex items-center gap-2.5 text-sm">
                <span class="size-2 rounded-full" :class="TONE_DOT[meta.tone]" />
                <span class="flex-1 text-ink-body">{{ meta.label }}</span>
                <span class="mono font-medium">{{ data.team[role] ?? 0 }}</span>
              </li>
            </ul>
            <NuxtLink to="/client/accounts" class="btn btn-ghost btn-sm mt-4 w-full"><FIcon name="user-plus" :size="15" /> Invite people</NuxtLink>
          </section>
        </div>
      </div>
    </template>
  </div>
</template>
