<script setup lang="ts">
import type { FlowDocument } from '~/types'
import type { IssueFieldsModel } from '~/components/IssueFields.vue'

interface ReturnLiaison {
  id: string
  first_name: string
  last_name: string
  office: { id: string; name: string } | null
  available: boolean
  busy: boolean
  uploader_unit: boolean
  recommended: boolean
}

/**
 * Flag an issue and send the document back to the previous office on its route. No messenger is picked
 * here: every liaison of that office (and its umbrella offices) on duty is told, and any one of them claims
 * the pickup. The issue is flagged (its priority follows the category) and moves to "In progress".
 */
const props = defineProps<{ open: boolean; doc: FlowDocument | null }>()
const emit = defineEmits<{ close: []; sent: [doc: FlowDocument] }>()

const api = useApi()
const ui = useUiStore()
const blank = (): IssueFieldsModel => ({ title: '', category: 'MISSING_DOCUMENT', details: '', otherText: '' })
const form = ref<IssueFieldsModel>(blank())
const target = ref<{ id: string; name: string } | null>(null)
const liaisons = ref<ReturnLiaison[]>([])
const error = ref('')
const sending = ref(false)
const onDuty = computed(() => liaisons.value.filter((l) => l.available))

watch(
  () => props.open,
  async (open) => {
    if (!open) return
    form.value = blank()
    error.value = ''
    target.value = null
    liaisons.value = []
    try {
      const r = await api.get<{ office: { id: string; name: string } | null; liaisons: ReturnLiaison[] }>(`/documents/${props.doc!.id}/return-liaisons`)
      target.value = r.office
      liaisons.value = r.liaisons
    } catch (err) {
      error.value = apiErrorMessage(err, 'Could not load where it goes back to')
    }
  },
)

async function confirm() {
  if (!props.doc || sending.value) return
  if (!issueFormReady(form.value)) {
    error.value = form.value.category === 'OTHER' && form.value.title.trim() ? 'Describe what’s wrong with the document.' : 'Say what’s wrong.'
    return
  }
  sending.value = true
  error.value = ''
  try {
    const res = await api.post<{ document: FlowDocument }>(`/documents/${props.doc.id}/send-back`, issueBody(form.value))
    ui.success('Issue flagged — the previous office’s liaisons were told to pick it up')
    emit('sent', res.document)
    emit('close')
  } catch (err) {
    error.value = apiErrorMessage(err, 'Could not send it back')
  } finally {
    sending.value = false
  }
}
</script>

<template>
  <AppModal :open="open" title="Flag issue & send back" :description="`The document goes back to ${target?.name ?? 'the previous office'}. Its liaisons are told, and one of them comes for it.`" @close="emit('close')">
    <form id="send-back-form" class="space-y-4" novalidate @submit.prevent="confirm">
      <IssueFields v-model="form" id-prefix="sb" />
      <div>
        <p class="field-label">Who will pick it up</p>
        <p v-if="!liaisons.length" class="text-sm text-amber-ink">{{ target ? `${target.name} has no liaisons yet: the document waits here until one is added and claims it.` : 'Loading…' }}</p>
        <template v-else>
          <p class="mb-2 text-sm text-ink-body">
            {{ onDuty.length }} liaison{{ onDuty.length === 1 ? '' : 's' }} of {{ target?.name }} on duty will be notified; any of them can claim it.
          </p>
          <ul class="max-h-48 space-y-1.5 overflow-y-auto text-sm">
            <li v-for="l in liaisons" :key="l.id" class="flex flex-wrap items-center gap-2 rounded-xl border border-line/70 px-3 py-2">
              <span class="font-medium">{{ l.first_name }} {{ l.last_name }}</span>
              <span class="text-xs text-ink-2">{{ l.office?.name }}</span>
              <ToneBadge v-if="l.recommended" tone="success" icon="star">Recommended</ToneBadge>
              <ToneBadge v-else-if="l.uploader_unit" tone="info">Uploader’s unit</ToneBadge>
              <ToneBadge v-if="!l.available" tone="neutral">Off duty</ToneBadge>
              <ToneBadge v-else-if="l.busy" tone="warning">Busy</ToneBadge>
            </li>
          </ul>
        </template>
      </div>
      <p v-if="error" class="rounded-xl bg-danger/10 px-3 py-2 text-sm text-danger-ink" role="alert">{{ error }}</p>
    </form>
    <template #footer>
      <button class="btn btn-ghost" type="button" @click="emit('close')">Cancel</button>
      <button class="btn btn-danger" form="send-back-form" :disabled="sending || !target" :aria-busy="sending"><FIcon name="flag" :size="16" /> Flag &amp; send back</button>
    </template>
  </AppModal>
</template>
