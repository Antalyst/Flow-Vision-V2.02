<script setup lang="ts">
/**
 * Two daily counts on one axis (received vs. completed or sent on), as inline SVG like ForecastChart.
 * Hover (or focus + arrow keys) shows the day's values; the legend names both lines, so colour is never
 * the only cue. Colours: the brand accent and the info blue (validated as a pair for colour vision).
 */
const props = withDefaults(
  defineProps<{
    days: Array<{ date: string; a: number; b: number }>
    labelA: string
    labelB: string
    height?: number
  }>(),
  { height: 140 },
)

const W = 600
const PAD_TOP = 10
const PAD_BOTTOM = 4
const maxY = computed(() => Math.max(1, ...props.days.flatMap((d) => [d.a, d.b])))
const x = (i: number) => (props.days.length <= 1 ? W / 2 : (i / (props.days.length - 1)) * W)
const y = (v: number) => PAD_TOP + (1 - v / maxY.value) * (props.height - PAD_TOP - PAD_BOTTOM)
const path = (key: 'a' | 'b') => props.days.map((d, i) => `${i ? 'L' : 'M'}${x(i).toFixed(1)},${y(d[key]).toFixed(1)}`).join(' ')

const hover = ref<number | null>(null)
const box = ref<HTMLElement | null>(null)
function onMove(ev: PointerEvent) {
  const el = box.value
  if (!el || !props.days.length) return
  const r = el.getBoundingClientRect()
  const i = Math.round(((ev.clientX - r.left) / r.width) * (props.days.length - 1))
  hover.value = Math.max(0, Math.min(props.days.length - 1, i))
}
function onKey(ev: KeyboardEvent) {
  if (!props.days.length) return
  if (ev.key === 'ArrowRight') hover.value = Math.min(props.days.length - 1, (hover.value ?? -1) + 1)
  else if (ev.key === 'ArrowLeft') hover.value = Math.max(0, (hover.value ?? props.days.length) - 1)
  else return
  ev.preventDefault()
}
const point = computed(() => (hover.value == null ? null : props.days[hover.value] ?? null))
const pct = computed(() => (hover.value == null || props.days.length <= 1 ? 50 : (hover.value / (props.days.length - 1)) * 100))
const dayLabel = (d?: string) => (d ? new Intl.DateTimeFormat('en-PH', { month: 'short', day: 'numeric', timeZone: 'UTC' }).format(new Date(d)) : '')
const totalA = computed(() => props.days.reduce((n, d) => n + d.a, 0))
const totalB = computed(() => props.days.reduce((n, d) => n + d.b, 0))
</script>

<template>
  <div>
    <div class="mb-2 flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-ink-2">
      <span class="inline-flex items-center gap-1.5"><span class="inline-block h-0.5 w-4 rounded bg-[#E5322D]" aria-hidden="true" /> {{ labelA }} · <span class="text-ink">{{ totalA }}</span></span>
      <span class="inline-flex items-center gap-1.5"><span class="inline-block h-0.5 w-4 rounded bg-[#2A81FF]" aria-hidden="true" /> {{ labelB }} · <span class="text-ink">{{ totalB }}</span></span>
    </div>
    <div
      ref="box"
      class="relative outline-none focus-visible:ring-2 focus-visible:ring-terracotta/40 rounded"
      tabindex="0"
      role="img"
      :aria-label="`${labelA} and ${labelB} per day, ${dayLabel(days[0]?.date)} to ${dayLabel(days.at(-1)?.date)}. Use the arrow keys to read each day.`"
      @pointermove="onMove"
      @pointerleave="hover = null"
      @blur="hover = null"
      @keydown="onKey"
    >
      <svg :viewBox="`0 0 ${W} ${height}`" preserveAspectRatio="none" class="block w-full" :style="{ height: `${height}px` }" aria-hidden="true">
        <line x1="0" :x2="W" :y1="y(0)" :y2="y(0)" class="stroke-line" stroke-width="1" vector-effect="non-scaling-stroke" />
        <line v-if="hover != null" :x1="x(hover)" :x2="x(hover)" y1="0" :y2="height" class="stroke-ink-3" stroke-width="1" stroke-dasharray="3 3" vector-effect="non-scaling-stroke" />
        <path :d="path('a')" fill="none" stroke="#E5322D" stroke-width="2" stroke-linejoin="round" vector-effect="non-scaling-stroke" />
        <path :d="path('b')" fill="none" stroke="#2A81FF" stroke-width="2" stroke-linejoin="round" vector-effect="non-scaling-stroke" />
      </svg>
      <div
        v-if="point"
        class="pointer-events-none absolute top-0 z-10 rounded-lg border border-line bg-card px-2.5 py-1.5 text-xs shadow-sm"
        :style="{ left: `${pct}%`, transform: pct > 60 ? 'translateX(calc(-100% - 8px))' : 'translateX(8px)' }"
      >
        <p class="font-medium text-ink">{{ dayLabel(point.date) }}</p>
        <p class="text-ink-2">{{ labelA }}: <span class="text-ink">{{ point.a }}</span></p>
        <p class="text-ink-2">{{ labelB }}: <span class="text-ink">{{ point.b }}</span></p>
      </div>
    </div>
    <div class="mt-1.5 flex justify-between text-[11px] text-ink-2">
      <span>{{ dayLabel(days[0]?.date) }}</span>
      <span>peak {{ maxY }} / day</span>
      <span>{{ dayLabel(days.at(-1)?.date) }}</span>
    </div>
  </div>
</template>
