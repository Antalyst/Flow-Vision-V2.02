<script setup lang="ts">
import type { FlowDocument, LiaisonProfile } from '~/types'

interface LiaisonRow extends LiaisonProfile {
  user: { id: string; first_name: string; last_name: string }
}

/**
 * Flag an issue and send the document back to the previous office on its route. The person who
 * received it here picks one of this office's free messengers; the issue is flagged and moves to
 * "In progress", and the messenger, the previous office and the uploader are notified.
 */
const props = defineProps<{ open: boolean; doc: FlowDocument | null }>()
const emit = defineEmits<{ close: []; sent: [doc: FlowDocument] }>()

const api = useApi()
const { busy, run } = useAction()

const CATEGORIES = ['MISSING_DOCUMENT', 'DELAY', 'DAMAGE', 'INCORRECT_ROUTING', 'OTHER']
const label = (s: string) => s.replace(/_/g, ' ').toLowerCase().replace(/^\w/, (c) => c.toUpperCase())

const form = reactive({ title: '', description: '', category: 'MISSING_DOCUMENT', severity: 'MEDIUM' })
const liaisons = ref<LiaisonRow[]>([])
const selected = ref<string | null>(null)
const free = computed(() => liaisons.value.filter((l) => l.availability === 'AVAILABLE'))

watch(
  () => props.open,
  async (open) => {
    if (!open) return
    Object.assign(form, { title: '', description: '', category: 'MISSING_DOCUMENT', severity: 'MEDIUM' })
    selected.value = null
    liaisons.value = (await api.get<{ data: LiaisonRow[] }>('/liaisons', { document_id: props.doc?.id })).data
  },
)

async function confirm() {
  if (!props.doc || !selected.value || !form.title.trim()) return
  const res = await run(
    'sendback',
    () => api.post<{ document: FlowDocument }>(`/documents/${props.doc!.id}/send-back`, { ...form, liaison_user_id: selected.value }),
    'Issue flagged — the messenger and the previous office have been notified',
  )
  if (res) {
    emit('sent', res.document)
    emit('close')
  }
}
</script>

<template>
  <AppModal :open="open" title="Flag issue & send back" description="The document goes back to the previous office on its route with one of your office's messengers." @close="emit('close')">
    <form id="send-back-form" class="space-y-4" @submit.prevent="confirm">
      <div>
        <label class="field-label" for="sb-title">What's wrong?</label>
        <input id="sb-title" v-model="form.title" class="input" required maxlength="255" placeholder="e.g. Missing signature of the department head" />
      </div>
      <div class="grid grid-cols-1 gap-4 sm:grid-cols-2">
        <div>
          <label class="field-label" for="sb-cat">Category</label>
          <select id="sb-cat" v-model="form.category" class="input">
            <option v-for="c in CATEGORIES" :key="c" :value="c">{{ label(c) }}</option>
          </select>
        </div>
        <div>
          <label class="field-label" for="sb-sev">Severity</label>
          <select id="sb-sev" v-model="form.severity" class="input">
            <option v-for="s in ['LOW', 'MEDIUM', 'HIGH', 'CRITICAL']" :key="s" :value="s">{{ label(s) }}</option>
          </select>
        </div>
      </div>
      <div>
        <label class="field-label" for="sb-desc">Details <span class="font-normal text-ink-2">(optional)</span></label>
        <textarea id="sb-desc" v-model="form.description" class="input" rows="3" maxlength="5000" />
      </div>
      <div>
        <p class="field-label">Messenger to take it back</p>
        <p v-if="!free.length" class="text-sm text-amber-ink">None of your office's messengers is free right now.</p>
        <div v-else class="max-h-56 space-y-2 overflow-y-auto">
          <button
            v-for="l in free"
            :key="l.id"
            type="button"
            class="flex w-full items-center gap-3 rounded-xl border p-3 text-left"
            :class="selected === l.user.id ? 'border-terracotta bg-terracotta/[0.06]' : 'border-line hover:bg-card'"
            :aria-pressed="selected === l.user.id"
            @click="selected = l.user.id"
          >
            <UserAvatar :user="l.user" />
            <span class="flex-1 text-sm font-semibold">{{ fullName(l.user) }}</span>
            <FIcon v-if="selected === l.user.id" name="check" :size="18" class="text-terracotta" />
          </button>
        </div>
      </div>
    </form>
    <template #footer>
      <button class="btn btn-ghost" @click="emit('close')">Cancel</button>
      <button class="btn btn-danger" form="send-back-form" :disabled="!selected || !form.title.trim() || busy === 'sendback'" :aria-busy="busy === 'sendback'">
        <FIcon name="flag" :size="16" /> Flag &amp; send back
      </button>
    </template>
  </AppModal>
</template>
