<script setup lang="ts">
import type { Tone } from '~/utils/format'

type Point = [number, number]

interface StaffForecast {
  id: string
  first_name: string
  last_name: string
  account_type: 'EMPLOYEE' | 'STAFF'
  position: string | null
  holding: number
  received_total: number
  released_total: number
  uploads_total: number
  avg_processing_minutes: number | null
  expected_received: number
  expected_uploads: number
  change_pct: number
  predicted_load: number
  load_level: 'high' | 'normal' | 'light'
  history: Point[]
  forecast: Point[]
}

interface OfficeForecastData {
  office: { id: string; name: string; code: string } | null
  range: { from: string; to: string; days: number; horizon: number }
  arrivals: {
    history: Point[]
    forecast: Point[]
    band: Array<[number, number, number]>
    total: number
    avg_daily: number
    expected: number
    change_pct: number
    peak_day: { date: string; value: number } | null
    peak_hour: number | null
    busiest_weekday: string | null
  }
  throughput: { history: Point[]; forecast: Point[]; total: number; expected: number; change_pct: number }
  backlog: { now: number; forecast: Point[]; end: number; trend: 'growing' | 'shrinking' | 'steady'; clearance_days: number | null }
  processing: { avg_minutes: number | null; predicted_minutes: number | null; avg_receipt_wait_minutes: number | null; typical_stay_minutes: number | null; measured: number }
  deadlines: {
    overdue: number
    at_risk: number
    on_track: number
    documents: Array<{
      id: string
      tracking_number: string
      title: string
      priority: string
      stage: string
      holder: string | null
      minutes_here: number
      expected_out_at: string | null
      target_at: string | null
      risk: 'overdue' | 'at_risk'
    }>
  }
  staff: StaffForecast[]
  suggestion: string | null
}

const api = useApi()
const days = ref(30)
const horizon = ref(7)
const { data, pending, refresh } = await useAsyncData('employee-office-forecast', () => api.get<OfficeForecastData>('/forecast/office', { days: days.value, horizon: horizon.value }), {
  watch: [days, horizon],
})
useLiveRefresh(refresh)

const f = computed(() => (data.value?.office ? data.value : null))

const num = (v: number) => (Number.isInteger(v) ? String(v) : v.toFixed(1))
const pct = (v: number) => `${v > 0 ? '+' : ''}${v}%`
const changeTone = (v: number, upIsGood = false): Tone => (Math.abs(v) < 5 ? 'neutral' : v > 0 === upIsGood ? 'success' : 'warning')
const hourLabel = (h: number | null) => (h == null ? '—' : new Intl.DateTimeFormat('en-PH', { hour: 'numeric', timeZone: 'UTC' }).format(new Date(Date.UTC(2000, 0, 1, h))))
const dayLabel = (d: string) => new Intl.DateTimeFormat('en-PH', { weekday: 'short', month: 'short', day: 'numeric', timeZone: 'UTC' }).format(new Date(`${d}T00:00:00Z`))

const backlogTone = computed<Tone>(() => (f.value?.backlog.trend === 'growing' ? 'danger' : f.value?.backlog.trend === 'shrinking' ? 'success' : 'neutral'))
const backlogHint = computed(() => {
  const b = f.value?.backlog
  if (!b) return ''
  if (!b.now) return 'Desk is clear right now'
  if (b.clearance_days == null) return 'Arrivals outpace clearances — backlog won’t clear at this pace'
  return `Clears in about ${b.clearance_days} day${b.clearance_days === 1 ? '' : 's'} at the predicted pace`
})

const LOAD: Record<StaffForecast['load_level'], { label: string; tone: Tone }> = {
  high: { label: 'Heavy load ahead', tone: 'danger' },
  normal: { label: 'Normal', tone: 'neutral' },
  light: { label: 'Has capacity', tone: 'success' },
}
const maxLoad = computed(() => Math.max(1, ...(f.value?.staff ?? []).map((s) => s.predicted_load)))
</script>

<template>
  <section v-if="f" class="mt-8">
    <div class="mb-4 flex flex-wrap items-end justify-between gap-3">
      <div>
        <h2 class="flex items-center gap-2 text-lg"><FIcon name="trending-up" :size="18" /> Forecast &amp; predictive analytics</h2>
        <p class="mt-1 text-sm text-ink-body">
          Projected from the last {{ f.range.days }} days of documents at {{ f.office!.name }} — weekday patterns included. Dashed lines are forecasts.
        </p>
      </div>
      <div class="flex items-center gap-2">
        <label class="sr-only" for="fc-days">History window</label>
        <select id="fc-days" v-model.number="days" class="input w-auto py-1.5 text-sm">
          <option :value="30">Last 30 days</option>
          <option :value="60">Last 60 days</option>
          <option :value="90">Last 90 days</option>
        </select>
        <label class="sr-only" for="fc-horizon">Forecast horizon</label>
        <select id="fc-horizon" v-model.number="horizon" class="input w-auto py-1.5 text-sm">
          <option :value="7">Next 7 days</option>
          <option :value="14">Next 14 days</option>
        </select>
      </div>
    </div>

    <div class="grid grid-cols-1 gap-3 sm:gap-4 md:grid-cols-2 xl:grid-cols-4" :class="pending && 'opacity-60'">
      <!-- Arrivals -->
      <article class="card card-pad">
        <div class="flex items-start justify-between gap-3">
          <p class="text-[13px] font-medium text-ink-body">Expected arrivals</p>
          <ToneBadge :tone="changeTone(f.arrivals.change_pct)">{{ pct(f.arrivals.change_pct) }}</ToneBadge>
        </div>
        <p class="mt-3 font-display text-[32px] leading-none font-semibold tracking-tight">≈{{ num(f.arrivals.expected) }}</p>
        <p class="mt-2 text-xs text-ink-2">next {{ f.range.horizon }} days · avg {{ num(f.arrivals.avg_daily) }}/day so far</p>
        <ForecastChart class="mt-3" :history="f.arrivals.history.slice(-14)" :forecast="f.arrivals.forecast" :band="f.arrivals.band" :height="56" label="Arrivals forecast" />
      </article>

      <!-- Throughput -->
      <article class="card card-pad">
        <div class="flex items-start justify-between gap-3">
          <p class="text-[13px] font-medium text-ink-body">Expected to release</p>
          <ToneBadge :tone="changeTone(f.throughput.change_pct, true)">{{ pct(f.throughput.change_pct) }}</ToneBadge>
        </div>
        <p class="mt-3 font-display text-[32px] leading-none font-semibold tracking-tight">≈{{ num(f.throughput.expected) }}</p>
        <p class="mt-2 text-xs text-ink-2">documents leaving your office in {{ f.range.horizon }} days</p>
        <ForecastChart class="mt-3" :history="f.throughput.history.slice(-14)" :forecast="f.throughput.forecast" :height="56" label="Release forecast" />
      </article>

      <!-- Backlog -->
      <article class="card card-pad">
        <div class="flex items-start justify-between gap-3">
          <p class="text-[13px] font-medium text-ink-body">Backlog outlook</p>
          <ToneBadge :tone="backlogTone" dot>{{ f.backlog.trend }}</ToneBadge>
        </div>
        <p class="mt-3 font-display text-[32px] leading-none font-semibold tracking-tight">
          {{ f.backlog.now }} <span class="text-lg text-ink-2">→ {{ num(f.backlog.end) }}</span>
        </p>
        <p class="mt-2 text-xs text-ink-2">{{ backlogHint }}</p>
        <ForecastChart class="mt-3" :history="[[f.arrivals.history.at(-1)![0], f.backlog.now]]" :forecast="f.backlog.forecast" :height="56" label="Backlog forecast" />
      </article>

      <!-- Processing time -->
      <article class="card card-pad">
        <div class="flex items-start justify-between gap-3">
          <p class="text-[13px] font-medium text-ink-body">Predicted processing time</p>
          <span class="grid size-9 place-items-center rounded-xl" :class="TONE_CLASSES.info"><FIcon name="clock" :size="18" /></span>
        </div>
        <p class="mt-3 font-display text-[32px] leading-none font-semibold tracking-tight">{{ formatDuration(f.processing.predicted_minutes) }}</p>
        <p class="mt-2 text-xs text-ink-2">receipt → release, per document · {{ formatDuration(f.processing.avg_minutes) }} average so far</p>
        <dl class="mt-3 space-y-1.5 border-t border-line/60 pt-3 text-xs">
          <div class="flex justify-between gap-3"><dt class="text-ink-2">Wait before receipt</dt><dd>{{ formatDuration(f.processing.avg_receipt_wait_minutes) }}</dd></div>
          <div class="flex justify-between gap-3"><dt class="text-ink-2">Typical time at office</dt><dd>{{ formatDuration(f.processing.typical_stay_minutes) }}</dd></div>
        </dl>
      </article>
    </div>

    <div class="mt-4 grid grid-cols-1 gap-4 lg:grid-cols-[minmax(0,1fr)_380px]">
      <!-- Arrivals trend -->
      <article class="card card-pad">
        <div class="mb-4 flex flex-wrap items-start justify-between gap-2">
          <div>
            <h3 class="text-base font-semibold">Incoming documents forecast</h3>
            <p class="text-xs text-ink-2">Daily arrivals at your office with an ≈80% forecast range</p>
          </div>
          <span class="mono text-xs text-ink-2">{{ f.arrivals.total }} in {{ f.range.days }} days</span>
        </div>
        <ForecastChart :history="f.arrivals.history" :forecast="f.arrivals.forecast" :band="f.arrivals.band" :height="160" axis label="Daily arrivals and forecast" />
        <div class="mt-4 grid grid-cols-1 gap-2 text-sm sm:grid-cols-3">
          <div class="rounded-xl bg-ink/[0.035] p-3">
            <p class="text-xs text-ink-2">Busiest day ahead</p>
            <p class="mt-0.5 font-semibold">{{ f.arrivals.peak_day ? `${dayLabel(f.arrivals.peak_day.date)} · ≈${num(f.arrivals.peak_day.value)}` : '—' }}</p>
          </div>
          <div class="rounded-xl bg-ink/[0.035] p-3">
            <p class="text-xs text-ink-2">Peak arrival hour</p>
            <p class="mt-0.5 font-semibold">{{ hourLabel(f.arrivals.peak_hour) }}</p>
          </div>
          <div class="rounded-xl bg-ink/[0.035] p-3">
            <p class="text-xs text-ink-2">Usually busiest on</p>
            <p class="mt-0.5 font-semibold">{{ f.arrivals.busiest_weekday ?? '—' }}</p>
          </div>
        </div>
      </article>

      <!-- Deadline risk -->
      <article class="card card-pad">
        <h3 class="text-base font-semibold">Deadline risk</h3>
        <p class="text-xs text-ink-2">Documents here now, checked against the office’s typical pace</p>
        <div class="mt-3 grid grid-cols-3 gap-2 text-center">
          <div class="rounded-xl p-2" :class="TONE_CLASSES.danger"><p class="font-display text-xl font-semibold">{{ f.deadlines.overdue }}</p><p class="text-[11px]">Overdue</p></div>
          <div class="rounded-xl p-2" :class="TONE_CLASSES.warning"><p class="font-display text-xl font-semibold">{{ f.deadlines.at_risk }}</p><p class="text-[11px]">Likely late</p></div>
          <div class="rounded-xl p-2" :class="TONE_CLASSES.success"><p class="font-display text-xl font-semibold">{{ f.deadlines.on_track }}</p><p class="text-[11px]">On track</p></div>
        </div>
        <ul v-if="f.deadlines.documents.length" class="mt-3 space-y-2">
          <li v-for="d in f.deadlines.documents" :key="d.id">
            <NuxtLink :to="`/documents/${d.id}`" class="block rounded-xl border border-line/70 p-2.5 text-[13px] hover:bg-ink/[0.03]">
              <div class="flex items-center justify-between gap-2">
                <span class="truncate font-medium">{{ d.title }}</span>
                <ToneBadge :tone="d.risk === 'overdue' ? 'danger' : 'warning'">{{ d.risk === 'overdue' ? 'Overdue' : 'Likely late' }}</ToneBadge>
              </div>
              <p class="mt-1 text-xs text-ink-2">
                {{ d.stage }}<template v-if="d.holder"> · {{ d.holder }}</template> · here {{ formatDuration(d.minutes_here) }}
              </p>
              <p class="text-xs text-ink-2">
                Due {{ formatDateTime(d.target_at) }}<template v-if="d.expected_out_at && d.risk === 'at_risk'"> · expected out {{ formatDateTime(d.expected_out_at) }}</template>
              </p>
            </NuxtLink>
          </li>
        </ul>
        <p v-else class="mt-4 text-sm text-ink-body">No document at your office is predicted to miss its deadline.</p>
      </article>
    </div>

    <!-- Staff -->
    <article class="card card-pad mt-4">
      <div class="mb-4 flex flex-wrap items-start justify-between gap-2">
        <div>
          <h3 class="text-base font-semibold">Staff workload forecast</h3>
          <p class="text-xs text-ink-2">For everyone in your office: what they hold now plus what they are predicted to receive in the next {{ f.range.horizon }} days</p>
        </div>
        <NuxtLink to="/employee/team" class="btn btn-sm btn-ghost">Manage staff <FIcon name="arrow-right" :size="14" /></NuxtLink>
      </div>
      <div v-if="f.suggestion" class="mb-4 flex items-start gap-2 rounded-xl p-3 text-sm" :class="TONE_CLASSES.info">
        <FIcon name="zap" :size="16" class="mt-0.5 shrink-0" />
        <span>{{ f.suggestion }}</span>
      </div>
      <EmptyState v-if="!f.staff.length" icon="users" title="No staff yet" description="Add staff to your office to see their workload forecast." />
      <div v-else class="grid grid-cols-1 gap-3 md:grid-cols-2 xl:grid-cols-3">
        <div v-for="s in f.staff" :key="s.id" class="rounded-2xl border border-line/70 p-4">
          <div class="flex items-center gap-3">
            <UserAvatar :user="s" size="sm" />
            <div class="min-w-0 flex-1">
              <p class="truncate font-semibold">{{ fullName(s) }}</p>
              <p class="truncate text-xs text-ink-2">{{ s.position ?? ROLE_META[s.account_type]?.label }}</p>
            </div>
            <ToneBadge :tone="LOAD[s.load_level].tone" dot>{{ LOAD[s.load_level].label }}</ToneBadge>
          </div>
          <div class="mt-3">
            <div class="flex justify-between text-xs">
              <span class="text-ink-2">Predicted load</span>
              <span class="font-semibold">≈{{ num(s.predicted_load) }} docs</span>
            </div>
            <div class="mt-1 h-1.5 overflow-hidden rounded-full bg-ink/[0.06]">
              <div class="h-full rounded-full" :class="s.load_level === 'high' ? 'bg-danger' : s.load_level === 'light' ? 'bg-sage' : 'bg-terracotta'" :style="{ width: `${(s.predicted_load / maxLoad) * 100}%` }" />
            </div>
          </div>
          <ForecastChart class="mt-3" :history="s.history" :forecast="s.forecast" :height="40" :label="`${fullName(s)} receipts forecast`" />
          <dl class="mt-3 grid grid-cols-2 gap-x-3 gap-y-1.5 text-xs">
            <div class="flex justify-between gap-2"><dt class="text-ink-2">Holding now</dt><dd class="font-medium">{{ s.holding }}</dd></div>
            <div class="flex justify-between gap-2"><dt class="text-ink-2">Will receive</dt><dd class="font-medium">≈{{ num(s.expected_received) }} <span :class="TONE_CLASSES[changeTone(s.change_pct)]" class="rounded px-1">{{ pct(s.change_pct) }}</span></dd></div>
            <div class="flex justify-between gap-2"><dt class="text-ink-2">Received ({{ f.range.days }}d)</dt><dd class="font-medium">{{ s.received_total }}</dd></div>
            <div class="flex justify-between gap-2"><dt class="text-ink-2">Released ({{ f.range.days }}d)</dt><dd class="font-medium">{{ s.released_total }}</dd></div>
            <div class="flex justify-between gap-2"><dt class="text-ink-2">Avg processing</dt><dd class="font-medium">{{ formatDuration(s.avg_processing_minutes) }}</dd></div>
            <div class="flex justify-between gap-2"><dt class="text-ink-2">Uploads → next</dt><dd class="font-medium">{{ s.uploads_total }} → ≈{{ num(s.expected_uploads) }}</dd></div>
          </dl>
        </div>
      </div>
    </article>
  </section>
</template>
