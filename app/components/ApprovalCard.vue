<script setup lang="ts">
import type { Approval } from '~/types'

/** C2: one pending approval at the final checkpoint, with approve / return controls. */
const props = defineProps<{ approval: Approval }>()
const emit = defineEmits<{ decided: [approvalId: string] }>()

const api = useApi()
const { openFile } = useDocuments()
const { busy, run } = useAction()
const remarks = ref('')
const remarksError = ref('')

const doc = computed(() => props.approval.document!)
const waitingFor = computed(() => timeAgo(props.approval.requested_at).replace(' ago', ''))

async function decide(decision: 'APPROVED' | 'RETURNED') {
  remarksError.value = ''
  if (decision === 'RETURNED' && !remarks.value.trim()) {
    remarksError.value = 'Explain why the document is being returned.'
    return
  }
  const ok = await run(
    decision,
    () => api.patch(`/approvals/${props.approval.id}`, { decision, remarks: remarks.value.trim() || undefined }),
    decision === 'APPROVED' ? `${doc.value.tracking_number} approved` : `${doc.value.tracking_number} returned to submitter`,
  )
  if (ok) emit('decided', props.approval.id)
}
</script>

<template>
  <article class="card card-pad">
    <div class="flex flex-wrap items-start justify-between gap-3">
      <div class="min-w-0">
        <div class="flex flex-wrap items-center gap-2">
          <span class="mono text-ink-2">{{ doc.tracking_number }}</span>
          <PriorityBadge :priority="doc.priority" />
          <ToneBadge tone="warning" icon="clock">Waiting {{ waitingFor }}</ToneBadge>
        </div>
        <NuxtLink :to="`/documents/${doc.id}`" class="mt-1.5 block font-display text-lg font-semibold tracking-tight hover:text-terracotta-ink">
          {{ doc.title }}
        </NuxtLink>
        <p class="mt-1 text-[13px] text-ink-body">
          {{ doc.document_type ?? 'Document' }} · submitted by {{ fullName(doc.submitter) }} · {{ formatDate(doc.submitted_at) }}
        </p>
      </div>
      <button v-if="doc.file_name" class="btn btn-sm btn-ghost" @click="openFile(doc)">
        <FIcon name="paperclip" :size="15" /> {{ doc.file_name }}
      </button>
    </div>

    <p v-if="doc.description" class="mt-4 rounded-xl bg-ink/[0.035] px-4 py-3 text-sm text-ink-body">{{ doc.description }}</p>

    <label class="field-label mt-5" :for="`remarks-${approval.id}`">Remarks <span class="font-normal text-ink-2">(required when returning)</span></label>
    <textarea
      :id="`remarks-${approval.id}`"
      v-model="remarks"
      rows="2"
      class="input"
      placeholder="Add a note for the submitter"
      maxlength="2000"
      :aria-invalid="Boolean(remarksError)"
    />
    <p v-if="remarksError" class="mt-1.5 text-xs text-danger-ink">{{ remarksError }}</p>

    <div class="mt-4 flex flex-wrap justify-end gap-2">
      <button class="btn btn-danger" :disabled="Boolean(busy)" :aria-busy="busy === 'RETURNED'" @click="decide('RETURNED')">
        <FIcon name="corner-up-left" :size="16" /> {{ busy === 'RETURNED' ? 'Returning…' : 'Return' }}
      </button>
      <button class="btn btn-success" :disabled="Boolean(busy)" :aria-busy="busy === 'APPROVED'" @click="decide('APPROVED')">
        <FIcon name="check" :size="16" /> {{ busy === 'APPROVED' ? 'Approving…' : 'Approve & complete' }}
      </button>
    </div>
  </article>
</template>
