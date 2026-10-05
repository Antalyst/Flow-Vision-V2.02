<script setup lang="ts">
import type * as HC from 'highcharts'

type Point = [number, number]
interface Forecast {
  range: { from: string; to: string; days: number; horizon: number }
  office: { id: string; name: string } | null
  offices: Array<{ id: string; name: string; code: string }>
  incoming: {
    basis: 'arrivals' | 'submissions'
    history: Point[]
    fitted: Point[]
    forecast: Point[]
    band: Array<[number, number, number]>
    total: number
    avg_daily: number
    expected_next: number
    change_pct: number
    peak_day: { date: string; value: number } | null
  }
  busyness: {
    hourly_avg: number[]
    hourly_next: number[]
    next_day: string | null
    peak_hour: number | null
    quiet_hour: number | null
    offices: Array<{ id: string; name: string; queue: number; predicted: number; score: number }>
  }
  pickups: {
    history: Array<[number, number | null]>
    forecast: Point[]
    band: Array<[number, number, number]>
    hourly: number[]
    count: number
    measured: number
    avg_wait: number | null
    median_wait: number | null
    predicted_wait: number | null
    busiest_hour: number | null
  }
}

const api = useApi()

// ── Filters ───────────────────────────────────────────────────────────────────
const phToday = () => new Intl.DateTimeFormat('en-CA', { timeZone: TIME_ZONE }).format(new Date())
const shiftDay = (iso: string, days: number) => new Date(Date.parse(`${iso}T00:00:00Z`) + days * 86_400_000).toISOString().slice(0, 10)

const officeId = ref('')
const to = ref(phToday())
const from = ref(shiftDay(to.value, -29))
const horizon = ref(7)
const PRESETS = [
  { label: '7D', days: 7 },
  { label: '30D', days: 30 },
  { label: '90D', days: 90 },
]
const activePreset = computed(() => (to.value === phToday() ? PRESETS.find((p) => shiftDay(to.value, -(p.days - 1)) === from.value)?.days : undefined))
function applyPreset(days: number) {
  to.value = phToday()
  from.value = shiftDay(to.value, -(days - 1))
}

const { data, status, error, refresh } = await useAsyncData(
  'dashboard-forecast',
  () => api.get<Forecast>('/forecast', { office_id: officeId.value || undefined, from: from.value, to: to.value, horizon: horizon.value }),
  { watch: [officeId, from, to, horizon], server: false },
)
defineExpose({ refresh })

// ── Carousel ──────────────────────────────────────────────────────────────────
const SLIDES = [
  { key: 'incoming', title: 'Documents Coming In', icon: 'inbox' },
  { key: 'busyness', title: 'Office Busyness', icon: 'activity' },
  { key: 'pickups', title: 'Courier Pickup Times', icon: 'truck' },
] as const
const slide = ref(0)
const paused = ref(false)
const go = (i: number) => (slide.value = (i + SLIDES.length) % SLIDES.length)

let timer: ReturnType<typeof setInterval> | undefined
onMounted(() => {
  timer = setInterval(() => {
    if (!paused.value && !document.hidden) go(slide.value + 1)
  }, 9000)
})
onBeforeUnmount(() => clearInterval(timer))

let touchX: number | null = null
const onTouchStart = (e: TouchEvent) => (touchX = e.touches[0]?.clientX ?? null)
function onTouchEnd(e: TouchEvent) {
  if (touchX == null) return
  const dx = (e.changedTouches[0]?.clientX ?? touchX) - touchX
  if (Math.abs(dx) > 40) go(slide.value + (dx < 0 ? 1 : -1))
  touchX = null
}

// ── Formatting ────────────────────────────────────────────────────────────────
const hourLabel = (h: number | null) => (h == null ? '—' : `${h % 12 || 12} ${h < 12 ? 'AM' : 'PM'}`)
const dayLabel = (iso: string | null | undefined) =>
  iso ? new Intl.DateTimeFormat('en-PH', { weekday: 'short', month: 'short', day: 'numeric', timeZone: 'UTC' }).format(new Date(`${iso}T00:00:00Z`)) : '—'
const minutesLabel = (m: number | null) => (m == null ? '—' : formatDuration(Math.round(m)))
const scope = computed(() => data.value?.office?.name ?? 'All offices')
const BUSINESS_HOURS = Array.from({ length: 15 }, (_, i) => i + 6) // 6 AM – 8 PM

// ── Charts ────────────────────────────────────────────────────────────────────
const incomingEl = ref<HTMLElement>()
const busynessEl = ref<HTMLElement>()
const pickupsEl = ref<HTMLElement>()
let Highcharts: typeof HC | null = null
const charts: HC.Chart[] = []

function cssVar(name: string, fallback: string) {
  return getComputedStyle(document.documentElement).getPropertyValue(name).trim() || fallback
}

function baseOptions(): HC.Options {
  const ink2 = cssVar('--lumio-text-secondary', '#6B6A70')
  const line = cssVar('--lumio-line', 'rgba(17,17,19,0.08)')
  return {
    chart: { backgroundColor: 'transparent', height: 280, spacing: [8, 4, 4, 0], style: { fontFamily: 'Inter Variable, ui-sans-serif, system-ui, sans-serif' } },
    title: { text: undefined },
    credits: { enabled: false },
    accessibility: { enabled: false },
    legend: { align: 'left', verticalAlign: 'top', itemStyle: { color: ink2, fontWeight: '500', fontSize: '12px' }, symbolRadius: 3 },
    xAxis: { lineColor: line, tickColor: line, labels: { style: { color: ink2, fontSize: '11px' } } },
    yAxis: { gridLineColor: line, gridLineDashStyle: 'Dash', title: { text: undefined }, labels: { style: { color: ink2, fontSize: '11px' } }, min: 0 },
    tooltip: { shared: true, borderRadius: 12, borderWidth: 0, shadow: true, backgroundColor: 'rgba(255,255,255,0.97)', style: { fontSize: '12px' } },
    plotOptions: { series: { animation: { duration: 500 } }, column: { borderRadius: 4, borderWidth: 0 } },
  }
}

function render() {
  if (!Highcharts || !data.value) return
  charts.splice(0).forEach((c) => c.destroy())
  const d = data.value
  const info = cssVar('--lumio-accent-info', '#2A81FF')
  const primary = cssVar('--lumio-accent-primary', '#E5322D')
  const warning = cssVar('--lumio-accent-warning', '#F59E0B')
  const success = cssVar('--lumio-accent-success', '#10B981')
  const ink = cssVar('--lumio-text', '#111113')
  const forecastStart = d.incoming.forecast[0]?.[0]
  const forecastEnd = d.incoming.forecast.at(-1)?.[0]
  const forecastZone = forecastStart && forecastEnd ? [{ from: forecastStart - 43_200_000, to: forecastEnd + 43_200_000, color: 'rgba(42,129,255,0.06)', label: { text: 'Forecast', style: { color: info, fontSize: '11px', fontWeight: '600' }, y: 14 } }] : []
  const merge = Highcharts.merge as (...o: HC.Options[]) => HC.Options

  if (incomingEl.value) {
    charts.push(
      Highcharts.chart(
        incomingEl.value,
        merge(baseOptions(), {
          xAxis: { type: 'datetime', plotBands: forecastZone },
          yAxis: { allowDecimals: false },
          tooltip: { xDateFormat: '%a, %b %e', valueDecimals: 1 },
          series: [
            { type: 'column', name: d.incoming.basis === 'arrivals' ? 'Arrived' : 'Submitted', data: d.incoming.history, color: ink, opacity: 0.8, tooltip: { valueDecimals: 0 } },
            { type: 'spline', name: 'Trend', data: d.incoming.fitted, color: info, lineWidth: 1.5, opacity: 0.5, marker: { enabled: false }, enableMouseTracking: false },
            { type: 'arearange', name: '80% range', data: d.incoming.band, color: info, fillOpacity: 0.15, lineWidth: 0, marker: { enabled: false }, linkedTo: ':previous' },
            { type: 'spline', name: 'Forecast', data: d.incoming.forecast, color: info, dashStyle: 'ShortDash', lineWidth: 2.5, marker: { enabled: true, radius: 3, symbol: 'circle' } },
          ],
        }),
      ),
    )
  }

  if (busynessEl.value) {
    charts.push(
      Highcharts.chart(
        busynessEl.value,
        merge(baseOptions(), {
          xAxis: { categories: BUSINESS_HOURS.map(hourLabel), plotBands: d.busyness.peak_hour != null && d.busyness.peak_hour >= 6 && d.busyness.peak_hour <= 20 ? [{ from: d.busyness.peak_hour - 6.5, to: d.busyness.peak_hour - 5.5, color: 'rgba(245,158,11,0.12)' }] : [] },
          tooltip: { valueDecimals: 2, valueSuffix: ' docs' },
          series: [
            { type: 'column', name: 'Average per hour', data: BUSINESS_HOURS.map((h) => d.busyness.hourly_avg[h] ?? 0), color: warning },
            { type: 'spline', name: `Predicted · ${dayLabel(d.busyness.next_day)}`, data: BUSINESS_HOURS.map((h) => d.busyness.hourly_next[h] ?? 0), color: primary, dashStyle: 'ShortDash', lineWidth: 2.5, marker: { radius: 3, symbol: 'circle' } },
          ],
        }),
      ),
    )
  }

  if (pickupsEl.value) {
    charts.push(
      Highcharts.chart(
        pickupsEl.value,
        merge(baseOptions(), {
          xAxis: { type: 'datetime', plotBands: forecastZone },
          yAxis: { labels: { format: '{value}m' } },
          tooltip: { xDateFormat: '%a, %b %e', valueDecimals: 0, valueSuffix: ' min' },
          series: [
            { type: 'line', name: 'Avg wait (request → pickup)', data: d.pickups.history, color: success, lineWidth: 2, connectNulls: true, marker: { enabled: true, radius: 2.5, symbol: 'circle' } },
            { type: 'arearange', name: '80% range', data: d.pickups.band, color: success, fillOpacity: 0.15, lineWidth: 0, marker: { enabled: false }, linkedTo: ':next' },
            { type: 'spline', name: 'Predicted wait', data: d.pickups.forecast, color: success, dashStyle: 'ShortDash', lineWidth: 2.5, marker: { enabled: true, radius: 3, symbol: 'circle' } },
          ],
        }),
      ),
    )
  }
}

onMounted(async () => {
  Highcharts = (await import('highcharts')).default as unknown as typeof HC
  await import('highcharts/highcharts-more')
  render()
})
onBeforeUnmount(() => charts.splice(0).forEach((c) => c.destroy()))
watch(data, () => nextTick(render))
// The track slides each panel into view at full width; nudge charts in case the card resized while hidden.
watch(slide, () => nextTick(() => charts.forEach((c) => c.reflow())))

const trendTone = (pct: number) => (pct > 10 ? 'text-danger-ink' : pct < -10 ? 'text-sage-ink' : 'text-ink-body')
</script>

<template>
  <section class="card card-pad" @mouseenter="paused = true" @mouseleave="paused = false" @focusin="paused = true" @focusout="paused = false">
    <div class="flex flex-wrap items-start justify-between gap-3">
      <div>
        <p class="eyebrow">Predictive analytics</p>
        <h2 class="mt-1.5 text-lg">Forecasts</h2>
      </div>
      <div class="flex items-center gap-1.5">
        <button type="button" class="btn btn-ghost btn-sm !px-2.5" aria-label="Previous forecast" @click="go(slide - 1)"><FIcon name="chevron-left" :size="16" /></button>
        <button type="button" class="btn btn-ghost btn-sm !px-2.5" aria-label="Next forecast" @click="go(slide + 1)"><FIcon name="chevron-right" :size="16" /></button>
      </div>
    </div>

    <!-- Filters -->
    <div class="mt-4 grid grid-cols-1 gap-3 sm:grid-cols-2 xl:grid-cols-[minmax(0,1.3fr)_minmax(0,1fr)_minmax(0,1fr)_auto_auto]">
      <label class="block">
        <span class="field-label">Office</span>
        <select v-model="officeId" class="input !min-h-10 !text-sm">
          <option value="">All offices</option>
          <option v-for="o in data?.offices ?? []" :key="o.id" :value="o.id">{{ o.name }}</option>
        </select>
      </label>
      <label class="block">
        <span class="field-label">From</span>
        <input v-model="from" type="date" class="input !min-h-10 !text-sm" :max="to" />
      </label>
      <label class="block">
        <span class="field-label">To</span>
        <input v-model="to" type="date" class="input !min-h-10 !text-sm" :min="from" :max="phToday()" />
      </label>
      <label class="block">
        <span class="field-label">Predict</span>
        <select v-model.number="horizon" class="input !min-h-10 !text-sm">
          <option :value="7">Next 7 days</option>
          <option :value="14">Next 14 days</option>
          <option :value="30">Next 30 days</option>
        </select>
      </label>
      <div class="flex items-end gap-1">
        <button
          v-for="p in PRESETS"
          :key="p.days"
          type="button"
          class="btn btn-sm"
          :class="activePreset === p.days ? 'btn-primary' : 'btn-ghost'"
          @click="applyPreset(p.days)"
        >
          {{ p.label }}
        </button>
      </div>
    </div>

    <!-- Slide tabs -->
    <div class="mt-5 flex gap-1 overflow-x-auto rounded-full border border-line bg-white/50 p-1" role="tablist">
      <button
        v-for="(s, i) in SLIDES"
        :key="s.key"
        type="button"
        role="tab"
        :aria-selected="slide === i"
        class="flex min-h-9 flex-1 items-center justify-center gap-1.5 rounded-full px-3 text-[13px] font-semibold whitespace-nowrap transition-colors"
        :class="slide === i ? 'bg-ink text-white' : 'text-ink-body hover:bg-white'"
        @click="go(i)"
      >
        <FIcon :name="s.icon" :size="14" /> {{ s.title }}
      </button>
    </div>

    <p v-if="error" class="mt-6 rounded-2xl bg-danger/10 px-4 py-3 text-sm text-danger-ink">{{ apiErrorMessage(error, 'Could not load forecasts') }}</p>

    <div v-else class="relative mt-4 overflow-hidden" @touchstart.passive="onTouchStart" @touchend.passive="onTouchEnd">
      <div v-if="status === 'pending'" class="absolute inset-0 z-10 grid place-items-center bg-white/40 text-sm text-ink-2 backdrop-blur-[1px]">Crunching forecast…</div>

      <div class="flex transition-transform duration-500 ease-out" :style="{ transform: `translateX(-${slide * 100}%)` }">
        <!-- 1. Documents coming in -->
        <div class="w-full shrink-0" :aria-hidden="slide !== 0">
          <div class="grid grid-cols-2 gap-3 lg:grid-cols-4">
            <div class="rounded-2xl bg-ink/[0.03] p-3">
              <p class="text-xs text-ink-2">Expected next {{ data?.range.horizon ?? horizon }} days</p>
              <p class="mt-1 font-display text-2xl font-semibold">{{ data ? Math.round(data.incoming.expected_next) : '—' }}</p>
            </div>
            <div class="rounded-2xl bg-ink/[0.03] p-3">
              <p class="text-xs text-ink-2">vs. last {{ data?.range.horizon ?? horizon }} days</p>
              <p class="mt-1 font-display text-2xl font-semibold" :class="trendTone(data?.incoming.change_pct ?? 0)">
                {{ data ? `${data.incoming.change_pct > 0 ? '+' : ''}${data.incoming.change_pct}%` : '—' }}
              </p>
            </div>
            <div class="rounded-2xl bg-ink/[0.03] p-3">
              <p class="text-xs text-ink-2">Daily average (range)</p>
              <p class="mt-1 font-display text-2xl font-semibold">{{ data?.incoming.avg_daily ?? '—' }}</p>
            </div>
            <div class="rounded-2xl bg-ink/[0.03] p-3">
              <p class="text-xs text-ink-2">Busiest day ahead</p>
              <p class="mt-1 font-display text-lg font-semibold">{{ dayLabel(data?.incoming.peak_day?.date) }}</p>
              <p class="text-xs text-ink-2">~{{ data?.incoming.peak_day ? Math.round(data.incoming.peak_day.value) : 0 }} documents</p>
            </div>
          </div>
          <div ref="incomingEl" class="mt-4 h-[280px]" />
          <p class="text-xs text-ink-2">
            {{ data?.incoming.basis === 'arrivals' ? `Documents arriving at ${scope}` : 'New documents submitted across the organization' }} — forecast uses trend + day-of-week patterns. Shaded band is the 80% likely range.
          </p>
        </div>

        <!-- 2. Office busyness -->
        <div class="w-full shrink-0" :aria-hidden="slide !== 1">
          <div class="grid grid-cols-1 gap-5 lg:grid-cols-[minmax(0,1fr)_260px]">
            <div>
              <div class="grid grid-cols-2 gap-3">
                <div class="rounded-2xl bg-amber/10 p-3">
                  <p class="text-xs text-amber-ink">Peak hour</p>
                  <p class="mt-1 font-display text-2xl font-semibold">{{ hourLabel(data?.busyness.peak_hour ?? null) }}</p>
                </div>
                <div class="rounded-2xl bg-sage/10 p-3">
                  <p class="text-xs text-sage-ink">Quietest work hour</p>
                  <p class="mt-1 font-display text-2xl font-semibold">{{ hourLabel(data?.busyness.quiet_hour ?? null) }}</p>
                </div>
              </div>
              <div ref="busynessEl" class="mt-4 h-[280px]" />
            </div>
            <div>
              <p class="text-sm font-semibold">Predicted load · next {{ data?.range.horizon ?? horizon }} days</p>
              <p class="mt-0.5 text-xs text-ink-2">Waiting now + forecast arrivals</p>
              <p v-if="!data?.busyness.offices.length" class="mt-4 text-sm text-ink-2">No office activity in this range.</p>
              <ul v-else class="mt-3 space-y-3">
                <li v-for="o in data.busyness.offices" :key="o.id">
                  <button type="button" class="w-full text-left" @click="officeId = officeId === o.id ? '' : o.id">
                    <div class="flex items-center justify-between gap-2 text-[13px]">
                      <span class="truncate font-medium" :class="officeId === o.id && 'text-terracotta-ink'">{{ o.name }}</span>
                      <span class="mono shrink-0 text-ink-2">{{ o.queue }} + {{ Math.round(o.predicted) }}</span>
                    </div>
                    <div class="mt-1.5 h-2 overflow-hidden rounded-full bg-line/50">
                      <div class="h-full rounded-full" :class="o.score >= 75 ? 'bg-danger' : o.score >= 45 ? 'bg-amber' : 'bg-sage'" :style="{ width: `${Math.max(3, o.score)}%` }" />
                    </div>
                  </button>
                </li>
              </ul>
            </div>
          </div>
        </div>

        <!-- 3. Courier pickup times -->
        <div class="w-full shrink-0" :aria-hidden="slide !== 2">
          <div class="grid grid-cols-2 gap-3 lg:grid-cols-4">
            <div class="rounded-2xl bg-ink/[0.03] p-3">
              <p class="text-xs text-ink-2">Avg wait for courier</p>
              <p class="mt-1 font-display text-2xl font-semibold">{{ minutesLabel(data?.pickups.avg_wait ?? null) }}</p>
            </div>
            <div class="rounded-2xl bg-ink/[0.03] p-3">
              <p class="text-xs text-ink-2">Predicted wait</p>
              <p class="mt-1 font-display text-2xl font-semibold text-sage-ink">{{ minutesLabel(data?.pickups.predicted_wait ?? null) }}</p>
            </div>
            <div class="rounded-2xl bg-ink/[0.03] p-3">
              <p class="text-xs text-ink-2">Usual pickup window</p>
              <p class="mt-1 font-display text-lg font-semibold">
                {{ data?.pickups.busiest_hour != null ? `${hourLabel(data.pickups.busiest_hour)} – ${hourLabel((data.pickups.busiest_hour + 1) % 24)}` : '—' }}
              </p>
            </div>
            <div class="rounded-2xl bg-ink/[0.03] p-3">
              <p class="text-xs text-ink-2">Pickups in range</p>
              <p class="mt-1 font-display text-2xl font-semibold">{{ data?.pickups.count ?? '—' }}</p>
              <p class="text-xs text-ink-2">median {{ minutesLabel(data?.pickups.median_wait ?? null) }}</p>
            </div>
          </div>
          <div ref="pickupsEl" class="mt-4 h-[280px]" />
          <p class="text-xs text-ink-2">Time from a pickup request to the courier collecting the document{{ data?.office ? ` at ${data.office.name}` : '' }}.</p>
        </div>
      </div>
    </div>

    <div class="mt-4 flex justify-center gap-2">
      <button
        v-for="(s, i) in SLIDES"
        :key="s.key"
        type="button"
        :aria-label="`Show ${s.title}`"
        class="h-2 rounded-full transition-all"
        :class="slide === i ? 'w-6 bg-ink' : 'w-2 bg-line'"
        @click="go(i)"
      />
    </div>
  </section>
</template>
