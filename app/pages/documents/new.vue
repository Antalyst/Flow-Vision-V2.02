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

const dragging = ref(false)
const submitting = ref<'draft' | 'submit' | null>(null)
const ui = useUiStore()

const ACCEPT = '.pdf,.png,.jpg,.jpeg,.webp,.doc,.docx,.xls,.xlsx'
const MAX_MB = 20
// A bulk upload: up to this many files under one document and one QR code (the server allows 50).
const MAX_FILES = 50

/**
 * PDF, Word, Excel and image files are all accepted. Only PDF and Word (.docx) carry text the AI
 * can read; for images, spreadsheets and old .doc files the title and description are typed in.
 */
type FileKind = 'ai' | 'image' | 'excel' | 'old-word' | 'scan'
const KINDS: Record<string, FileKind> = { pdf: 'ai', docx: 'ai', doc: 'old-word', xls: 'excel', xlsx: 'excel', png: 'image', jpg: 'image', jpeg: 'image', webp: 'image' }
const MANUAL_REASON: Record<Exclude<FileKind, 'ai'>, string> = {
  image: 'This is an image, so the AI can’t read it. Type the title and description yourself.',
  excel: 'This is an Excel spreadsheet, so the AI can’t read it. Type the title and description yourself.',
  'old-word': 'Older Word files (.doc) can’t be read by the AI. Type the details yourself, or save it as .docx to use auto-fill.',
  scan: 'Photos of paper can’t be read by the AI. Type the title and description yourself.',
}
const manualReason = ref('')

/**
 * Single: one file. Bulk: many files or pictures under ONE document and ONE QR code. The page
 * count is the number of files — except when they are all pictures, where the uploader says how
 * many pages the paper has (photos don't always match sheets).
 */
const mode = ref<'single' | 'bulk'>('single')
// Where the attachments come from: files, or pictures of the paper taken with the camera.
const source = ref<'file' | 'camera'>('file')
const cameraOpen = ref(false)

interface Attachment {
  key: number
  file: File
  kind: FileKind
  /** Thumbnail for pictures. */
  preview: string | null
  /** Pages photographed into this file (camera), else 0. */
  scannedPages: number
}
const attachments = ref<Attachment[]>([])
let nextKey = 1
const pagesManual = ref<number | null>(null)

/** Every attachment is a picture (image file or camera photo), so the page count is typed in. */
const picturesOnly = computed(() => attachments.value.length > 0 && attachments.value.every((a) => a.kind === 'image' || a.kind === 'scan'))
/**
 * The page count is typed in for pictures: always in bulk + camera mode (even before the first
 * picture — the paper's page count is known up front), and whenever every attachment is a picture.
 */
const askCount = computed(() => (mode.value === 'bulk' && source.value === 'camera') || picturesOnly.value)
const pageCount = computed(() => (askCount.value ? pagesManual.value : attachments.value.length))
const totalBytes = computed(() => attachments.value.reduce((n, a) => n + a.file.size, 0))

function toAttachment(f: File, scanned = 0): Attachment | null {
  const kind: FileKind | undefined = scanned ? 'scan' : KINDS[f.name.split('.').pop()?.toLowerCase() ?? '']
  // Dropped files skip the picker's filter, so check the type here too.
  if (!kind) {
    ui.error('Unsupported file', `${f.name}: attach PDF, Word, Excel or image files (PNG, JPG, WebP).`)
    return null
  }
  if (f.size > MAX_MB * 1024 * 1024) {
    ui.error('File too large', `${f.name}: each file can be up to ${MAX_MB} MB.`)
    return null
  }
  const isPicture = kind === 'image' || (kind === 'scan' && f.type.startsWith('image/'))
  return { key: nextKey++, file: f, kind, preview: isPicture ? URL.createObjectURL(f) : null, scannedPages: scanned }
}

/** Add files: single mode replaces the attachment, bulk mode adds to the set. */
function addFiles(list: Iterable<File> | null | undefined, { scannedPages = 0 } = {}) {
  const incoming = [...(list ?? [])]
  if (!incoming.length) return
  if (mode.value === 'single') {
    const a = toAttachment(incoming[0]!, scannedPages)
    if (!a) return
    clearAttachments()
    attachments.value = [a]
  } else {
    for (const f of incoming) {
      if (attachments.value.length >= MAX_FILES) {
        ui.error('Too many files', `One document can hold up to ${MAX_FILES} files.`)
        break
      }
      const a = toAttachment(f, f.type.startsWith('image/') && scannedPages ? 1 : 0)
      if (a) attachments.value.push(a)
    }
  }
  attachmentsChanged()
}

function onScanned(files: File[], pages: number) {
  addFiles(files, { scannedPages: mode.value === 'single' ? pages : 1 })
}

function removeAttachment(key: number) {
  const a = attachments.value.find((x) => x.key === key)
  if (a?.preview) URL.revokeObjectURL(a.preview)
  attachments.value = attachments.value.filter((x) => x.key !== key)
  attachmentsChanged()
}
function clearAttachments() {
  attachments.value.forEach((a) => a.preview && URL.revokeObjectURL(a.preview))
  attachments.value = []
}
function clearAll() {
  clearAttachments()
  attachmentsChanged()
}
onBeforeUnmount(clearAttachments)

// Switching between single and bulk starts the attachments over.
watch(mode, () => clearAll())

/**
 * After the set changes: the AI reads the first PDF or Word file (if it hasn't already); with
 * none, the details are typed in. Pictures-only sets get their page count suggested.
 */
let analyzedKey: number | null = null
function attachmentsChanged() {
  const list = attachments.value
  if (picturesOnly.value) {
    const suggested = list.reduce((n, a) => n + (a.scannedPages || 1), 0)
    if (!pagesManual.value || pagesManual.value < 1) pagesManual.value = suggested
    else if (mode.value === 'single') pagesManual.value = suggested
  } else if (!askCount.value) {
    pagesManual.value = null
  }
  if (!list.length) {
    analyzedKey = null
    analyzeRun++
    analyzing.value = false
    aiFilled.value = false
    aiNote.value = ''
    manualReason.value = ''
    return
  }
  const readable = list.find((a) => a.kind === 'ai')
  if (readable) {
    manualReason.value = ''
    if (readable.key !== analyzedKey) {
      analyzedKey = readable.key
      analyze(readable.file)
    }
    return
  }
  // Nothing the AI can read: skip it and go straight to typing the details.
  analyzedKey = null
  analyzeRun++
  analyzing.value = false
  aiFilled.value = false
  aiNote.value = ''
  manualReason.value = list.length === 1 ? MANUAL_REASON[list[0]!.kind as Exclude<FileKind, 'ai'>] : picturesOnly.value
    ? 'These are pictures, so the AI can’t read them. Type the title and description yourself, and check the number of pages.'
    : 'None of these files can be read by the AI (only PDF and Word .docx can). Type the title and description yourself.'
  if (step.value === 0 && mode.value === 'single') step.value = 1
}

// For the Details banner: the first picture, if any.
const preview = computed(() => attachments.value.find((a) => a.preview)?.preview ?? null)

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
  addFiles(e.dataTransfer?.files)
}

// A step can be reached once every step before it is complete.
// Pictures only: the number of pages must be given.
const pagesOk = computed(() => !askCount.value || (Number.isInteger(pagesManual.value) && (pagesManual.value ?? 0) >= 1 && (pagesManual.value ?? 0) <= 9999))
const stepDone = computed(() => [!analyzing.value && pagesOk.value, form.title.trim().length > 0, Boolean(selectedRoute.value), true])
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
    // One or many files — all under one document and one QR code.
    for (const a of attachments.value) fd.append('file', a.file)
    if ((attachments.value.length || askCount.value) && pageCount.value) fd.append('pages', String(pageCount.value))
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
        <!-- One file, or a bulk set under one QR -->
        <div class="mb-3 flex w-fit max-w-full gap-1 rounded-xl bg-ink/[0.04] p-1" role="radiogroup" aria-label="Single file or bulk">
          <button
            v-for="m in [
              { value: 'single', icon: 'file', label: 'Single file' },
              { value: 'bulk', icon: 'layers', label: 'Bulk — many files, one QR' },
            ] as const"
            :key="m.value"
            type="button"
            role="radio"
            :aria-checked="mode === m.value"
            class="tab"
            :class="mode === m.value && 'tab-active'"
            @click="mode = m.value"
          >
            <FIcon :name="m.icon" :size="15" /> {{ m.label }}
          </button>
        </div>
        <p class="mb-4 text-xs text-ink-2">
          {{ mode === 'single' ? 'One file for this document.' : `Several files or pictures that travel together as one document, with one QR code (up to ${MAX_FILES}).` }}
        </p>

        <!-- How to attach the document -->
        <div class="mb-4 grid grid-cols-1 gap-3 sm:grid-cols-2" role="radiogroup" aria-label="How to add the document">
          <button
            v-for="opt in [
              { value: 'file', icon: 'upload-cloud', title: 'Upload a file', hint: 'PDF, Word, Excel or image from this device' },
              { value: 'camera', icon: 'camera', title: 'Take a picture', hint: 'Photograph the paper, page by page' },
            ] as const"
            :key="opt.value"
            type="button"
            role="radio"
            :aria-checked="source === opt.value"
            class="flex items-center gap-3 rounded-2xl border p-4 text-left transition-colors"
            :class="source === opt.value ? 'border-terracotta bg-terracotta/[0.06]' : 'border-line hover:bg-card'"
            @click="source = opt.value"
          >
            <span class="grid size-10 shrink-0 place-items-center rounded-xl" :class="source === opt.value ? 'bg-terracotta text-white' : 'bg-ink/[0.05] text-ink-2'">
              <FIcon :name="opt.icon" :size="18" />
            </span>
            <span class="min-w-0">
              <span class="block text-sm font-semibold">{{ opt.title }}</span>
              <span class="block text-xs text-ink-2">{{ opt.hint }}</span>
            </span>
          </button>
        </div>

        <!-- Camera -->
        <div v-if="source === 'camera'" class="flex flex-col items-center justify-center rounded-2xl border-2 border-dashed border-line px-6 py-12 text-center">
          <span class="grid size-12 place-items-center rounded-2xl bg-terracotta/12 text-terracotta-ink"><FIcon name="camera" /></span>
          <span class="mt-4 text-sm font-semibold">Photograph the paper document</span>
          <span class="mt-1 max-w-sm text-xs text-ink-2">
            {{ mode === 'bulk' ? 'Take one picture per page. Each picture is added to this document as its own file.' : 'Take one picture per page. One page is saved as an image; several are joined into a single PDF.' }}
          </span>
          <button type="button" class="btn btn-primary mt-5" @click="cameraOpen = true">
            <FIcon name="camera" :size="16" /> {{ mode === 'bulk' && attachments.length ? 'Take more pictures' : attachments.some((a) => a.scannedPages) ? 'Take the pictures again' : 'Open camera' }}
          </button>
        </div>

        <label
          v-else
          class="flex cursor-pointer flex-col items-center justify-center rounded-2xl border-2 border-dashed px-6 py-12 text-center transition-colors"
          :class="dragging ? 'border-terracotta bg-terracotta/[0.05]' : 'border-line hover:border-ink-3'"
          @dragover.prevent="dragging = true"
          @dragleave.prevent="dragging = false"
          @drop.prevent="onDrop"
        >
          <input type="file" class="sr-only" :accept="ACCEPT" :multiple="mode === 'bulk'" @change="addFiles(($event.target as HTMLInputElement).files); ($event.target as HTMLInputElement).value = ''" />
          <span class="grid size-12 place-items-center rounded-2xl bg-terracotta/12 text-terracotta-ink"><FIcon name="upload-cloud" /></span>
          <span class="mt-4 text-sm font-semibold">{{ mode === 'bulk' ? 'Drop files or click to browse (pick several)' : 'Drop a file or click to browse' }}</span>
          <span class="mt-1 text-xs text-ink-2">PDF, Word, Excel or image (PNG, JPG, WebP) · up to {{ MAX_MB }} MB each</span>
          <span class="mt-0.5 text-xs text-ink-2">AI fills in the details from PDF and Word (.docx) files; for images and Excel you type them in.</span>
        </label>

        <!-- What's attached -->
        <div v-if="attachments.length" class="mt-4 rounded-xl bg-ink/[0.04] p-2">
          <div v-if="mode === 'bulk'" class="flex items-center justify-between px-2 pt-1 pb-2 text-xs text-ink-2">
            <span>{{ attachments.length }} file{{ attachments.length === 1 ? '' : 's' }} · {{ formatBytes(totalBytes) }} · one QR code</span>
            <button type="button" class="hover:text-ink" @click="clearAll">Remove all</button>
          </div>
          <ul class="max-h-72 space-y-1 overflow-y-auto">
            <li v-for="(a, i) in attachments" :key="a.key" class="flex items-center gap-3 rounded-lg bg-card/70 p-2">
              <span v-if="mode === 'bulk'" class="w-5 shrink-0 text-center text-xs text-ink-2">{{ i + 1 }}</span>
              <img v-if="a.preview" :src="a.preview" alt="" class="size-10 shrink-0 rounded-md object-cover" />
              <span v-else class="grid size-10 shrink-0 place-items-center rounded-md bg-ink/[0.05] text-ink-2"><FIcon name="file" :size="16" /></span>
              <span class="min-w-0 flex-1">
                <span class="block truncate text-sm font-medium">{{ a.file.name }}</span>
                <span class="text-xs text-ink-2">
                  {{ a.scannedPages ? `Taken with the camera${a.scannedPages > 1 ? ` · ${a.scannedPages} pages` : ''} · ` : '' }}{{ formatBytes(a.file.size) }}
                  <template v-if="a.kind === 'ai'"> · AI can read it</template>
                </span>
              </span>
              <button type="button" class="grid size-9 shrink-0 place-items-center rounded-lg text-ink-2 hover:bg-ink/5" :aria-label="`Remove ${a.file.name}`" @click="removeAttachment(a.key)"><FIcon name="x" :size="16" /></button>
            </li>
          </ul>
          <p v-if="analyzing" class="flex items-center gap-2 px-2 pt-2 pb-1 text-xs text-terracotta-ink"><FIcon name="loader" :size="14" class="animate-spin" /> AI is reading the first PDF/Word file…</p>
        </div>

        <!-- How many pages -->
        <div v-if="attachments.length || askCount" class="mt-4 flex flex-wrap items-center gap-3 rounded-xl border border-line p-3">
          <FIcon name="hash" :size="18" class="text-ink-2" />
          <template v-if="askCount">
            <label for="pages" class="text-sm font-medium">How many pages (files) does this document have?</label>
            <input id="pages" v-model.number="pagesManual" type="number" min="1" max="9999" step="1" class="input w-24" required />
            <span class="w-full text-xs text-ink-2 sm:w-auto">{{ attachments.length ? `${attachments.length} picture${attachments.length === 1 ? '' : 's'} taken — pictures don’t always match sheets, so check the number.` : 'Enter it first, then take one picture per page.' }}</span>
          </template>
          <template v-else>
            <span class="text-sm"><strong>{{ attachments.length }}</strong> page{{ attachments.length === 1 ? '' : 's' }}</span>
            <span class="text-xs text-ink-2">counted automatically from the files</span>
          </template>
        </div>

        <p v-if="manualReason" class="mt-3 flex items-start gap-2 text-sm text-info-ink"><FIcon name="edit-3" :size="16" class="mt-0.5 shrink-0" /> {{ manualReason }}</p>
        <p v-else-if="aiNote" class="mt-3 flex items-start gap-2 text-sm text-amber-ink"><FIcon name="info" :size="16" class="mt-0.5 shrink-0" /> {{ aiNote }} You can type the details yourself in the next step.</p>
        <p v-else-if="!attachments.length" class="mt-3 text-xs text-ink-2">No file? Continue and type the details yourself.</p>
      </div>

      <!-- 2. Details -->
      <div v-else-if="step === 1" class="space-y-4">
        <div v-if="analyzing" class="flex items-center gap-3 rounded-2xl bg-terracotta/[0.07] p-4 text-sm text-terracotta-ink">
          <FIcon name="loader" :size="18" class="animate-spin" /> Reading your document…
        </div>
        <div v-else-if="aiFilled" class="flex items-center gap-3 rounded-2xl bg-terracotta/[0.07] p-4 text-sm text-terracotta-ink">
          <FIcon name="zap" :size="18" /> <span class="flex-1">Filled in by AI from <strong>{{ attachments.find((a) => a.kind === 'ai')?.file.name }}</strong>. Check it and edit anything that's off.</span>
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
            <dd class="mt-1 truncate text-sm">{{ attachments.length === 0 ? 'None' : attachments.length === 1 ? attachments[0]!.file.name : `${attachments.length} files · one QR code` }}</dd>
          </div>
          <div v-if="attachments.length || askCount">
            <dt class="eyebrow">Pages</dt>
            <dd class="mt-1 text-sm">{{ pageCount ?? '—' }} <span class="text-ink-2">· {{ askCount ? 'entered by you' : 'counted from the files' }}</span></dd>
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

    <PhotoCapture :open="cameraOpen" :max-bytes="MAX_MB * 1024 * 1024" :separate="mode === 'bulk'" @close="cameraOpen = false" @done="onScanned" />
  </div>
</template>
