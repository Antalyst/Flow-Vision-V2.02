<script setup lang="ts">
/**
 * Office performance, monitoring only, with the definitions of server/lib/office-performance.ts:
 *   mode="department"    a main office's Department Head dashboard: the department (main office + its umbrella
 *                        offices). Shown only when the account's scope has umbrella offices.
 *   mode="organization"  the ADMIN dashboard: every main office and umbrella office of the organization, with
 *                        filters (type, one main office, one umbrella office), grouped main office → its units.
 * Each office side by side, scope totals that count each document once, and one office in detail. The offices
 * always come from the server (the account's own scope); the filters only narrow it.
 */
const props = withDefaults(defineProps<{ mode?: 'department' | 'organization' }>(), { mode: 'department' })
const org = props.mode === 'organization'
const base = org ? '/dashboard/office-performance' : '/dashboard/umbrella-performance'

interface OfficeRow {
  office: { id: string; name: string; code: string; kind: 'MAIN' | 'UMBRELLA'; status: string; parent_office_id: string | null }
  received: number
  completed: number
  returned: number
  forwarded: number
  sent_back: number
  pending: number
  overdue: number
  awaiting_dispatch: number
  clearance_rate: number | null
  completion_rate: number | null
  decides: boolean
  avg_processing_minutes: number | null
  processing_measured: number
  active_personnel: number
  personnel: { heads: number; staff: number; messengers: number }
}
interface Totals {
  received: number
  completed: number
  returned: number
  forwarded_out: number
  sent_back: number
  pending: number
  overdue: number
  awaiting_dispatch: number
  avg_processing_minutes: number | null
  processing_measured: number
  /** organization mode */
  completion_rate?: number | null
  active_main_offices?: number
  active_umbrella_offices?: number
}
interface PerformanceData {
  range: { from: string; to: string; days: number }
  offices: OfficeRow[]
  department?: Totals | null
  organization?: Totals
  trend: Array<{ date: string; received: number; completed: number; forwarded_out: number }>
  /** organization mode: every office of the organization, for the filters */
  choices?: Array<{ id: string; name: string; code: string; parent_office_id: string | null; status: string }>
}
interface DocRef {
  id: string
  tracking_number: string
  title: string
}
interface DetailData {
  summary: OfficeRow
  staff: Array<{ id: string; name: string; account_type: string; position: string | null; received: number; cleared: number; holding: number; avg_processing_minutes: number | null }>
  pending_documents: Array<DocRef & { priority: string; target_at: string | null; overdue: boolean }>
  completed_documents: Array<{ completed_at: string; document: DocRef | null }>
  recent_activity: Array<{ at: string; kind: string; label: string; by: string | null; document: DocRef | null }>
}

const api = useApi()
const days = ref(30)
// Organization mode filters (sent to the server, which checks every id against the ADMIN's organization).
const kind = ref<'all' | 'main' | 'umbrella'>('all')
const mainId = ref('')
const unitId = ref('')
watch(mainId, () => (unitId.value = ''))
const query = () => ({
  days: days.value,
  ...(org && { kind: kind.value, main_office_id: mainId.value || undefined, office_id: unitId.value || undefined }),
})
const { data, status, error, refresh } = await useAsyncData(`${props.mode}-office-performance`, () => api.get<PerformanceData>(base, query()), {
  watch: [days, kind, mainId, unitId],
  lazy: true,
})
const errorMessage = computed(() => (error.value as { data?: { message?: string } } | null)?.data?.message ?? '')
const hasUnits = computed(() => (data.value?.offices ?? []).some((o) => o.office.kind === 'UMBRELLA'))
const visible = computed(() => (org ? true : status.value === 'error' || hasUnits.value))
const dept = computed(() => data.value?.department ?? data.value?.organization ?? null)
const choices = computed(() => data.value?.choices ?? [])
const mainChoices = computed(() => choices.value.filter((c) => !c.parent_office_id))
const unitChoices = computed(() => choices.value.filter((c) => c.parent_office_id && (!mainId.value || c.parent_office_id === mainId.value)))
const nameOf = (id: string | null) => choices.value.find((c) => c.id === id)?.name ?? ''
// An umbrella office names its main office only when that row isn't shown right above it (e.g. "umbrella only").
const shownIds = computed(() => new Set((data.value?.offices ?? []).map((o) => o.office.id)))
function clearFilters() {
  kind.value = 'all'
  mainId.value = ''
  unitId.value = ''
}
const filtered = computed(() => kind.value !== 'all' || Boolean(mainId.value) || Boolean(unitId.value))
const trend = computed(() => (data.value?.trend ?? []).map((t) => ({ date: t.date, a: t.received, b: t.completed + t.forwarded_out })))

const rate = (v: number | null) => (v == null ? '—' : `${Math.round(v * 100)}%`)
const minutes = (v: number | null) => (v == null ? '—' : formatDuration(v))
const maxPending = computed(() => Math.max(1, ...(data.value?.offices ?? []).map((o) => o.pending)))

const selected = ref<OfficeRow | null>(null)
const { data: detail, status: detailStatus, error: detailError, refresh: refreshDetail } = await useAsyncData(
  `${props.mode}-office-performance-detail`,
  () => (selected.value ? api.get<DetailData>(`${base}/${selected.value.office.id}`, { days: days.value }) : Promise.resolve(null)),
  { watch: [selected, days], lazy: true },
)
const when = (v: string) => new Intl.DateTimeFormat('en-PH', { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }).format(new Date(v))
</script>

<template>
  <section v-if="visible" class="space-y-4" :aria-labelledby="`${mode}-performance-title`">
    <div class="flex flex-wrap items-end justify-between gap-3">
      <div>
        <h2 :id="`${mode}-performance-title`" class="text-lg">{{ org ? 'Office Performance' : 'Umbrella Office Performance' }}</h2>
        <p class="text-sm text-ink-2">
          {{ org ? 'Every main office and umbrella office of your organization' : 'Your office and its umbrella offices' }}<template v-if="data">, {{ data.range.from }} to {{ data.range.to }}</template>.
          {{ org ? 'Totals count each document once.' : 'Department totals count each document once.' }}
        </p>
      </div>
      <div class="flex flex-wrap items-center gap-2">
        <template v-if="org">
          <label class="sr-only" for="op-kind">Office type</label>
          <select id="op-kind" v-model="kind" class="input w-auto py-1.5 text-sm">
            <option value="all">All offices</option>
            <option value="main">Main offices only</option>
            <option value="umbrella">Umbrella offices only</option>
          </select>
          <label class="sr-only" for="op-main">Main office</label>
          <select id="op-main" v-model="mainId" class="input w-auto max-w-56 py-1.5 text-sm">
            <option value="">Every main office</option>
            <option v-for="m in mainChoices" :key="m.id" :value="m.id">{{ m.name }}</option>
          </select>
          <label class="sr-only" for="op-unit">Umbrella office</label>
          <select id="op-unit" v-model="unitId" class="input w-auto max-w-56 py-1.5 text-sm" :disabled="!unitChoices.length">
            <option value="">Every umbrella office</option>
            <option v-for="u in unitChoices" :key="u.id" :value="u.id">{{ u.name }}<template v-if="!mainId"> ({{ nameOf(u.parent_office_id) }})</template></option>
          </select>
          <button v-if="filtered" type="button" class="btn btn-sm btn-ghost" @click="clearFilters"><FIcon name="x" :size="14" /> Clear</button>
        </template>
        <label class="sr-only" :for="`${mode}-days`">Period</label>
        <select :id="`${mode}-days`" v-model.number="days" class="input w-auto py-1.5 text-sm">
          <option :value="7">Last 7 days</option>
          <option :value="30">Last 30 days</option>
          <option :value="90">Last 90 days</option>
        </select>
      </div>
    </div>

    <div v-if="status === 'error'" class="card card-pad flex items-center justify-between gap-3 text-sm">
      <span class="text-ink-2">Couldn’t load {{ org ? 'office' : 'umbrella office' }} performance. {{ errorMessage }}</span>
      <button class="btn btn-sm btn-ghost" @click="refresh()">Retry</button>
    </div>
    <PageSkeleton v-else-if="status === 'pending' && !data && org" variant="cards" />

    <template v-else-if="data && dept">
      <!-- A. Totals (distinct documents) -->
      <div class="grid grid-cols-2 gap-3 md:grid-cols-3" :class="org ? 'xl:grid-cols-4' : 'xl:grid-cols-5'">
        <StatCard label="Received" :value="dept.received" icon="inbox" tone="info" :hint="`Distinct documents, last ${data.range.days} days`" />
        <StatCard label="Completed" :value="dept.completed" icon="check-circle" tone="success" :hint="org ? 'Approved at one of these offices' : `Approved here · ${dept.forwarded_out} sent on`" />
        <StatCard label="Pending" :value="dept.pending" icon="clock" tone="primary" :hint="org ? 'At one of these offices now' : 'At an office of the department now'" />
        <StatCard label="Overdue" :value="dept.overdue" icon="alert-triangle" :tone="dept.overdue ? 'warning' : 'neutral'" hint="Pending past their target" />
        <StatCard label="Avg. processing" :value="minutes(dept.avg_processing_minutes)" icon="activity" tone="neutral" :hint="dept.processing_measured ? `Receipt → release, ${dept.processing_measured} measured` : 'Nothing measured yet'" />
        <template v-if="org">
          <StatCard label="Completion rate" :value="rate(dept.completion_rate ?? null)" icon="percent" tone="neutral" hint="Of the documents received, the share approved" />
          <StatCard label="Main offices" :value="dept.active_main_offices ?? 0" icon="home" tone="neutral" hint="Active, whole organization" />
          <StatCard label="Umbrella offices" :value="dept.active_umbrella_offices ?? 0" icon="git-branch" tone="neutral" hint="Active, whole organization" />
        </template>
      </div>
      <EmptyState v-if="!data.offices.length" icon="briefcase" title="No offices match" description="No office matches these filters." />

      <!-- B. Office comparison -->
      <div v-if="data.offices.length" class="card overflow-hidden">
        <div class="overflow-x-auto">
          <table class="w-full min-w-[720px] text-sm">
            <thead class="border-b border-line text-left text-xs text-ink-2">
              <tr>
                <th class="min-w-48 px-4 py-2.5 font-medium">Office</th>
                <th class="px-3 py-2.5 text-right font-medium">Received</th>
                <th class="px-3 py-2.5 text-right font-medium" title="Passed on: to the next office on its route, or (an umbrella office) back to its office or to the next unit">Forwarded</th>
                <th class="px-3 py-2.5 text-right font-medium" title="Approved here, at the final checkpoint">Completed</th>
                <th class="px-3 py-2.5 text-right font-medium">Pending</th>
                <th class="px-3 py-2.5 text-right font-medium">Overdue</th>
                <th class="px-3 py-2.5 text-right font-medium" title="Of the documents received in the period, the share approved here. Only offices that decide have one.">Completion</th>
                <th class="px-3 py-2.5 text-right font-medium" title="Of the documents received in the period, the share whose part here has ended">Cleared</th>
                <th class="px-3 py-2.5 text-right font-medium" title="Receipt → release or return">Avg. time</th>
                <th class="px-4 py-2.5"><span class="sr-only">Details</span></th>
              </tr>
            </thead>
            <tbody>
              <tr
                v-for="o in data.offices"
                :key="o.office.id"
                class="border-b border-line/60 last:border-0"
                :class="org && o.office.kind === 'MAIN' ? 'bg-ink/[0.02]' : ''"
              >
                <td class="py-2.5 pr-3" :class="org && o.office.kind === 'UMBRELLA' ? 'pl-10' : 'pl-4'">
                  <p class="flex items-center gap-1.5 text-ink" :class="o.office.kind === 'MAIN' ? 'font-semibold' : 'font-medium'">
                    <FIcon v-if="org && o.office.kind === 'UMBRELLA'" name="corner-down-right" :size="14" class="shrink-0 text-ink-3" aria-hidden="true" />
                    {{ o.office.name }}
                  </p>
                  <p class="text-xs text-ink-2">
                    {{ o.office.kind === 'MAIN' ? 'Main office' : 'Umbrella office' }}<template v-if="org && o.office.parent_office_id && !shownIds.has(o.office.parent_office_id)"> of {{ nameOf(o.office.parent_office_id) }}</template>
                    · {{ o.office.code }}<template v-if="o.office.status === 'inactive'"> · deactivated</template>
                  </p>
                </td>
                <td class="px-3 py-2.5 text-right tabular-nums">{{ o.received }}</td>
                <td class="px-3 py-2.5 text-right tabular-nums">{{ o.forwarded }}</td>
                <td class="px-3 py-2.5 text-right tabular-nums">{{ o.decides ? o.completed : '—' }}</td>
                <td class="px-3 py-2.5 text-right tabular-nums">{{ o.pending }}</td>
                <td class="px-3 py-2.5 text-right tabular-nums" :class="o.overdue ? 'font-medium text-amber-ink' : ''">{{ o.overdue }}</td>
                <td class="px-3 py-2.5 text-right tabular-nums">{{ o.decides ? rate(o.completion_rate) : '—' }}</td>
                <td class="px-3 py-2.5 text-right tabular-nums">{{ rate(o.clearance_rate) }}</td>
                <td class="px-3 py-2.5 text-right whitespace-nowrap tabular-nums">{{ minutes(o.avg_processing_minutes) }}</td>
                <td class="px-4 py-2.5 text-right"><button class="btn btn-sm btn-ghost" @click="selected = o">View details</button></td>
              </tr>
            </tbody>
          </table>
        </div>
      </div>

      <!-- C. Charts -->
      <div v-if="data.offices.length" class="grid items-start gap-4 lg:grid-cols-3">
        <div class="card card-pad lg:col-span-1">
          <h3 class="text-sm font-medium">Received vs. done</h3>
          <p class="mb-3 text-xs text-ink-2">
            Per day, distinct documents. Done = {{ org ? 'approved at one of these offices, or sent on to an office outside them' : 'completed here or sent on out of the department' }}.
          </p>
          <PerformanceTrendChart :days="trend" label-a="Received" label-b="Done" />
        </div>
        <div class="card card-pad">
          <h3 class="text-sm font-medium">Workload now</h3>
          <p class="mb-3 text-xs text-ink-2">Documents pending at each office.</p>
          <ul class="space-y-2">
            <li v-for="o in data.offices" :key="o.office.id" :title="`${o.office.name}: ${o.pending} pending, ${o.overdue} overdue`">
              <div class="flex justify-between gap-2 text-xs"><span class="truncate text-ink-body">{{ o.office.name }}</span><span class="tabular-nums text-ink">{{ o.pending }}</span></div>
              <div class="mt-1 h-2 rounded bg-line/50"><div class="h-2 rounded bg-terracotta" :style="{ width: `${(o.pending / maxPending) * 100}%` }" /></div>
            </li>
          </ul>
        </div>
        <div class="card card-pad">
          <h3 class="text-sm font-medium">Cleared rate</h3>
          <p class="mb-3 text-xs text-ink-2">Of the documents each office received in the period, the share whose part there has ended.</p>
          <ul class="space-y-2">
            <li v-for="o in data.offices" :key="o.office.id" :title="`${o.office.name}: ${rate(o.clearance_rate)} of ${o.received} received`">
              <div class="flex justify-between gap-2 text-xs"><span class="truncate text-ink-body">{{ o.office.name }}</span><span class="tabular-nums text-ink">{{ rate(o.clearance_rate) }}</span></div>
              <div class="mt-1 h-2 rounded bg-line/50"><div class="h-2 rounded bg-[#2A81FF]" :style="{ width: `${(o.clearance_rate ?? 0) * 100}%` }" /></div>
            </li>
          </ul>
        </div>
      </div>
    </template>

    <!-- D. One office in detail -->
    <AppModal :open="Boolean(selected)" :title="selected?.office.name ?? 'Office'" :description="selected ? `${selected.office.kind === 'MAIN' ? 'Main office' : 'Umbrella office'} · last ${days} days` : undefined" width="lg" @close="selected = null">
      <AsyncState :status="detailStatus" :ready="Boolean(detail)" :error="detailError" variant="detail" what="this office" @retry="refreshDetail()">
        <div v-if="detail" class="space-y-5 text-sm">
          <dl class="grid grid-cols-2 gap-3 sm:grid-cols-4">
            <div><dt class="text-xs text-ink-2">Received</dt><dd class="text-lg tabular-nums">{{ detail.summary.received }}</dd></div>
            <div><dt class="text-xs text-ink-2">Forwarded</dt><dd class="text-lg tabular-nums">{{ detail.summary.forwarded }}</dd></div>
            <div><dt class="text-xs text-ink-2">Pending · overdue</dt><dd class="text-lg tabular-nums">{{ detail.summary.pending }} · {{ detail.summary.overdue }}</dd></div>
            <div><dt class="text-xs text-ink-2">Avg. processing</dt><dd class="text-lg tabular-nums">{{ minutes(detail.summary.avg_processing_minutes) }}</dd></div>
            <div v-if="detail.summary.decides"><dt class="text-xs text-ink-2">Completed here</dt><dd class="tabular-nums">{{ detail.summary.completed }} ({{ rate(detail.summary.completion_rate) }})</dd></div>
            <div><dt class="text-xs text-ink-2">Sent back</dt><dd class="tabular-nums">{{ detail.summary.sent_back }}</dd></div>
            <div><dt class="text-xs text-ink-2">Personnel</dt><dd>{{ detail.summary.personnel.heads }} head{{ detail.summary.personnel.heads === 1 ? '' : 's' }}, {{ detail.summary.personnel.staff }} staff, {{ detail.summary.personnel.messengers }} messenger{{ detail.summary.personnel.messengers === 1 ? '' : 's' }}</dd></div>
            <div><dt class="text-xs text-ink-2">Active in period</dt><dd class="tabular-nums">{{ detail.summary.active_personnel }}</dd></div>
          </dl>

          <div>
            <h3 class="mb-2 text-sm font-medium">People</h3>
            <EmptyState v-if="!detail.staff.length" icon="users" title="No staff assigned" description="Nobody is assigned to this office yet." />
            <div v-else class="overflow-x-auto">
              <table class="w-full min-w-[480px] text-sm">
                <thead class="text-left text-xs text-ink-2">
                  <tr><th class="py-1.5 font-medium">Name</th><th class="py-1.5 text-right font-medium">Received</th><th class="py-1.5 text-right font-medium">Released / passed on</th><th class="py-1.5 text-right font-medium">On desk now</th><th class="py-1.5 text-right font-medium">Avg. time</th></tr>
                </thead>
                <tbody>
                  <tr v-for="s in detail.staff" :key="s.id" class="border-t border-line/60">
                    <td class="py-1.5"><span class="text-ink">{{ s.name }}</span> <span class="text-xs text-ink-2">{{ s.account_type === 'DEPARTMENT_HEAD' ? 'Department Head' : (s.position ?? 'Staff') }}</span></td>
                    <td class="py-1.5 text-right tabular-nums">{{ s.received }}</td>
                    <td class="py-1.5 text-right tabular-nums">{{ s.cleared }}</td>
                    <td class="py-1.5 text-right tabular-nums">{{ s.holding }}</td>
                    <td class="py-1.5 text-right tabular-nums">{{ minutes(s.avg_processing_minutes) }}</td>
                  </tr>
                </tbody>
              </table>
            </div>
          </div>

          <div class="grid gap-5 md:grid-cols-2">
            <div>
              <h3 class="mb-2 text-sm font-medium">Pending here</h3>
              <p v-if="!detail.pending_documents.length" class="text-ink-2">Nothing pending.</p>
              <ul v-else class="space-y-1.5">
                <li v-for="d in detail.pending_documents" :key="d.id" class="flex items-center justify-between gap-2">
                  <NuxtLink :to="`/documents/${d.id}`" class="truncate hover:underline">{{ d.tracking_number }} · {{ d.title }}</NuxtLink>
                  <ToneBadge v-if="d.overdue" tone="warning" icon="alert-triangle">Overdue</ToneBadge>
                </li>
              </ul>
            </div>
            <div>
              <h3 class="mb-2 text-sm font-medium">Completed here</h3>
              <p v-if="!detail.completed_documents.length" class="text-ink-2">{{ detail.summary.decides ? 'None in this period.' : 'This office doesn’t make final decisions: its documents are passed on, not completed here.' }}</p>
              <ul v-else class="space-y-1.5">
                <li v-for="(c, i) in detail.completed_documents" :key="i" class="flex justify-between gap-2">
                  <NuxtLink v-if="c.document" :to="`/documents/${c.document.id}`" class="truncate hover:underline">{{ c.document.tracking_number }} · {{ c.document.title }}</NuxtLink>
                  <span v-else class="text-ink-2">A document you can’t open</span>
                  <span class="shrink-0 text-xs text-ink-2">{{ when(c.completed_at) }}</span>
                </li>
              </ul>
            </div>
          </div>

          <div>
            <h3 class="mb-2 text-sm font-medium">Recent activity</h3>
            <p v-if="!detail.recent_activity.length" class="text-ink-2">No activity in this period.</p>
            <ul v-else class="space-y-1.5">
              <li v-for="(a, i) in detail.recent_activity" :key="i" class="flex flex-wrap items-baseline justify-between gap-x-3">
                <span>
                  <span class="text-ink">{{ a.label }}</span>
                  <template v-if="a.document"> · <NuxtLink :to="`/documents/${a.document.id}`" class="hover:underline">{{ a.document.tracking_number }}</NuxtLink></template>
                  <span v-if="a.by" class="text-ink-2"> · {{ a.by }}</span>
                </span>
                <span class="text-xs text-ink-2">{{ when(a.at) }}</span>
              </li>
            </ul>
          </div>
        </div>
      </AsyncState>
    </AppModal>
  </section>
</template>
