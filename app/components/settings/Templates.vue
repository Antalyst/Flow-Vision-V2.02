<script setup lang="ts">
import type { DocumentTemplateItem } from '~/types'

/**
 * Organization Settings: document templates — the letterheads the AI Assistant lays formal
 * documents on (logo, header lines, signature block, footer). The AI picks the template whose
 * description fits the document it drafts; the default one is used when none fits.
 */
const props = defineProps<{
  templates: DocumentTemplateItem[]
  organization: { name: string; logo_url: string | null }
  available: boolean
}>()
const emit = defineEmits<{ changed: [] }>()

const api = useApi()
const ui = useUiStore()
const { busy, run } = useAction()

const SAMPLE = `**MEMORANDUM**

**TO:** All Department Heads
**FROM:** Office of the City Administrator
**SUBJECT:** Submission of Quarterly Reports

Please submit your office's quarterly accomplishment report on or before **October 30, 2026**. Use the attached format and send it through FlowVision.

For your guidance and compliance.`

// ---------------------------------------------------------------------------
// Editor
// ---------------------------------------------------------------------------
const editorOpen = ref(false)
const editingId = ref<string | null>(null)
const blank = () => ({
  name: '',
  description: '',
  show_logo: true,
  header_text: `Republic of the Philippines\n${props.organization.name}`,
  body_guide: '',
  signatory_name: '',
  signatory_title: '',
  footer_text: '',
  is_default: false,
})
const form = reactive(blank())
const editing = computed(() => props.templates.find((t) => t.id === editingId.value) ?? null)

// A signature picked in the editor is uploaded when the template is saved.
const signatureFile = ref<File | null>(null)
const signaturePreview = ref<string | null>(null)
const removeSignature = ref(false)
function pickSignature(file?: File | null) {
  if (!file) return
  if (!/^image\/(png|jpe?g)$/.test(file.type)) return ui.error('Use a PNG or JPG image', 'A signature on a transparent PNG prints best.')
  if (file.size > 2 * 1024 * 1024) return ui.error('Image too large', 'Signatures can be up to 2 MB.')
  if (signaturePreview.value) URL.revokeObjectURL(signaturePreview.value)
  signatureFile.value = file
  signaturePreview.value = URL.createObjectURL(file)
  removeSignature.value = false
}
function clearSignature() {
  if (signaturePreview.value) URL.revokeObjectURL(signaturePreview.value)
  signatureFile.value = null
  signaturePreview.value = null
  removeSignature.value = Boolean(editing.value?.signature_url)
}
const shownSignature = computed(() => signaturePreview.value ?? (removeSignature.value ? null : (editing.value?.signature_url ?? null)))

function openEditor(t?: DocumentTemplateItem) {
  editingId.value = t?.id ?? null
  Object.assign(
    form,
    t
      ? {
          name: t.name,
          description: t.description ?? '',
          show_logo: t.show_logo,
          header_text: t.header_text ?? '',
          body_guide: t.body_guide ?? '',
          signatory_name: t.signatory_name ?? '',
          signatory_title: t.signatory_title ?? '',
          footer_text: t.footer_text ?? '',
          is_default: t.is_default,
        }
      : blank(),
  )
  clearSignature()
  removeSignature.value = false
  editorOpen.value = true
}

const preview = computed(() => ({ ...form, name: form.name || 'Template', signature_url: shownSignature.value }))

async function save() {
  if (!form.name.trim()) return
  const body = { ...form, name: form.name.trim() }
  const ok = await run('save', async () => {
    const res = editingId.value
      ? await api.patch<{ template: DocumentTemplateItem }>(`/org/templates/${editingId.value}`, body)
      : await api.post<{ template: DocumentTemplateItem }>('/org/templates', body)
    const id = res.template.id
    if (signatureFile.value) {
      const fd = new FormData()
      fd.append('file', signatureFile.value)
      await api.post(`/org/templates/${id}/signature`, fd)
    } else if (removeSignature.value) {
      await api.del(`/org/templates/${id}/signature`)
    }
    return res
  }, editingId.value ? 'Template saved' : `“${body.name}” added`)
  if (ok) {
    editorOpen.value = false
    clearSignature()
    emit('changed')
  }
}

// ---------------------------------------------------------------------------
// List actions
// ---------------------------------------------------------------------------
async function addStarters() {
  const res = await run('starter', () => api.post<{ templates: DocumentTemplateItem[] }>('/org/templates/starter'))
  if (res) {
    ui.success(res.templates.length ? `${res.templates.length} template${res.templates.length === 1 ? '' : 's'} added` : 'You already have them', res.templates.length ? 'Edit them to add your signatory and footer.' : undefined)
    emit('changed')
  }
}
async function makeDefault(t: DocumentTemplateItem) {
  if (await run(`def-${t.id}`, () => api.patch(`/org/templates/${t.id}`, { is_default: true }), `“${t.name}” is now the default`)) emit('changed')
}
async function toggle(t: DocumentTemplateItem) {
  const ok = await run(`act-${t.id}`, () => api.patch(`/org/templates/${t.id}`, { is_active: !t.is_active }), t.is_active ? `The AI no longer uses “${t.name}”` : `The AI uses “${t.name}” again`)
  if (ok) emit('changed')
}
async function remove(t: DocumentTemplateItem) {
  await ui.confirm({
    title: `Delete “${t.name}”?`,
    body: 'The AI stops using it. Documents already drafted with it keep their text.',
    confirmLabel: 'Delete template',
    busyLabel: 'Deleting…',
    action: async () => {
      if (await run(`del-${t.id}`, () => api.del(`/org/templates/${t.id}`), 'Template deleted')) emit('changed')
    },
  })
}
</script>

<template>
  <div class="space-y-6">
    <div v-if="!available" class="flex items-start gap-3 rounded-2xl border border-amber/40 bg-amber/12 p-4 text-sm text-amber-ink">
      <FIcon name="alert-triangle" :size="18" class="mt-0.5 shrink-0" />
      <span>Templates need their database table first. Run <code class="mono">npm run db:add-settings</code> on the server, then reload this page.</span>
    </div>

    <section class="card overflow-hidden">
      <div class="card-pad flex flex-wrap items-end justify-between gap-3 pb-3">
        <div class="max-w-2xl">
          <h2 class="text-lg">Document templates</h2>
          <p class="mt-1 text-sm text-ink-body">
            The letterhead the AI Assistant drafts formal documents on: your logo, header lines, a signature block and a footer. Keep one per kind of document — the AI reads each description and picks the
            template that fits, or the default. Every document also carries a note that it was created with FlowVision.
          </p>
        </div>
        <div class="flex flex-wrap gap-2">
          <button v-if="!templates.length" class="btn btn-ghost" :disabled="!!busy || !available" :aria-busy="busy === 'starter'" @click="addStarters"><FIcon name="zap" :size="16" /> Add starter templates</button>
          <button class="btn btn-primary" :disabled="!available" @click="openEditor()"><FIcon name="plus" :size="16" /> New template</button>
        </div>
      </div>

      <div v-if="!templates.length" class="px-6 pb-6">
        <EmptyState icon="layout" title="No templates yet" description="Start with the ready-made Memorandum, Official Letter and Report, or make your own." />
      </div>
      <ul v-else class="divide-y divide-line/60 border-t border-line/60">
        <li v-for="t in templates" :key="t.id" class="flex flex-col gap-3 p-4 sm:flex-row sm:items-start" :class="!t.is_active && 'opacity-60'">
          <span class="grid size-10 shrink-0 place-items-center rounded-xl" :class="TONE_CLASSES.primary"><FIcon name="file-text" :size="18" /></span>
          <div class="min-w-0 flex-1">
            <p class="flex flex-wrap items-center gap-2 text-sm font-semibold">
              {{ t.name }}
              <ToneBadge v-if="t.is_default" tone="success" dot>Default</ToneBadge>
              <ToneBadge v-if="!t.is_active" tone="neutral">Not used</ToneBadge>
            </p>
            <p v-if="t.description" class="mt-0.5 text-[13px] text-ink-body">{{ t.description }}</p>
            <p class="mt-1 flex flex-wrap gap-x-3 gap-y-1 text-xs text-ink-2">
              <span class="inline-flex items-center gap-1"><FIcon :name="t.show_logo ? 'image' : 'minus-circle'" :size="12" /> {{ t.show_logo ? 'Logo' : 'No logo' }}</span>
              <span v-if="t.signatory_name" class="inline-flex items-center gap-1"><FIcon name="pen-tool" :size="12" /> {{ t.signatory_name }}<template v-if="t.signature_url"> · signature image</template></span>
              <span v-if="t.footer_text" class="inline-flex items-center gap-1"><FIcon name="align-center" :size="12" /> Footer</span>
            </p>
          </div>
          <div class="flex shrink-0 flex-wrap gap-1">
            <button v-if="!t.is_default && t.is_active" class="btn btn-sm btn-ghost" :disabled="busy === `def-${t.id}`" :aria-busy="busy === `def-${t.id}`" @click="makeDefault(t)">Make default</button>
            <button class="btn btn-sm btn-ghost" :title="t.is_active ? 'Stop using' : 'Use again'" :disabled="busy === `act-${t.id}`" :aria-busy="busy === `act-${t.id}`" @click="toggle(t)">
              <FIcon :name="t.is_active ? 'eye-off' : 'eye'" :size="14" />
            </button>
            <button class="btn btn-sm btn-ghost" title="Edit" @click="openEditor(t)"><FIcon name="edit-2" :size="14" /></button>
            <button class="btn btn-sm btn-ghost text-danger-ink" title="Delete" :disabled="busy === `del-${t.id}`" :aria-busy="busy === `del-${t.id}`" @click="remove(t)"><FIcon name="trash-2" :size="14" /></button>
          </div>
        </li>
      </ul>
    </section>

    <AppModal :open="editorOpen" :title="editingId ? `Edit “${editing?.name}”` : 'New template'" description="Changes show in the preview as you type." width="lg" @close="editorOpen = false">
      <div class="grid grid-cols-1 gap-6 xl:grid-cols-2">
        <form id="template-form" class="space-y-3" @submit.prevent="save">
          <div>
            <label class="field-label" for="tpl-name">Name</label>
            <input id="tpl-name" v-model="form.name" class="input" maxlength="100" placeholder="e.g. Memorandum" required />
          </div>
          <div>
            <label class="field-label" for="tpl-desc">When to use it <span class="font-normal text-ink-2">(the AI reads this)</span></label>
            <textarea id="tpl-desc" v-model="form.description" class="input" rows="2" maxlength="500" placeholder="e.g. Internal memos and office orders to staff" />
          </div>
          <div>
            <label class="field-label" for="tpl-header">Letterhead lines</label>
            <textarea id="tpl-header" v-model="form.header_text" class="input" rows="3" maxlength="1000" placeholder="One line each; the last line stands out" />
            <label class="mt-2 flex items-center gap-2 text-sm text-ink-body">
              <input v-model="form.show_logo" type="checkbox" class="size-4 accent-[var(--lumio-accent-primary)]" /> Show the organization logo
              <span v-if="!organization.logo_url" class="text-xs text-ink-2">(upload it on the Organization tab)</span>
            </label>
          </div>
          <div>
            <label class="field-label" for="tpl-guide">Body guide <span class="font-normal text-ink-2">(optional — structure the AI follows)</span></label>
            <textarea id="tpl-guide" v-model="form.body_guide" class="input font-mono text-[12.5px]" rows="4" maxlength="3000" placeholder="e.g. **MEMORANDUM** / **TO:** … / **FROM:** … / **SUBJECT:** …" />
          </div>
          <fieldset class="rounded-2xl border border-line/80 p-3">
            <legend class="px-1 text-xs font-semibold text-ink-2">Signature block</legend>
            <div class="grid grid-cols-1 gap-2 sm:grid-cols-2">
              <div>
                <label class="field-label" for="tpl-sig-name">Name</label>
                <input id="tpl-sig-name" v-model="form.signatory_name" class="input" maxlength="150" placeholder="e.g. Juan Dela Cruz" />
              </div>
              <div>
                <label class="field-label" for="tpl-sig-title">Position</label>
                <input id="tpl-sig-title" v-model="form.signatory_title" class="input" maxlength="150" placeholder="e.g. City Administrator" />
              </div>
            </div>
            <div class="mt-3 flex flex-wrap items-center gap-2">
              <label class="btn btn-sm btn-ghost cursor-pointer">
                <input type="file" accept="image/png,image/jpeg" class="sr-only" @change="pickSignature(($event.target as HTMLInputElement).files?.[0]); ($event.target as HTMLInputElement).value = ''" />
                <FIcon name="pen-tool" :size="14" /> {{ shownSignature ? 'Replace signature image' : 'Add signature image' }}
              </label>
              <button v-if="shownSignature" type="button" class="btn btn-sm btn-ghost text-danger-ink" @click="clearSignature">Remove image</button>
              <span class="text-xs text-ink-2">Optional. A transparent PNG prints best.</span>
            </div>
          </fieldset>
          <div>
            <label class="field-label" for="tpl-footer">Footer</label>
            <input id="tpl-footer" v-model="form.footer_text" class="input" maxlength="500" placeholder="e.g. City Hall, Bago City · (034) 461-0000 · bagocity.gov.ph" />
          </div>
          <label class="flex items-center gap-2 text-sm text-ink-body">
            <input v-model="form.is_default" type="checkbox" class="size-4 accent-[var(--lumio-accent-primary)]" /> Default template (used when no other fits)
          </label>
        </form>

        <div class="min-w-0">
          <p class="eyebrow mb-2">Preview</p>
          <DocumentSheet :title="form.name || 'Document'" :markdown="form.body_guide || SAMPLE" :template="preview" :org-name="organization.name" :logo-url="organization.logo_url" :signature-src="shownSignature" />
        </div>
      </div>
      <template #footer>
        <button class="btn btn-ghost" @click="editorOpen = false">Cancel</button>
        <button type="submit" form="template-form" class="btn btn-primary" :disabled="busy === 'save' || !form.name.trim()" :aria-busy="busy === 'save'">{{ busy === 'save' ? 'Saving…' : 'Save template' }}</button>
      </template>
    </AppModal>
  </div>
</template>
