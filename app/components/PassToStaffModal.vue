<script setup lang="ts">
import type { FlowDocument } from '~/types'

/**
 * Desk to desk inside an office: the staff member who received the document passes it to the
 * next staff. The office is notified; another staff member scans the QR to receive it, and only
 * then can it be passed again or released to a messenger.
 */
const props = defineProps<{ open: boolean; doc: FlowDocument | null }>()
const emit = defineEmits<{ close: []; passed: [doc: FlowDocument] }>()

const { passToStaff } = useDocuments()
const { busy, run } = useAction()
const remarks = ref('')

watch(
  () => props.open,
  (open) => {
    if (open) remarks.value = ''
  },
)

async function confirm() {
  if (!props.doc) return
  const res = await run('pass', () => passToStaff(props.doc!.id, remarks.value.trim() || undefined), 'Passed to the next staff — your office has been notified')
  if (res) {
    emit('passed', res.document)
    emit('close')
  }
}
</script>

<template>
  <AppModal
    :open="open"
    title="Pass to the next staff"
    :description="`Hand the paper to the next desk at ${doc?.currentOffice?.name ?? 'your office'}. Another staff member scans its QR code to receive it.`"
    width="sm"
    @close="emit('close')"
  >
    <div class="mb-4 flex items-start gap-3 rounded-xl bg-amber/15 p-3 text-sm text-amber-ink">
      <FIcon name="info" :size="16" class="mt-0.5 shrink-0" />
      <span>Until the next staff receives it, nobody can assign a messenger to {{ doc?.next_office_name ?? 'the next office' }}. You can take it back before then.</span>
    </div>
    <label class="field-label" for="pass-remarks">Note for the next desk <span class="font-normal text-ink-2">(optional)</span></label>
    <textarea id="pass-remarks" v-model="remarks" class="input" rows="3" maxlength="2000" placeholder="e.g. For signature of the division chief" />
    <template #footer>
      <button class="btn btn-ghost" @click="emit('close')">Cancel</button>
      <button class="btn btn-primary" :disabled="busy === 'pass'" :aria-busy="busy === 'pass'" @click="confirm"><FIcon name="users" :size="16" /> Pass to next staff</button>
    </template>
  </AppModal>
</template>
