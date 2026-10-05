<script setup lang="ts">
import type { TrackingEvent } from '~/types'
import type { Tone } from '~/utils/format'

const props = withDefaults(defineProps<{ events: TrackingEvent[]; newestFirst?: boolean }>(), { newestFirst: true })

const EVENT_STYLE: Record<string, { icon: string; tone: Tone }> = {
  CREATED: { icon: 'file-plus', tone: 'neutral' },
  SUBMITTED: { icon: 'send', tone: 'primary' },
  RESUBMITTED: { icon: 'rotate-ccw', tone: 'primary' },
  RECEIVED: { icon: 'inbox', tone: 'info' },
  PICKUP_REQUESTED: { icon: 'package', tone: 'warning' },
  MESSENGER_REASSIGNED: { icon: 'repeat', tone: 'warning' },
  PICKED_UP: { icon: 'truck', tone: 'info' },
  IN_TRANSIT: { icon: 'navigation', tone: 'info' },
  ARRIVED: { icon: 'map-pin', tone: 'warning' },
  DELIVERY_FAILED: { icon: 'alert-triangle', tone: 'danger' },
  APPROVAL_REQUESTED: { icon: 'clock', tone: 'warning' },
  APPROVED: { icon: 'check-circle', tone: 'success' },
  RETURNED: { icon: 'corner-up-left', tone: 'danger' },
  COMPLETED: { icon: 'award', tone: 'success' },
  NOTE: { icon: 'message-square', tone: 'neutral' },
}

const ordered = computed(() => (props.newestFirst ? [...props.events].reverse() : props.events))
const style = (type: string) => EVENT_STYLE[type] ?? { icon: 'circle', tone: 'neutral' as Tone }
</script>

<template>
  <ol class="relative">
    <li v-for="(e, i) in ordered" :key="e.id" class="relative flex gap-4 pb-6 last:pb-0">
      <span v-if="i < ordered.length - 1" class="absolute top-9 bottom-0 left-[17px] w-px bg-line" aria-hidden="true" />
      <span class="relative z-10 grid size-9 shrink-0 place-items-center rounded-full ring-4 ring-cream" :class="TONE_CLASSES[style(e.event_type).tone]">
        <FIcon :name="style(e.event_type).icon" :size="16" />
      </span>
      <div class="min-w-0 flex-1 pt-1">
        <div class="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-0.5">
          <p class="text-sm font-semibold">
            {{ EVENT_LABELS[e.event_type] ?? e.event_type }}
            <span v-if="e.office" class="font-normal text-ink-body">· {{ e.office.name }}</span>
          </p>
          <time class="mono text-ink-2" :datetime="e.created_at" :title="formatDateTime(e.created_at)">{{ formatDateTime(e.created_at) }}</time>
        </div>
        <p class="mt-0.5 text-[13px] text-ink-2">
          <template v-if="e.actor">{{ fullName(e.actor) }} · {{ ROLE_META[e.actor.account_type]?.label }}</template>
          <template v-if="e.step_number"> · Step {{ e.step_number }}</template>
          <template v-if="e.metadata && typeof e.metadata.delivery_minutes === 'number'">
            · delivered in {{ formatDuration(e.metadata.delivery_minutes as number) }}
          </template>
        </p>
        <p v-if="e.remarks" class="mt-2 rounded-xl bg-ink/[0.035] px-3 py-2 text-[13px] text-ink-body">{{ e.remarks }}</p>
      </div>
    </li>
  </ol>
</template>
