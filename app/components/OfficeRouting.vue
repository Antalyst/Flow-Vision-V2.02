<script setup lang="ts">
import type { RoutingVisit } from '~/types'
import type { Tone } from '~/utils/format'

/**
 * The document's path office by office: inside each office, every stage from arrival to
 * receipt, processing, release to a messenger and pickup — up to the transfer to the next
 * office — with how long each stage took.
 */
const props = defineProps<{ visits: RoutingVisit[]; originName?: string | null }>()

const STATE: Record<RoutingVisit['state'], { label: string; tone: Tone }> = {
  AT_OFFICE: { label: 'At this office now', tone: 'primary' },
  IN_TRANSIT: { label: 'Being transferred', tone: 'info' },
  TRANSFERRED: { label: 'Transferred', tone: 'success' },
  APPROVED: { label: 'Approved here', tone: 'success' },
  RETURNED: { label: 'Returned here', tone: 'danger' },
  CLOSED: { label: 'Closed', tone: 'neutral' },
}

const STAGE_ICON: Record<string, { icon: string; tone: Tone }> = {
  SUBMITTED: { icon: 'send', tone: 'primary' },
  RESUBMITTED: { icon: 'rotate-ccw', tone: 'primary' },
  ARRIVED: { icon: 'map-pin', tone: 'warning' },
  RECEIVED: { icon: 'inbox', tone: 'info' },
  APPROVAL_REQUESTED: { icon: 'clock', tone: 'warning' },
  PICKUP_REQUESTED: { icon: 'package', tone: 'warning' },
  MESSENGER_REASSIGNED: { icon: 'repeat', tone: 'warning' },
  PICKED_UP: { icon: 'truck', tone: 'info' },
  IN_TRANSIT: { icon: 'navigation', tone: 'info' },
  DELIVERY_FAILED: { icon: 'alert-triangle', tone: 'danger' },
  APPROVED: { icon: 'check-circle', tone: 'success' },
  RETURNED: { icon: 'corner-up-left', tone: 'danger' },
  COMPLETED: { icon: 'award', tone: 'success' },
  NOTE: { icon: 'message-square', tone: 'neutral' },
}
const stageIcon = (type: string) => STAGE_ICON[type] ?? { icon: 'circle', tone: 'neutral' as Tone }

const officeName = (v: RoutingVisit) => v.office?.name ?? props.originName ?? 'Origin'

/** A plain-language line for one stage inside the office. */
function stageText(v: RoutingVisit, e: RoutingVisit['events'][number]) {
  const who = e.actor ? fullName(e.actor) : null
  switch (e.type) {
    case 'SUBMITTED':
      return `Submitted to the route${who ? ` by ${who}` : ''}`
    case 'RESUBMITTED':
      return `Resubmitted${who ? ` by ${who}` : ''}`
    case 'ARRIVED': {
      const from = v.arrival?.from_office?.name ? ` from ${v.arrival.from_office.name}` : ''
      if (v.arrival?.by_hand) return `Arrived${from}, brought over by hand`
      return `Arrived${from}${who ? `, delivered by ${who}` : ''}${v.arrival?.delivery_minutes != null ? ` in ${formatDuration(v.arrival.delivery_minutes)}` : ''}`
    }
    case 'RECEIVED':
      return `Received (QR scanned)${who ? ` by ${who}` : ''}`
    case 'PICKUP_REQUESTED':
      return `Released${who ? ` by ${who}` : ''} to messenger ${e.messenger ? fullName(e.messenger) : ''}`.trim()
    case 'MESSENGER_REASSIGNED':
      return `Messenger reassigned${who ? ` by ${who}` : ''}`
    case 'PICKED_UP':
      return `Picked up${who ? ` by ${who}` : ''}${v.to_office ? ` for ${v.to_office.name}` : ''}`
    case 'IN_TRANSIT':
      return `On the way${v.to_office ? ` to ${v.to_office.name}` : ''}`
    case 'APPROVED':
      return `Approved${who ? ` by ${who}` : ''}`
    case 'RETURNED':
      return `Returned to the submitter${who ? ` by ${who}` : ''}`
    default:
      return `${EVENT_LABELS[e.type] ?? e.type}${who ? ` · ${who}` : ''}`
  }
}


function handOver(v: RoutingVisit): { icon: string; tone: Tone; text: string } {
  const to = v.to_office?.name ?? 'the next office'
  const messenger = v.messenger ? ` with ${fullName(v.messenger)}` : ''
  switch (v.state) {
    case 'TRANSFERRED':
      return { icon: 'arrow-down', tone: 'success', text: `Transferred to ${to}${v.picked_up_at ? messenger : ' by hand'}` }
    case 'IN_TRANSIT':
      return { icon: 'navigation', tone: 'info', text: `On the way to ${to}${messenger}` }
    case 'APPROVED':
      return { icon: 'award', tone: 'success', text: 'Final approval given — route complete' }
    case 'RETURNED':
      return { icon: 'corner-up-left', tone: 'danger', text: 'Returned to the submitter' }
    case 'AT_OFFICE':
      if (v.released_at && !v.picked_up_at) return { icon: 'package', tone: 'warning', text: `Released — waiting for ${v.messenger ? fullName(v.messenger) : 'the messenger'} to pick it up for ${to}` }
      if (v.received_at) return { icon: 'edit-3', tone: 'primary', text: 'Being processed at this office' }
      return { icon: 'inbox', tone: 'warning', text: 'Waiting to be received (QR scan)' }
    default:
      return { icon: 'minus-circle', tone: 'neutral', text: 'Visit closed' }
  }
}

const live = (v: RoutingVisit) => v.state === 'AT_OFFICE'
</script>

<template>
  <div v-if="!visits.length" class="text-sm text-ink-2">The routing details appear once the document is submitted.</div>
  <ol v-else class="space-y-0">
    <li v-for="(v, i) in visits" :key="v.id" class="relative pb-5 last:pb-0">
      <span v-if="i < visits.length - 1" class="absolute top-0 bottom-0 left-[17px] w-px bg-line" aria-hidden="true" />
      <div class="relative flex gap-4">
        <span class="relative z-10 grid size-9 shrink-0 place-items-center rounded-full font-display text-sm font-semibold ring-4 ring-cream" :class="TONE_CLASSES[STATE[v.state].tone]">
          {{ v.step_number || 'O' }}
        </span>
        <div class="min-w-0 flex-1 rounded-2xl border border-line/70 p-4" :class="live(v) && 'border-terracotta/40 bg-terracotta/[0.03]'">
          <!-- Office header -->
          <div class="flex flex-wrap items-center justify-between gap-2">
            <div class="min-w-0">
              <p class="text-xs text-ink-2">{{ v.step_number ? `Step ${v.step_number}` : 'Origin' }}<template v-if="v.office?.code"> · {{ v.office.code }}</template></p>
              <p class="truncate font-semibold">{{ officeName(v) }}</p>
            </div>
            <div class="flex items-center gap-2">
              <ToneBadge :tone="STATE[v.state].tone" dot>{{ STATE[v.state].label }}</ToneBadge>
              <span v-if="v.durations.total != null" class="mono text-xs text-ink-2" :title="live(v) ? 'Time at this office so far' : 'Time spent at this office'">
                {{ formatDuration(v.durations.total) }}<template v-if="live(v)"> so far</template>
              </span>
            </div>
          </div>

          <!-- How long each stage inside the office took -->
          <div v-if="v.step_number" class="mt-3 flex flex-wrap gap-1.5 text-xs">
            <span v-if="v.durations.waiting_receipt != null" class="rounded-lg bg-ink/[0.04] px-2 py-1 text-ink-body">
              <FIcon name="inbox" :size="12" class="mr-1 inline" />Waited for receipt {{ formatDuration(v.durations.waiting_receipt) }}
            </span>
            <span v-if="v.durations.processing != null" class="rounded-lg bg-ink/[0.04] px-2 py-1 text-ink-body">
              <FIcon name="edit-3" :size="12" class="mr-1 inline" />Processing {{ formatDuration(v.durations.processing) }}
            </span>
            <span v-if="v.durations.waiting_pickup != null" class="rounded-lg bg-ink/[0.04] px-2 py-1 text-ink-body">
              <FIcon name="package" :size="12" class="mr-1 inline" />Waited for messenger {{ formatDuration(v.durations.waiting_pickup) }}
            </span>
          </div>

          <!-- Stages inside the office -->
          <ol class="mt-3 space-y-2.5 border-t border-line/60 pt-3">
            <li v-for="e in v.events" :key="e.id" class="flex gap-2.5 text-[13px]">
              <span class="mt-0.5 grid size-6 shrink-0 place-items-center rounded-full" :class="TONE_CLASSES[stageIcon(e.type).tone]">
                <FIcon :name="stageIcon(e.type).icon" :size="12" />
              </span>
              <div class="min-w-0 flex-1">
                <div class="flex flex-wrap items-baseline justify-between gap-x-3">
                  <p class="text-ink">{{ stageText(v, e) }}</p>
                  <time class="mono text-[11px] text-ink-2" :datetime="e.at">{{ formatDateTime(e.at) }}</time>
                </div>
                <p v-if="e.remarks" class="mt-1 rounded-lg bg-ink/[0.035] px-2.5 py-1.5 text-ink-body">{{ e.remarks }}</p>
              </div>
            </li>
          </ol>

          <!-- Hand-over to the next office -->
          <div class="mt-3 flex items-center gap-2 rounded-xl px-3 py-2 text-[13px] font-medium" :class="TONE_CLASSES[handOver(v).tone]">
            <FIcon :name="handOver(v).icon" :size="14" class="shrink-0" />
            <span class="min-w-0 flex-1">{{ handOver(v).text }}</span>
            <time v-if="v.left_at" class="mono text-[11px] opacity-80" :datetime="v.left_at">{{ formatDateTime(v.left_at) }}</time>
          </div>
        </div>
      </div>
    </li>
  </ol>
</template>
