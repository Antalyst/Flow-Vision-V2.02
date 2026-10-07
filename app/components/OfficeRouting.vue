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
  PASSED_TO_STAFF: { icon: 'users', tone: 'warning' },
  PASS_CANCELLED: { icon: 'corner-up-left', tone: 'neutral' },
  APPROVAL_REQUESTED: { icon: 'clock', tone: 'warning' },
  PICKUP_REQUESTED: { icon: 'package', tone: 'warning' },
  SENT_BACK: { icon: 'flag', tone: 'danger' },
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
      if (e.from_staff) return `Received from ${fullName(e.from_staff)}'s desk (QR scanned)${who ? ` by ${who}` : ''}`
      return `Received (QR scanned)${who ? ` by ${who}` : ''}`
    case 'PASSED_TO_STAFF':
      return `Passed to the next staff${who ? ` by ${who}` : ''}`
    case 'PASS_CANCELLED':
      return `Taken back from the next staff${who ? ` by ${who}` : ''}`
    case 'PICKUP_REQUESTED':
      return `Released${who ? ` by ${who}` : ''} to messenger ${e.messenger ? fullName(e.messenger) : ''}`.trim()
    case 'SENT_BACK':
      return `Flagged an issue and sent it back${who ? ` · ${who}` : ''}${e.messenger ? ` with ${fullName(e.messenger)}` : ''}${e.remarks ? `: ${e.remarks}` : ''}`
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
      if (v.sent_back) return { icon: 'flag', tone: 'danger', text: `Flagged and sent back to ${to}${messenger}` }
      return { icon: 'arrow-down', tone: 'success', text: `Transferred to ${to}${v.picked_up_at ? messenger : ' by hand'}` }
    case 'IN_TRANSIT':
      return { icon: 'navigation', tone: 'info', text: `${v.sent_back ? 'Flagged — on the way back' : 'On the way'} to ${to}${messenger}` }
    case 'APPROVED':
      return { icon: 'award', tone: 'success', text: 'Final approval given — route complete' }
    case 'RETURNED':
      return { icon: 'corner-up-left', tone: 'danger', text: 'Returned to the submitter' }
    case 'AT_OFFICE':
      if (v.pending_pass) {
        const by = v.pending_pass.by ? ` by ${fullName(v.pending_pass.by)}` : ''
        return { icon: 'users', tone: 'warning', text: `Passed to the next staff${by} — waiting for another staff member to scan it in` }
      }
      if (v.released_at && !v.picked_up_at) return { icon: 'package', tone: 'warning', text: `Released — waiting for ${v.messenger ? fullName(v.messenger) : 'the messenger'} to pick it up for ${to}` }
      if (v.received_at) return { icon: 'edit-3', tone: 'primary', text: 'Being processed at this office' }
      return { icon: 'inbox', tone: 'warning', text: 'Waiting to be received (QR scan)' }
    default:
      return { icon: 'minus-circle', tone: 'neutral', text: 'Visit closed' }
  }
}

const live = (v: RoutingVisit) => v.state === 'AT_OFFICE'

// Every office card folds. The office the document is at now (or, once it is done, the last
// one) starts open; the others start folded down to their header and hand-over line.
const openIds = ref(new Set<string>())
function defaultOpen() {
  const current = props.visits.find(live) ?? props.visits.at(-1)
  openIds.value = new Set(current ? [current.id] : [])
}
watch(() => props.visits.map((v) => `${v.id}:${v.state}`).join(), defaultOpen, { immediate: true })

const isOpen = (v: RoutingVisit) => openIds.value.has(v.id)
function toggle(v: RoutingVisit) {
  const next = new Set(openIds.value)
  if (!next.delete(v.id)) next.add(v.id)
  openIds.value = next
}
const allOpen = computed(() => props.visits.length > 0 && props.visits.every(isOpen))
function toggleAll() {
  openIds.value = allOpen.value ? new Set() : new Set(props.visits.map((v) => v.id))
}
</script>

<template>
  <div v-if="!visits.length" class="text-sm text-ink-2">The routing details appear once the document is submitted.</div>
  <div v-else>
    <div v-if="visits.length > 1" class="mb-3 flex justify-end">
      <button type="button" class="btn btn-ghost btn-sm" @click="toggleAll">
        <FIcon :name="allOpen ? 'minimize-2' : 'maximize-2'" :size="14" /> {{ allOpen ? 'Collapse all' : 'Expand all' }}
      </button>
    </div>
    <ol class="space-y-0">
      <li v-for="(v, i) in visits" :key="v.id" class="relative pb-5 last:pb-0">
        <span v-if="i < visits.length - 1" class="absolute top-0 bottom-0 left-[17px] w-px bg-line" aria-hidden="true" />
        <div class="relative flex gap-4">
          <span class="relative z-10 grid size-9 shrink-0 place-items-center rounded-full font-display text-sm font-semibold ring-4 ring-cream" :class="TONE_CLASSES[STATE[v.state].tone]">
            {{ v.step_number || 'O' }}
          </span>
          <div class="min-w-0 flex-1 rounded-2xl border border-line/70 p-4" :class="live(v) && 'border-terracotta/40 bg-terracotta/[0.03]'">
            <!-- Office header: click to fold or unfold the card -->
            <button
              type="button"
              class="flex w-full flex-wrap items-center justify-between gap-2 text-left"
              :aria-expanded="isOpen(v)"
              :aria-controls="`visit-${v.id}`"
              @click="toggle(v)"
            >
              <div class="min-w-0">
                <p class="text-xs text-ink-2">{{ v.step_number ? `Step ${v.step_number}` : 'Origin' }}<template v-if="v.office?.code"> · {{ v.office.code }}</template></p>
                <p class="truncate font-semibold">{{ officeName(v) }}</p>
              </div>
              <div class="flex items-center gap-2">
                <ToneBadge :tone="STATE[v.state].tone" dot>{{ STATE[v.state].label }}</ToneBadge>
                <span v-if="v.durations.total != null" class="mono text-xs text-ink-2" :title="live(v) ? 'Time at this office so far' : 'Time spent at this office'">
                  {{ formatDuration(v.durations.total) }}<template v-if="live(v)"> so far</template>
                </span>
                <span class="grid size-7 shrink-0 place-items-center rounded-lg text-ink-2 hover:bg-ink/5">
                  <FIcon name="chevron-down" :size="16" class="transition-transform duration-200" :class="isOpen(v) && 'rotate-180'" />
                </span>
              </div>
            </button>

            <div v-show="isOpen(v)" :id="`visit-${v.id}`">
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

              <!-- Desk by desk inside the office -->
              <div v-if="v.desks.length > 1 || v.pending_pass" class="mt-3">
                <p class="mb-1.5 text-xs font-medium text-ink-2">Staff who handled it here</p>
                <ol class="flex flex-wrap items-center gap-1.5 text-xs">
                  <template v-for="(d, n) in v.desks" :key="d.received_at">
                    <li
                      class="rounded-lg px-2 py-1"
                      :class="d.current ? 'bg-terracotta/12 text-terracotta-ink' : 'bg-ink/[0.04] text-ink-body'"
                      :title="`Received ${formatDateTime(d.received_at)}${d.passed_at ? ` · passed on ${formatDateTime(d.passed_at)}` : ''}${d.remarks ? ` · “${d.remarks}”` : ''}`"
                    >
                      <span class="font-medium">{{ n + 1 }}. {{ d.staff ? fullName(d.staff) : 'Staff' }}</span>
                      <template v-if="d.minutes != null"> · {{ formatDuration(d.minutes) }}<template v-if="d.current"> so far</template></template>
                    </li>
                    <FIcon v-if="d.passed_at" name="chevron-right" :size="12" class="text-ink-3" aria-hidden="true" />
                  </template>
                  <li v-if="v.pending_pass" class="rounded-lg border border-dashed border-amber/60 px-2 py-1 text-amber-ink">Next staff — not received yet</li>
                </ol>
              </div>

              <!-- Activity log: every stage inside the office -->
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
            </div>

            <!-- Hand-over to the next office (shown folded too, as the card's summary) -->
            <div class="mt-3 flex items-center gap-2 rounded-xl px-3 py-2 text-[13px] font-medium" :class="TONE_CLASSES[handOver(v).tone]">
              <FIcon :name="handOver(v).icon" :size="14" class="shrink-0" />
              <span class="min-w-0 flex-1">{{ handOver(v).text }}</span>
              <time v-if="v.left_at" class="mono text-[11px] opacity-80" :datetime="v.left_at">{{ formatDateTime(v.left_at) }}</time>
            </div>
          </div>
        </div>
      </li>
    </ol>
  </div>
</template>
