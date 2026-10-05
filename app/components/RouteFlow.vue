<script setup lang="ts">
import type { DocumentOrigin, DocumentStatus, RouteStep } from '~/types'
import type { Tone } from '~/utils/format'

type FlowStep = Pick<RouteStep, 'step_number' | 'action_label' | 'is_final_checkpoint'> & {
  office_id?: string
  office?: { name: string; code: string } | null
}

/**
 * Visual office-to-office route. With `currentStep`/`status` it doubles as a progress tracker
 * for a single document, and with `origin` it starts at where the document came from: the
 * uploader's office, or their organization for CLIENT accounts.
 */
const props = withDefaults(
  defineProps<{
    steps: FlowStep[]
    currentStep?: number | null
    status?: DocumentStatus
    /** The current office has scanned the document in. */
    received?: boolean
    /** The current office has released it to a messenger, who hasn't picked it up yet. */
    released?: boolean
    /** Where the document comes from. */
    origin?: DocumentOrigin | null
    /** Who uploaded it, shown under the origin. */
    uploadedBy?: string | null
    /** When tracking started (submission). */
    startedAt?: string | null
    compact?: boolean
  }>(),
  { compact: false, received: false, released: false, origin: null, uploadedBy: null, startedAt: null },
)

type State = 'done' | 'current' | 'upcoming' | 'returned'
const moving = computed(() => props.status === 'PICKED_UP' || props.status === 'IN_TRANSIT')
const tracking = computed(() => Boolean(props.status && props.status !== 'CREATED' && props.currentStep != null))

function stateOf(stepNumber: number): State {
  if (!tracking.value) return 'upcoming'
  if (props.status === 'COMPLETED') return 'done'
  if (stepNumber < props.currentStep!) return 'done'
  if (stepNumber === props.currentStep) {
    if (props.status === 'RETURNED') return 'returned'
    return moving.value ? 'done' : 'current'
  }
  return 'upcoming'
}

/** Each office's status for this document: In review once it has received it, Completed once it is done with it. */
function stepStatus(stepNumber: number): { label: string; tone: Tone } | null {
  if (!tracking.value) return null
  const state = stateOf(stepNumber)
  if (state === 'done') return { label: 'Completed', tone: 'success' }
  if (state === 'returned') return { label: 'Returned', tone: 'danger' }
  if (state === 'current') {
    if (!props.received) return { label: 'Waiting to receive', tone: 'warning' }
    if (props.released) return { label: 'Waiting for messenger', tone: 'warning' }
    return { label: 'In review', tone: 'primary' }
  }
  if (moving.value && stepNumber === props.currentStep! + 1) return { label: 'Incoming', tone: 'info' }
  return { label: 'Pending', tone: 'neutral' }
}

// The uploader works at the route's first office: that office *is* the origin, so it isn't drawn twice.
const originIsFirstStep = computed(() => props.origin?.kind === 'OFFICE' && Boolean(props.origin.office_id) && props.origin.office_id === props.steps[0]?.office_id)
const showOriginNode = computed(() => Boolean(props.origin) && !props.compact && !originIsFirstStep.value)

/**
 * The origin is the owner's side of the document: In process for its whole journey, Completed
 * only when the document is approved at the end. A returned document comes back to its origin.
 * `away` = still in process, but the paper has left the origin.
 */
const originState = computed<{ state: State | 'away'; label: string; tone: Tone } | null>(() => {
  if (!tracking.value) return props.status === 'CREATED' ? { state: 'upcoming', label: 'Draft', tone: 'neutral' } : null
  if (props.status === 'COMPLETED') return { state: 'done', label: 'Completed', tone: 'success' }
  if (props.status === 'RETURNED') return { state: 'returned', label: 'Returned here', tone: 'danger' }
  const stillHere = props.currentStep === 0 && !moving.value
  return { state: stillHere ? 'current' : 'away', label: 'In process', tone: 'primary' }
})

/** The line from the origin to the first office is solid once the paper has left the origin. */
const originLeft = computed(() => tracking.value && (props.status === 'COMPLETED' || props.currentStep! >= 1))
const originNodeClass = computed(() => {
  const s = originState.value?.state ?? 'upcoming'
  return s === 'away' ? 'bg-terracotta/10 text-terracotta-ink border-terracotta/50' : nodeClasses[s]
})

/** The connector leaving `stepNumber` is solid once the document has moved past it. */
function connectorDone(stepNumber: number) {
  if (!tracking.value) return false
  return props.status === 'COMPLETED' || stepNumber < props.currentStep!
}

/** The connector after `stepNumber` is animated while the document travels along it. */
const travellingAfter = computed(() => (moving.value ? props.currentStep : null))

const nodeClasses: Record<State, string> = {
  done: 'bg-sage text-white border-sage',
  current: 'bg-terracotta text-white border-terracotta ring-4 ring-terracotta/15',
  returned: 'bg-danger text-white border-danger ring-4 ring-danger/15',
  upcoming: 'bg-card text-ink-2 border-line',
}
</script>

<template>
  <!-- Compact mode stretches to fit its container; full mode scrolls horizontally on narrow screens. -->
  <ol class="flex items-start" :class="compact ? 'w-full' : '-mx-1 overflow-x-auto px-1 pb-2'" aria-label="Route">
    <!-- Origin: where the document comes from -->
    <li v-if="showOriginNode && origin" class="flex shrink-0 items-start">
      <div class="flex w-[148px] shrink-0 flex-col items-center text-center">
        <span
          class="relative grid size-11 place-items-center rounded-full border-2 text-sm font-semibold transition-colors"
          :class="originNodeClass"
        >
          <FIcon v-if="originState?.state === 'done'" name="check" :size="18" :stroke="2.5" />
          <FIcon v-else :name="origin.kind === 'ORGANIZATION' ? 'home' : 'flag'" :size="18" />
        </span>
        <p class="mt-2 line-clamp-2 text-[13px] leading-snug font-medium">{{ origin.name }}</p>
        <p class="mt-0.5 text-xs text-ink-2">{{ origin.kind === 'ORGANIZATION' ? 'Organization' : 'Office' }}<template v-if="uploadedBy"> · {{ uploadedBy }}</template></p>
        <ToneBadge tone="primary" icon="flag" class="mt-2">Origin</ToneBadge>
        <p v-if="tracking && startedAt" class="mt-1 text-[11px] text-ink-2">Started {{ formatDateTime(startedAt) }}</p>
        <ToneBadge v-if="originState" :tone="originState.tone" dot class="mt-2">{{ originState.label }}</ToneBadge>
      </div>
      <div class="relative mt-[22px] h-0.5 w-10 shrink-0 overflow-hidden rounded-full" :class="originLeft ? 'bg-sage' : 'bg-line'">
        <!-- A messenger is carrying it from the origin to the first office. -->
        <span v-if="travellingAfter === 0" class="fv-travel absolute inset-y-0 w-1/2 rounded-full bg-terracotta" />
      </div>
    </li>

    <li
      v-for="(step, i) in steps"
      :key="step.step_number"
      class="flex items-start"
      :class="compact ? 'min-w-0 flex-1 last:flex-none' : 'shrink-0'"
      :aria-current="stateOf(step.step_number) === 'current' ? 'step' : undefined"
    >
      <div class="flex shrink-0 flex-col items-center text-center" :class="compact ? 'w-12' : 'w-[148px]'">
        <span
          class="relative grid place-items-center rounded-full border-2 font-semibold transition-colors"
          :class="[nodeClasses[stateOf(step.step_number)], compact ? 'size-8 text-xs' : 'size-11 text-sm']"
        >
          <FIcon v-if="stateOf(step.step_number) === 'done'" name="check" :size="compact ? 14 : 18" :stroke="2.5" />
          <FIcon v-else-if="step.is_final_checkpoint" name="award" :size="compact ? 14 : 18" />
          <span v-else>{{ step.step_number }}</span>
        </span>
        <p class="mt-2 font-medium leading-snug" :class="compact ? 'w-full truncate text-[10px]' : 'line-clamp-2 text-[13px]'">
          {{ compact ? step.office?.code : step.office?.name }}
        </p>
        <template v-if="!compact">
          <p class="mt-0.5 text-xs text-ink-2">{{ step.action_label }}</p>
          <template v-if="step.step_number === 1 && originIsFirstStep">
            <ToneBadge tone="primary" icon="flag" class="mt-2">Origin</ToneBadge>
            <p v-if="tracking && startedAt" class="mt-1 text-[11px] text-ink-2">Started {{ formatDateTime(startedAt) }}</p>
          </template>
        
          <ToneBadge v-if="stepStatus(step.step_number)" :tone="stepStatus(step.step_number)!.tone" dot class="mt-2">{{ stepStatus(step.step_number)!.label }}</ToneBadge>
        </template>
      </div>
      <div
        v-if="i < steps.length - 1"
        class="relative h-0.5 overflow-hidden rounded-full"
        :class="[
          compact ? 'mt-4 min-w-2 flex-1' : 'mt-[22px] w-10 shrink-0',
          connectorDone(step.step_number) ? 'bg-sage' : 'bg-line',
        ]"
      >
        <span v-if="travellingAfter === step.step_number" class="fv-travel absolute inset-y-0 w-1/2 rounded-full bg-terracotta" />
      </div>
    </li>
  </ol>
</template>

<style scoped>
.fv-travel {
  animation: fv-travel 1.4s ease-in-out infinite;
}
@keyframes fv-travel {
  from { left: -50%; }
  to { left: 100%; }
}
@media (prefers-reduced-motion: reduce) {
  .fv-travel { animation: none; left: 25%; }
}
</style>
