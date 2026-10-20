<script setup lang="ts">
import type { FlowDocument } from '~/types'
import type { IssueFieldsModel } from '~/components/IssueFields.vue'

/**
 * Report an issue about this document without leaving its page. The priority follows the category (set by
 * the server); "Other" needs a description. Errors stay in the dialog; one submission at a time.
 */
const props = defineProps<{ open: boolean; doc: Pick<FlowDocument, 'id' | 'title'> | null }>()
const emit = defineEmits<{ close: []; reported: [] }>()

const api = useApi()
const ui = useUiStore()
const blank = (): IssueFieldsModel => ({ title: '', category: 'MISSING_DOCUMENT', details: '', otherText: '' })
const form = ref<IssueFieldsModel>(blank())
const error = ref('')
const sending = ref(false)

watch(
  () => props.open,
  (open) => {
    if (!open) return
    form.value = blank()
    error.value = ''
  },
)

async function submit() {
  if (!props.doc || sending.value) return
  if (!issueFormReady(form.value)) {
    error.value = form.value.category === 'OTHER' && form.value.title.trim() ? 'Describe what’s wrong with the document.' : 'Say what’s wrong.'
    return
  }
  sending.value = true
  error.value = ''
  try {
    await api.post('/issues', { document_id: props.doc.id, ...issueBody(form.value) })
    ui.success('Issue reported')
    emit('reported')
    emit('close')
  } catch (err) {
    error.value = apiErrorMessage(err, 'Could not report the issue')
  } finally {
    sending.value = false
  }
}
</script>

<template>
  <AppModal :open="open" title="Report an issue" :description="doc ? `About “${doc.title}”. The office handling it and the admin are told.` : undefined" @close="emit('close')">
    <form id="report-issue-form" class="space-y-4" novalidate @submit.prevent="submit">
      <IssueFields v-model="form" id-prefix="ri" />
      <p v-if="error" class="rounded-xl bg-danger/10 px-3 py-2 text-sm text-danger-ink" role="alert">{{ error }}</p>
    </form>
    <template #footer>
      <button class="btn btn-ghost" type="button" @click="emit('close')">Cancel</button>
      <button class="btn btn-primary" form="report-issue-form" :disabled="sending" :aria-busy="sending"><FIcon name="flag" :size="16" /> Report issue</button>
    </template>
  </AppModal>
</template>
