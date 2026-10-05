<script setup lang="ts">
/**
 * History (solid) followed by a forecast (dashed) with an optional confidence band, as a
 * lightweight inline SVG. Points are [timestamp, value]; band points are [timestamp, low, high].
 */
const props = withDefaults(
  defineProps<{
    history: Array<[number, number]>
    forecast: Array<[number, number]>
    band?: Array<[number, number, number]>
    height?: number
    /** Show first / today / last day labels under the chart. */
    axis?: boolean
    label?: string
  }>(),
  { band: () => [], height: 120, axis: false, label: 'Forecast chart' },
)

const W = 600
const PAD = 6
const points = computed(() => [...props.history, ...props.forecast])
const maxY = computed(() => Math.max(1, ...points.value.map(([, v]) => v), ...props.band.map(([, , hi]) => hi)))
const minX = computed(() => points.value[0]?.[0] ?? 0)
const maxX = computed(() => points.value.at(-1)?.[0] ?? 1)
const x = (t: number) => (maxX.value === minX.value ? W / 2 : ((t - minX.value) / (maxX.value - minX.value)) * W)
const y = (v: number) => PAD + (1 - v / maxY.value) * (props.height - PAD * 2)
const path = (pts: Array<[number, number]>) => pts.map(([t, v], i) => `${i ? 'L' : 'M'}${x(t).toFixed(1)},${y(v).toFixed(1)}`).join(' ')

const historyPath = computed(() => path(props.history))
// The forecast line starts from the last actual point so the two read as one series.
const forecastPath = computed(() => path([...props.history.slice(-1), ...props.forecast]))
const areaPath = computed(() =>
  props.history.length ? `${historyPath.value} L${x(props.history.at(-1)![0]).toFixed(1)},${props.height} L${x(props.history[0]![0]).toFixed(1)},${props.height} Z` : '',
)
const bandPath = computed(() => {
  if (!props.band.length) return ''
  const top = props.band.map(([t, , hi], i) => `${i ? 'L' : 'M'}${x(t).toFixed(1)},${y(hi).toFixed(1)}`).join(' ')
  const bottom = [...props.band].reverse().map(([t, lo]) => `L${x(t).toFixed(1)},${y(lo).toFixed(1)}`).join(' ')
  return `${top} ${bottom} Z`
})
const todayX = computed(() => (props.history.length && props.forecast.length ? x(props.history.at(-1)![0]) : null))

const dayLabel = (t?: number) => (t == null ? '' : new Intl.DateTimeFormat('en-PH', { month: 'short', day: 'numeric', timeZone: 'UTC' }).format(new Date(t)))
</script>

<template>
  <div>
    <svg :viewBox="`0 0 ${W} ${height}`" preserveAspectRatio="none" class="block w-full" :style="{ height: `${height}px` }" role="img" :aria-label="label">
      <path v-if="bandPath" :d="bandPath" class="fill-terracotta/10" />
      <path v-if="areaPath" :d="areaPath" class="fill-terracotta/[0.07]" />
      <line v-if="todayX != null" :x1="todayX" :x2="todayX" y1="0" :y2="height" class="stroke-line" stroke-width="1" stroke-dasharray="3 3" vector-effect="non-scaling-stroke" />
      <path v-if="history.length" :d="historyPath" fill="none" class="stroke-terracotta" stroke-width="2" stroke-linejoin="round" vector-effect="non-scaling-stroke" />
      <path v-if="forecast.length" :d="forecastPath" fill="none" class="stroke-terracotta" stroke-width="2" stroke-dasharray="5 4" stroke-linejoin="round" vector-effect="non-scaling-stroke" opacity="0.8" />
    </svg>
    <div v-if="axis" class="mt-1.5 flex justify-between text-[11px] text-ink-2">
      <span>{{ dayLabel(history[0]?.[0]) }}</span>
      <span v-if="forecast.length">Today · forecast →</span>
      <span>{{ dayLabel(forecast.at(-1)?.[0] ?? history.at(-1)?.[0]) }}</span>
    </div>
  </div>
</template>
