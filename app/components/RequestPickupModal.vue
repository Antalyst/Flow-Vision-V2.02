<script setup lang="ts">
import type { FlowDocument, LiaisonProfile } from '~/types'

interface LiaisonRow extends LiaisonProfile {
  user: { id: string; first_name: string; last_name: string; phone: string | null; office?: { name: string; department_name: string } | null }
}

/**
 * B3 flow: assign a free messenger to carry the document to the next office — from its origin or
 * from an office. Only messengers who are on duty with nothing to pick up or deliver can be chosen
 * (the server checks it too). With a messenger already assigned (not picked up yet) this reassigns.
 * The messenger, the one replaced, and the next office are notified.
 */
const props = defineProps<{ open: boolean; doc: FlowDocument | null }>()
const emit = defineEmits<{ close: []; requested: [doc: FlowDocument] }>()

const api = useApi()
const { requestPickup } = useDocuments()
const { busy, run } = useAction()
const auth = useAuthStore()

const liaisons = ref<LiaisonRow[]>([])
const search = ref('')
const selected = ref<string | null>(null)
const remarks = ref('')
const loading = ref(false)

const myDept = computed(() => auth.user?.office?.department_code)
const filtered = computed(() => {
  const q = search.value.trim().toLowerCase()
  return liaisons.value.filter((l) => !q || `${l.user.first_name} ${l.user.last_name}`.toLowerCase().includes(q))
})
// Reassigning: the current messenger is shown but can't be picked again.
const currentId = computed(() => props.doc?.assigned_liaison_id ?? null)
const reassigning = computed(() => Boolean(currentId.value))
const atOrigin = computed(() => props.doc?.current_step_number === 0)
const freeCount = computed(() => liaisons.value.filter((l) => l.availability === 'AVAILABLE' && l.user.id !== currentId.value).length)

async function load() {
  loading.value = true
  try {
    liaisons.value = (await api.get<{ data: LiaisonRow[] }>('/liaisons')).data
    if (selected.value && !liaisons.value.some((l) => l.user.id === selected.value && l.availability === 'AVAILABLE')) selected.value = null
  } finally {
    loading.value = false
  }
}

watch(
  () => props.open,
  (open) => {
    if (!open) return
    selected.value = null
    remarks.value = ''
    search.value = ''
    load()
  },
)

async function confirm() {
  if (!props.doc || !selected.value) return
  const name = fullName(liaisons.value.find((l) => l.user.id === selected.value)?.user)
  const res = await run(
    'request',
    () => requestPickup(props.doc!.id, { liaison_user_id: selected.value!, remarks: remarks.value || undefined }),
    reassigning.value
      ? `Reassigned to ${name} — they, the previous messenger and ${props.doc.next_office_name ?? 'the next office'} have been notified`
      : `Assigned to ${name} — they and ${props.doc.next_office_name ?? 'the next office'} have been notified`,
  )
  if (res) {
    emit('requested', res.document)
    emit('close')
  } else {
    // Someone may have taken that messenger in the meantime.
    load()
  }
}

const availabilityTone = { AVAILABLE: 'success', BUSY: 'warning', OFF_DUTY: 'neutral' } as const
const availabilityLabel = { AVAILABLE: 'free', BUSY: 'busy', OFF_DUTY: 'off duty' } as const
</script>

<template>
  <AppModal
    :open="open"
    :title="reassigning ? 'Reassign messenger' : atOrigin ? 'Assign messenger' : 'Release to messenger'"
    :description="doc ? `${doc.qr_code ?? doc.tracking_number} → ${doc.next_office_name ?? 'next office'}` : undefined"
    width="lg"
    @close="emit('close')"
  >
    <p class="field-label">Who should carry it?</p>
    <p v-if="reassigning && doc?.liaison" class="mb-3 flex items-center gap-2 rounded-xl bg-amber/12 p-3 text-sm text-amber-ink">
      <FIcon name="repeat" :size="16" class="shrink-0" /> Currently {{ fullName(doc.liaison) }}. They'll be told they no longer need to pick it up.
    </p>
    <p class="mb-3 text-xs text-ink-body">
      {{ atOrigin ? `They pick it up from ${doc?.origin?.name ?? 'the origin'} and bring it to ${doc?.next_office_name ?? 'the first office'}.` : '' }}
      Only free messengers can be chosen: on duty, with nothing to pick up or deliver.
    </p>

    <div class="relative mb-2">
      <FIcon name="search" :size="16" class="absolute top-1/2 left-3.5 -translate-y-1/2 text-ink-2" />
      <input v-model="search" class="input pl-10" placeholder="Search messengers by name" aria-label="Search messengers" />
    </div>
    <div class="max-h-72 space-y-2 overflow-y-auto">
      <div v-if="loading && !liaisons.length" class="space-y-2 py-2" role="status" aria-label="Loading messengers">
        <div v-for="i in 3" :key="i" class="flex items-center gap-3 rounded-2xl border border-line p-3">
          <div class="skeleton size-9 shrink-0 rounded-full" />
          <div class="flex-1 space-y-2">
            <div class="skeleton h-3.5 w-1/2" />
            <div class="skeleton h-3 w-1/3" />
          </div>
        </div>
      </div>
      <p v-else-if="!filtered.length" class="py-6 text-center text-sm text-ink-2">No messengers found.</p>
      <button
        v-for="l in filtered"
        :key="l.id"
        type="button"
        class="flex w-full items-center gap-3 rounded-xl border p-3 text-left transition-colors disabled:cursor-not-allowed disabled:opacity-55"
        :class="selected === l.user.id ? 'border-terracotta bg-terracotta/[0.06]' : 'border-line hover:bg-card'"
        :disabled="l.availability !== 'AVAILABLE' || l.user.id === currentId"
        :aria-pressed="selected === l.user.id"
        @click="selected = l.user.id"
      >
        <UserAvatar :user="l.user" />
        <span class="min-w-0 flex-1">
          <span class="flex items-center gap-2 text-sm font-semibold">
            {{ fullName(l.user) }}
            <ToneBadge v-if="l.department_code === myDept" tone="primary">Your dept</ToneBadge>
          </span>
          <span class="block truncate text-xs text-ink-body">
            <template v-if="l.user.id === currentId">Assigned now</template>
            <template v-else-if="l.availability === 'BUSY'">Has a document to deliver</template>
            <template v-else-if="l.availability === 'OFF_DUTY'">Off duty</template>
            <template v-else>{{ l.user.office?.department_name }} · {{ l.success_rate }}% success · avg {{ formatDuration(l.avg_delivery_minutes) }}</template>
          </span>
        </span>
        <ToneBadge :tone="availabilityTone[l.availability]" dot>{{ availabilityLabel[l.availability] }}</ToneBadge>
        <FIcon v-if="selected === l.user.id" name="check" :size="18" class="text-terracotta" />
      </button>
    </div>
    <p v-if="!loading && liaisons.length && !freeCount" class="mt-3 flex items-start gap-2 text-sm text-amber-ink">
      <FIcon name="info" :size="16" class="mt-0.5 shrink-0" /> Every messenger is busy or off duty right now. Try again once one has delivered.
    </p>

    <label class="field-label mt-4" for="pickup-remarks">Note for the messenger (optional)</label>
    <input id="pickup-remarks" v-model="remarks" class="input" placeholder="e.g. Handle with care — original signatures" maxlength="2000" />

    <template #footer>
      <button class="btn btn-ghost" @click="emit('close')">Cancel</button>
      <button class="btn btn-primary" :disabled="!selected || busy === 'request'" :aria-busy="busy === 'request'" @click="confirm">
        <FIcon name="truck" :size="16" /> {{ busy === 'request' ? 'Saving…' : reassigning ? 'Reassign & notify' : 'Assign & notify' }}
      </button>
    </template>
  </AppModal>
</template>
