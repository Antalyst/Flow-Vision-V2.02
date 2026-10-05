<script setup lang="ts">
import type { DocumentTypeItem, OrgRoute } from '~/types'

useHead({ title: 'Upload document · FlowVision' })

const docsApi = useDocuments()
const auth = useAuthStore()
const query = useRoute().query
const { data: routeData } = await useAsyncData('upload-routes', () => useRoutes().list())
const routes = computed<OrgRoute[]>(() => routeData.value?.data ?? [])

const STEPS = ['Upload', 'Details', 'Route', 'Review']
const step = ref(0)

// The organization's own document types (Organization Settings); "Other" is always available.
const { data: typeData } = await useAsyncData('upload-document-types', () => useApi().get<{ data: DocumentTypeItem[] }>('/document-types'))
const docTypes = computed(() => (typeData.value?.data ?? []).map((t) => t.name))
const form = reactive({
  title: '',
  document_type: '',
  description: '',
  // ?route=<id> preselects a route; with a single route there is nothing to choose.
  route_id: (typeof query.route === 'string' && query.route) || '',
})
watchEffect(() => {
  if (!routes.value.some((r) => r.id === form.route_id)) form.route_id = routes.value.length === 1 ? routes.value[0]!.id : ''
})
const selectedRoute = computed(() => routes.value.find((r) => r.id === form.route_id) ?? null)

const file = ref<File | null>(null)
const dragging = ref(false)
const submitting = ref<'draft' | 'submit' | null>(null)
const ui = useUiStore()

const ACCEPT = '.pdf,.png,.jpg,.jpeg,.webp,.doc,.docx,.xls,.xlsx'
const MAX_MB = 20

/**
 * PDF, Word, Excel and image files are all accepted. Only PDF and Word (.docx) carry text the AI
 * can read; for images, spreadsheets and old .doc files the title and description are typed in.
 */
type FileKind = 'ai' | 'image' | 'excel' | 'old-word'
const KINDS: Record<string, FileKind> = { pdf: 'ai', docx: 'ai', doc: 'old-word', xls: 'excel', xlsx: 'excel', png: 'image', jpg: 'image', jpeg: 'image', webp: 'image' }
const MANUAL_REASON: Record<Exclude<FileKind, 'ai'>, string> = {
  image: 'This is an image, so the AI can’t read it. Type the title and description yourself.',
  excel: 'This is an Excel spreadsheet, so the AI can’t read it. Type the title and description yourself.',
  'old-word': 'Older Word files (.doc) can’t be read by the AI. Type the details yourself, or save it as .docx to use auto-fill.',
}
const manualReason = ref('')
const preview = ref<string | null>(null)

function pickFile(f?: File | null) {
  if (!f) return
  const kind = KINDS[f.name.split('.').pop()?.toLowerCase() ?? '']
  // Dropped files skip the picker's filter, so check the type here too.
  if (!kind) {
    ui.error('Unsupported file', 'Attach a PDF, Word, Excel or image file (PNG, JPG, WebP).')
    return
  }
  if (f.size > MAX_MB * 1024 * 1024) {
    ui.error('File too large', `Attachments can be up to ${MAX_MB} MB.`)
    return
  }
  file.value = f
  if (preview.value) URL.revokeObjectURL(preview.value)
  preview.value = kind === 'image' ? URL.createObjectURL(f) : null

  if (kind === 'ai') {
    manualReason.value = ''
    analyze(f)
    return
  }
  // Not readable by the AI: skip it and go straight to typing the details.
  analyzeRun++
  analyzing.value = false
  aiFilled.value = false
  aiNote.value = ''
  manualReason.value = MANUAL_REASON[kind]
  if (step.value === 0) step.value = 1
}

function clearFile() {
  file.value = null
  aiFilled.value = false
  aiNote.value = ''
  manualReason.value = ''
  analyzeRun++
  analyzing.value = false
  if (preview.value) URL.revokeObjectURL(preview.value)
  preview.value = null
}
onBeforeUnmount(() => preview.value && URL.revokeObjectURL(preview.value))

// AI reads the upload and pre-fills the details; the user can still edit them before saving.
const analyzing = ref(false)
const aiFilled = ref(false)
const aiNote = ref('')
let analyzeRun = 0
async function analyze(f: File) {
  const run = ++analyzeRun
  analyzing.value = true
  aiNote.value = ''
  try {
    const fd = new FormData()
    fd.append('file', f)
    const { suggestion } = await docsApi.analyze(fd)
    if (run !== analyzeRun) return
    if (suggestion.title) form.title = suggestion.title
    if (suggestion.description) form.description = suggestion.description
    if (suggestion.document_type) form.document_type = suggestion.document_type
    aiFilled.value = Boolean(suggestion.title)
    if (step.value === 0) step.value = 1
  } catch (err) {
    if (run !== analyzeRun) return
    aiFilled.value = false
    aiNote.value = apiErrorMessage(err)
  } finally {
    if (run === analyzeRun) analyzing.value = false
  }
}
function onDrop(e: DragEvent) {
  dragging.value = false
  pickFile(e.dataTransfer?.files?.[0])
}

// A step can be reached once every step before it is complete.
const stepDone = computed(() => [!analyzing.value, form.title.trim().length > 0, Boolean(selectedRoute.value), true])
const reachable = (i: number) => stepDone.value.slice(0, i).every(Boolean)
const canNext = computed(() => stepDone.value[step.value])
const canSave = computed(() => stepDone.value[0] && stepDone.value[1] && stepDone.value[2])

const officeChain = (r: OrgRoute) => r.steps.map((s) => s.office?.name ?? '—').join(' → ')
// The chosen document type's processing time sets the target completion; priority is worked out on the server.
const selectedType = computed(() => (typeData.value?.data ?? []).find((t) => t.name === form.document_type) ?? null)
const deadlineText = computed(() =>
  selectedType.value?.total_hours ? `${formatSla(selectedType.value.total_hours)} after submission` : form.document_type ? 'No time limit for this type' : 'Pick a document type',
)

async function send(submit: boolean) {
  submitting.value = submit ? 'submit' : 'draft'
  try {
    const fd = new FormData()
    for (const [k, v] of Object.entries(form)) if (v) fd.append(k, v)
    fd.append('submit', String(submit))
    if (file.value) fd.append('file', file.value)
    const { document } = await docsApi.create(fd)
    ui.success(submit ? 'Document submitted — printing it with its QR' : 'Draft saved — printing it with its QR', `${document.qr_code ?? document.tracking_number} · ${document.title}`)
    // The document page prints the QR label as soon as it opens.
    await navigateTo({ path: `/documents/${document.id}`, query: { print: '1' } })
  } catch (err) {
    ui.error(submit ? 'Could not submit' : 'Could not save draft', apiErrorMessage(err))
  } finally {
    submitting.value = null
  }
}
</script>

<template>
  <div class="fv-rise mx-auto max-w-3xl">
    <PageHeader eyebrow="A5 · Submission" title="Upload a document" description="Pick the Document Route it should follow. When you save, the document prints with its QR code on it, and you can follow it live from there." />

    <div v-if="!routes.length" class="mb-6 flex items-center gap-3 rounded-2xl border border-amber/40 bg-amber/12 p-4 text-sm text-amber-ink">
      <FIcon name="alert-triangle" :size="18" />
      <span class="flex-1">
        There's no Document Route yet, so documents can't be uploaded.<template v-if="auth.role !== 'CLIENT'"> Ask your administrator to create one.</template>
      </span>
      <NuxtLink v-if="auth.role === 'CLIENT'" to="/client/routes" class="font-semibold underline">Create route</NuxtLink>
    </div>

    <!-- Stepper -->
    <ol class="mb-6 grid grid-cols-4 gap-2" aria-label="Progress">
      <li v-for="(label, i) in STEPS" :key="label">
        <button type="button" class="w-full text-left" :disabled="!reachable(i)" :aria-current="i === step ? 'step' : undefined" @click="step = i">
          <span class="block h-1 rounded-full transition-colors" :class="i <= step ? 'bg-terracotta' : 'bg-line'" />
          <span class="mt-2 hidden text-xs font-medium sm:block" :class="i === step ? 'text-ink' : 'text-ink-2'">{{ i + 1 }}. {{ label }}</span>
        </button>
      </li>
    </ol>

    <section class="card card-pad">
      <!-- 1. Upload -->
      <div v-if="step === 0">
        <label
          class="flex cursor-pointer flex-col items-center justify-center rounded-2xl border-2 border-dashed px-6 py-12 text-center transition-colors"
          :class="dragging ? 'border-terracotta bg-terracotta/[0.05]' : 'border-line hover:border-ink-3'"
          @dragover.prevent="dragging = true"
          @dragleave.prevent="dragging = false"
          @drop.prevent="onDrop"
        >
          <input type="file" class="sr-only" :accept="ACCEPT" @change="pickFile(($event.target as HTMLInputElement).files?.[0])" />
          <span class="grid size-12 place-items-center rounded-2xl bg-terracotta/12 text-terracotta-ink"><FIcon name="upload-cloud" /></span>
          <span class="mt-4 text-sm font-semibold">Drop a file or click to browse</span>
          <span class="mt-1 text-xs text-ink-2">PDF, Word, Excel or image (PNG, JPG, WebP) · up to {{ MAX_MB }} MB</span>
          <span class="mt-0.5 text-xs text-ink-2">AI fills in the details from PDF and Word (.docx) files; for images and Excel you type them in.</span>
        </label>
        <div v-if="file" class="mt-4 flex items-center gap-3 rounded-xl bg-ink/[0.04] p-3">
          <img v-if="preview" :src="preview" alt="" class="size-12 shrink-0 rounded-lg object-cover" />
          <FIcon v-else name="file" :size="18" class="text-ink-2" />
          <span class="min-w-0 flex-1">
            <span class="block truncate text-sm font-medium">{{ file.name }}</span>
            <span class="text-xs text-ink-2">{{ formatBytes(file.size) }}</span>
          </span>
          <FIcon v-if="analyzing" name="loader" :size="16" class="animate-spin text-terracotta" />
          <button class="grid size-9 place-items-center rounded-lg text-ink-2 hover:bg-ink/5" aria-label="Remove file" @click="clearFile"><FIcon name="x" :size="16" /></button>
        </div>
        <p v-if="manualReason" class="mt-3 flex items-start gap-2 text-sm text-info-ink"><FIcon name="edit-3" :size="16" class="mt-0.5 shrink-0" /> {{ manualReason }}</p>
        <p v-else-if="aiNote" class="mt-3 flex items-start gap-2 text-sm text-amber-ink"><FIcon name="info" :size="16" class="mt-0.5 shrink-0" /> {{ aiNote }} You can type the details yourself in the next step.</p>
        <p v-else-if="!file" class="mt-3 text-xs text-ink-2">No file? Continue and type the details yourself.</p>
      </div>

      <!-- 2. Details -->
      <div v-else-if="step === 1" class="space-y-4">
        <div v-if="analyzing" class="flex items-center gap-3 rounded-2xl bg-terracotta/[0.07] p-4 text-sm text-terracotta-ink">
          <FIcon name="loader" :size="18" class="animate-spin" /> Reading your document…
        </div>
        <div v-else-if="aiFilled" class="flex items-center gap-3 rounded-2xl bg-terracotta/[0.07] p-4 text-sm text-terracotta-ink">
          <FIcon name="zap" :size="18" /> <span class="flex-1">Filled in by AI from <strong>{{ file?.name }}</strong>. Check it and edit anything that's off.</span>
        </div>
        <div v-else-if="manualReason" class="flex items-start gap-3 rounded-2xl bg-info/10 p-4 text-sm text-info-ink">
          <img v-if="preview" :src="preview" alt="Preview of the uploaded image" class="h-20 w-20 shrink-0 rounded-lg object-cover" />
          <FIcon v-else name="edit-3" :size="18" class="mt-0.5 shrink-0" />
          <span class="flex-1">{{ manualReason }} Pick the document type too.</span>
        </div>
        <div>
          <label class="field-label" for="title">Title</label>
          <input id="title" v-model="form.title" class="input" maxlength="255" placeholder="e.g. Purchase request — Office supplies Q4" :disabled="analyzing" />
        </div>
        <div>
          <label class="field-label" for="type">Document type</label>
          <select v-if="docTypes.length" id="type" v-model="form.document_type" class="input">
            <option value="">Choose a type…</option>
            <option v-for="t in docTypes" :key="t" :value="t">{{ t }}</option>
            <option value="Other">Other</option>
          </select>
          <input v-else id="type" v-model="form.document_type" class="input" maxlength="100" placeholder="e.g. Purchase Request" />
          <p v-if="selectedType" class="mt-1 flex items-center gap-1 text-xs text-ink-2">
            <FIcon name="clock" :size="12" /> {{ selectedType.total_hours ? `Should be processed within ${formatSla(selectedType.total_hours)} of submission` : 'No time limit for this type' }}
          </p>
          <p v-if="!docTypes.length && auth.role === 'CLIENT'" class="mt-1 text-xs text-ink-2">
            Set up your document types in <NuxtLink to="/client/settings?tab=types" class="underline">Organization Settings</NuxtLink>.
          </p>
        </div>
        <div>
          <label class="field-label" for="desc">Description</label>
          <textarea id="desc" v-model="form.description" class="input" rows="4" maxlength="5000" placeholder="What is this document and what should each office do with it?" />
        </div>
      </div>

      <!-- 3. Route -->
      <fieldset v-else-if="step === 2">
        <legend class="field-label">Which route should this document follow?</legend>
        <p v-if="!routes.length" class="text-sm text-ink-2">No routes available yet.</p>
        <div class="mt-1 space-y-2">
          <label
            v-for="r in routes"
            :key="r.id"
            class="flex cursor-pointer items-start gap-3 rounded-xl border p-4 transition-colors"
            :class="form.route_id === r.id ? 'border-terracotta bg-terracotta/[0.06]' : 'border-line hover:bg-card'"
          >
            <input v-model="form.route_id" type="radio" name="route" :value="r.id" class="mt-1 accent-terracotta" />
            <span class="min-w-0 flex-1">
              <span class="flex flex-wrap items-center gap-2">
                <span class="text-sm font-semibold">{{ r.name }}</span>
                <span class="text-xs text-ink-2">{{ r.steps.length }} step{{ r.steps.length === 1 ? '' : 's' }}</span>
              </span>
              <span v-if="r.description" class="mt-0.5 block text-sm text-ink-body">{{ r.description }}</span>
              <span class="mt-1.5 block text-xs text-ink-2">{{ officeChain(r) }}</span>
            </span>
          </label>
        </div>
        <div v-if="selectedRoute" class="mt-6 border-t border-line/60 pt-5"><RouteFlow :steps="selectedRoute.steps" /></div>
      </fieldset>

      <!-- 4. Review -->
      <div v-else class="space-y-5">
        <dl class="grid grid-cols-1 gap-4 sm:grid-cols-2">
          <div class="sm:col-span-2">
            <dt class="eyebrow">Title</dt>
            <dd class="mt-1 font-display text-lg font-semibold">{{ form.title }}</dd>
          </div>
          <div>
            <dt class="eyebrow">Type</dt>
            <dd class="mt-1 text-sm">{{ form.document_type || '—' }}</dd>
          </div>
          <div>
            <dt class="eyebrow">Priority</dt>
            <dd class="mt-1 text-sm text-ink-body">Set automatically from the document and its route</dd>
          </div>
          <div>
            <dt class="eyebrow">Target completion</dt>
            <dd class="mt-1 text-sm">{{ deadlineText }}</dd>
          </div>
          <div>
            <dt class="eyebrow">Attachment</dt>
            <dd class="mt-1 truncate text-sm">{{ file?.name ?? 'None' }}</dd>
          </div>
          <div v-if="form.description" class="sm:col-span-2">
            <dt class="eyebrow">Description</dt>
            <dd class="mt-1 text-sm whitespace-pre-wrap text-ink-body">{{ form.description }}</dd>
          </div>
        </dl>
        <div v-if="selectedRoute" class="border-t border-line/60 pt-5">
          <p class="eyebrow mb-4">It will follow: {{ selectedRoute.name }}</p>
          <RouteFlow :steps="selectedRoute.steps" />
        </div>
      </div>

      <div class="mt-8 flex flex-col-reverse gap-2 border-t border-line/60 pt-5 sm:flex-row sm:items-center">
        <button v-if="step > 0" class="btn btn-ghost" @click="step--"><FIcon name="arrow-left" :size="16" /> Back</button>
        <div class="flex-1" />
        <button class="btn btn-ghost" :disabled="!canSave || Boolean(submitting)" @click="send(false)">
          {{ submitting === 'draft' ? 'Saving…' : 'Save draft' }}
        </button>
        <button v-if="step < STEPS.length - 1" class="btn btn-primary" :disabled="!canNext" @click="step++">
          Continue <FIcon name="arrow-right" :size="16" />
        </button>
        <button v-else class="btn btn-primary" :disabled="!canSave || Boolean(submitting)" @click="send(true)">
          <FIcon name="send" :size="16" /> {{ submitting === 'submit' ? 'Submitting…' : 'Submit to route' }}
        </button>
      </div>
    </section>
  </div>
</template>
