<script setup lang="ts">
import type { DocumentTypeItem, KnowledgeFileItem } from '~/types'

useHead({ title: 'Organization Settings · FlowVision' })

interface SettingsData {
  organization: { id: string; name: string; description: string | null; website: string | null }
  document_types: DocumentTypeItem[]
  knowledge_files: KnowledgeFileItem[]
  limits: { knowledge_max_bytes: number }
  ai_configured: boolean
}

const api = useApi()
const ui = useUiStore()
const auth = useAuthStore()
const { busy, run } = useAction()

const { data, refresh } = await useAsyncData('org-settings', () => api.get<SettingsData>('/org/settings'))

type Tab = 'profile' | 'types' | 'knowledge'
const route = useRoute()
const router = useRouter()
const TABS: Array<{ key: Tab; label: string; icon: string }> = [
  { key: 'profile', label: 'Organization', icon: 'home' },
  { key: 'types', label: 'Document types', icon: 'tag' },
  { key: 'knowledge', label: 'AI knowledge', icon: 'book-open' },
]
const tab = ref<Tab>((TABS.find((t) => t.key === route.query.tab)?.key ?? 'profile') as Tab)
watch(tab, (t) => router.replace({ query: { tab: t } }))

// ---------------------------------------------------------------------------
// Organization profile
// ---------------------------------------------------------------------------
const profile = reactive({ name: '', description: '', website: '' })
watch(
  () => data.value?.organization,
  (o) => o && Object.assign(profile, { name: o.name, description: o.description ?? '', website: o.website ?? '' }),
  { immediate: true },
)
async function saveProfile() {
  const ok = await run('profile', () => api.patch('/org', { ...profile }), 'Organization saved')
  if (ok) {
    await refresh()
    // The sidebar shows the organization name.
    auth.fetchMe().catch(() => {})
  }
}

// ---------------------------------------------------------------------------
// Document types
// ---------------------------------------------------------------------------
const types = computed(() => data.value?.document_types ?? [])
const newType = reactive({ name: '', description: '', processing_days: 1, processing_hours: 0 })
async function addType() {
  if (!newType.name.trim()) return
  const ok = await run('add-type', () => api.post('/org/document-types', { ...newType }), `“${newType.name.trim()}” added`)
  if (ok) {
    Object.assign(newType, { name: '', description: '', processing_days: 1, processing_hours: 0 })
    refresh()
  }
}

const editing = ref<string | null>(null)
const editForm = reactive({ name: '', description: '', processing_days: 0, processing_hours: 0 })
function startEdit(t: DocumentTypeItem) {
  editing.value = t.id
  Object.assign(editForm, { name: t.name, description: t.description ?? '', processing_days: t.processing_days, processing_hours: t.processing_hours })
}
async function saveEdit(t: DocumentTypeItem) {
  const ok = await run(`edit-${t.id}`, () => api.patch(`/org/document-types/${t.id}`, { ...editForm }), 'Document type saved')
  if (ok) {
    editing.value = null
    refresh()
  }
}
async function toggleType(t: DocumentTypeItem) {
  const ok = await run(`toggle-${t.id}`, () => api.patch(`/org/document-types/${t.id}`, { is_active: !t.is_active }), t.is_active ? `“${t.name}” hidden from uploads` : `“${t.name}” offered again`)
  if (ok) refresh()
}
async function moveType(t: DocumentTypeItem, dir: -1 | 1) {
  const list = types.value
  const i = list.findIndex((x) => x.id === t.id)
  const other = list[i + dir]
  if (!other) return
  // Swap positions (renumbering keeps the order stable even if two share a number).
  await Promise.all([
    api.patch(`/org/document-types/${t.id}`, { sort_order: i + dir }),
    api.patch(`/org/document-types/${other.id}`, { sort_order: i }),
  ]).catch((err) => ui.error('Could not reorder', apiErrorMessage(err)))
  refresh()
}
async function removeType(t: DocumentTypeItem) {
  const note = t.usage ? ` The ${t.usage} document${t.usage === 1 ? '' : 's'} filed under it keep the name.` : ''
  await ui.confirm({
    title: `Delete “${t.name}”?`,
    body: `It will no longer be offered when uploading.${note}`,
    confirmLabel: 'Delete type',
    busyLabel: 'Deleting…',
    action: async () => {
      const ok = await run(`del-${t.id}`, () => api.del(`/org/document-types/${t.id}`), `“${t.name}” deleted`)
      if (ok) await refresh()
    },
  })
}

// ---------------------------------------------------------------------------
// AI knowledge files
// ---------------------------------------------------------------------------
const files = computed(() => data.value?.knowledge_files ?? [])
const maxBytes = computed(() => data.value?.limits.knowledge_max_bytes ?? 200 * 1024 * 1024)
const ACCEPT = '.pdf,.docx,.txt,.md,.csv'
const upload = reactive({ title: '', description: '' })
const picked = ref<File | null>(null)
const dragging = ref(false)
const progress = ref<number | null>(null)

function pick(f?: File | null) {
  if (!f) return
  if (f.size > maxBytes.value) {
    ui.error('File too large', `Knowledge files can be up to ${formatBytes(maxBytes.value)}.`)
    return
  }
  picked.value = f
  if (!upload.title) upload.title = f.name.replace(/\.[^.]+$/, '')
}

/** XHR rather than fetch, so large files show upload progress. */
function sendKnowledge() {
  if (!picked.value || progress.value !== null) return
  const fd = new FormData()
  fd.append('file', picked.value)
  if (upload.title.trim()) fd.append('title', upload.title.trim())
  if (upload.description.trim()) fd.append('description', upload.description.trim())

  const xhr = new XMLHttpRequest()
  xhr.open('POST', '/api/org/knowledge')
  xhr.withCredentials = true
  progress.value = 0
  xhr.upload.onprogress = (e) => {
    if (e.lengthComputable) progress.value = Math.round((e.loaded / e.total) * 100)
  }
  xhr.onload = () => {
    progress.value = null
    let body: any = null
    try {
      body = JSON.parse(xhr.responseText)
    } catch {
      /* not JSON */
    }
    if (xhr.status >= 200 && xhr.status < 300) {
      const f = body?.knowledge_file as KnowledgeFileItem | undefined
      if (f?.status === 'READY') ui.success('Knowledge added', `${f.title} · ${f.char_count.toLocaleString()} characters the AI can use`)
      else ui.error('Uploaded, but no text was found', f?.error ?? 'The AI can’t use this file.')
      picked.value = null
      Object.assign(upload, { title: '', description: '' })
      refresh()
    } else {
      ui.error('Upload failed', body?.message ?? `The server answered ${xhr.status}.`)
    }
  }
  xhr.onerror = () => {
    progress.value = null
    ui.error('Upload failed', 'The connection was interrupted. Try again.')
  }
  xhr.send(fd)
}

async function toggleFile(f: KnowledgeFileItem) {
  const ok = await run(`kf-${f.id}`, () => api.patch(`/org/knowledge/${f.id}`, { is_active: !f.is_active }), f.is_active ? 'The AI no longer uses this file' : 'The AI uses this file again')
  if (ok) refresh()
}
async function removeFile(f: KnowledgeFileItem) {
  await ui.confirm({
    title: `Delete “${f.title}”?`,
    body: 'The AI stops using it and the file is removed.',
    confirmLabel: 'Delete file',
    busyLabel: 'Deleting…',
    action: async () => {
      const ok = await run(`kfdel-${f.id}`, () => api.del(`/org/knowledge/${f.id}`), 'Knowledge file deleted')
      if (ok) await refresh()
    },
  })
}

const usableChars = computed(() => files.value.filter((f) => f.is_active && f.status === 'READY').reduce((n, f) => n + f.char_count, 0))
const STATUS = {
  READY: { tone: 'success', label: 'Ready' },
  NO_TEXT: { tone: 'warning', label: 'No text found' },
  FAILED: { tone: 'danger', label: 'Could not read' },
} as const
</script>

<template>
  <div class="fv-rise">
    <PageHeader eyebrow="Administration" title="Organization Settings" description="Your organization’s profile, the document types offered when uploading, and the knowledge the AI uses to read documents." />

    <div class="mb-6 flex w-fit max-w-full gap-1 overflow-x-auto rounded-xl bg-ink/[0.04] p-1" role="tablist">
      <button v-for="t in TABS" :key="t.key" role="tab" class="tab shrink-0" :class="tab === t.key && 'tab-active'" :aria-selected="tab === t.key" @click="tab = t.key">
        <FIcon :name="t.icon" :size="15" /> {{ t.label }}
        <span v-if="t.key === 'types'" class="text-xs text-ink-2">{{ types.length }}</span>
        <span v-else-if="t.key === 'knowledge'" class="text-xs text-ink-2">{{ files.length }}</span>
      </button>
    </div>

    <!-- Organization profile -->
    <section v-if="tab === 'profile'" class="card card-pad max-w-2xl">
      <h2 class="text-lg">Organization</h2>
      <p class="mt-1 text-sm text-ink-body">Shown across FlowVision. The AI also uses the name when it reads documents.</p>
      <form class="mt-5 space-y-4" @submit.prevent="saveProfile">
        <div>
          <label class="field-label" for="org-name">Name</label>
          <input id="org-name" v-model="profile.name" class="input" maxlength="255" required />
        </div>
        <div>
          <label class="field-label" for="org-desc">Description</label>
          <textarea id="org-desc" v-model="profile.description" class="input" rows="3" maxlength="2000" placeholder="e.g. City Hall, Bago City, Negros Occidental" />
        </div>
        <div>
          <label class="field-label" for="org-web">Website</label>
          <input id="org-web" v-model="profile.website" class="input" type="url" maxlength="500" placeholder="https://" />
        </div>
        <div class="flex justify-end">
          <button class="btn btn-primary" :disabled="busy === 'profile' || !profile.name.trim()" :aria-busy="busy === 'profile'">{{ busy === 'profile' ? 'Saving…' : 'Save' }}</button>
        </div>
      </form>
    </section>

    <!-- Document types -->
    <div v-else-if="tab === 'types'" class="grid grid-cols-1 gap-6 lg:grid-cols-[minmax(0,1fr)_340px]">
      <section class="card overflow-hidden">
        <div class="card-pad pb-3">
          <h2 class="text-lg">Document types</h2>
          <p class="mt-1 text-sm text-ink-body">Offered when anyone uploads a document. Each type's processing time sets the deadline of documents submitted with it. The AI picks a type when it reads a file, using the description to decide.</p>
        </div>
        <div v-if="!types.length" class="px-6 pb-6">
          <EmptyState icon="tag" title="No document types yet" description="Add the kinds of documents your organization handles." />
        </div>
        <ul v-else class="divide-y divide-line/60 border-t border-line/60">
          <li v-for="(t, i) in types" :key="t.id" class="flex gap-3 p-4" :class="!t.is_active && 'opacity-60'">
            <div class="flex shrink-0 flex-col">
              <button class="grid size-6 place-items-center rounded text-ink-2 hover:bg-ink/5 disabled:opacity-30" :disabled="i === 0" aria-label="Move up" @click="moveType(t, -1)"><FIcon name="chevron-up" :size="14" /></button>
              <button class="grid size-6 place-items-center rounded text-ink-2 hover:bg-ink/5 disabled:opacity-30" :disabled="i === types.length - 1" aria-label="Move down" @click="moveType(t, 1)"><FIcon name="chevron-down" :size="14" /></button>
            </div>

            <form v-if="editing === t.id" class="min-w-0 flex-1 space-y-2" @submit.prevent="saveEdit(t)">
              <input v-model="editForm.name" class="input" maxlength="100" required aria-label="Name" />
              <textarea v-model="editForm.description" class="input" rows="2" maxlength="500" placeholder="What documents belong here (helps the AI choose)" aria-label="Description" />
              <ProcessingTimeInput :id="`edit-time-${t.id}`" v-model:days="editForm.processing_days" v-model:hours="editForm.processing_hours" />
              <p v-if="editForm.processing_days !== t.processing_days || editForm.processing_hours !== t.processing_hours" class="text-xs text-ink-2">
                Applies to documents submitted from now on. Documents already in progress keep their deadline.
              </p>
              <p v-if="t.usage && editForm.name.trim() !== t.name" class="text-xs text-amber-ink">Renaming also renames it on the {{ t.usage }} document{{ t.usage === 1 ? '' : 's' }} filed under it.</p>
              <div class="flex gap-2">
                <button class="btn btn-sm btn-primary" :disabled="busy === `edit-${t.id}` || !editForm.name.trim()" :aria-busy="busy === `edit-${t.id}`">Save</button>
                <button type="button" class="btn btn-sm btn-ghost" @click="editing = null">Cancel</button>
              </div>
            </form>

            <template v-else>
              <div class="min-w-0 flex-1">
                <p class="flex flex-wrap items-center gap-2 text-sm font-semibold">
                  {{ t.name }}
                  <ToneBadge v-if="!t.is_active" tone="neutral">Hidden</ToneBadge>
                </p>
                <p v-if="t.description" class="mt-0.5 text-[13px] text-ink-body">{{ t.description }}</p>
                <p class="mt-1 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-ink-2">
                  <span class="inline-flex items-center gap-1" :class="t.total_hours ? 'text-ink-body' : ''">
                    <FIcon name="clock" :size="12" /> {{ t.total_hours ? `Process within ${formatSla(t.total_hours)}` : 'No time limit' }}
                  </span>
                  <span>{{ t.usage ?? 0 }} document{{ t.usage === 1 ? '' : 's' }}</span>
                </p>
              </div>
              <div class="flex shrink-0 items-start gap-1">
                <button class="btn btn-sm btn-ghost" :title="t.is_active ? 'Hide from uploads' : 'Offer again'" :disabled="busy === `toggle-${t.id}`" :aria-busy="busy === `toggle-${t.id}`" @click="toggleType(t)">
                  <FIcon :name="t.is_active ? 'eye-off' : 'eye'" :size="14" />
                </button>
                <button class="btn btn-sm btn-ghost" title="Edit" @click="startEdit(t)"><FIcon name="edit-2" :size="14" /></button>
                <button class="btn btn-sm btn-ghost text-danger-ink" title="Delete" :disabled="busy === `del-${t.id}`" :aria-busy="busy === `del-${t.id}`" @click="removeType(t)"><FIcon name="trash-2" :size="14" /></button>
              </div>
            </template>
          </li>
        </ul>
      </section>

      <aside class="card card-pad h-fit lg:sticky lg:top-8">
        <h2 class="text-lg">Add a document type</h2>
        <form class="mt-4 space-y-3" @submit.prevent="addType">
          <div>
            <label class="field-label" for="type-name">Name</label>
            <input id="type-name" v-model="newType.name" class="input" maxlength="100" placeholder="e.g. Business Permit Application" />
          </div>
          <div>
            <label class="field-label" for="type-desc">Description <span class="font-normal text-ink-2">(optional)</span></label>
            <textarea id="type-desc" v-model="newType.description" class="input" rows="3" maxlength="500" placeholder="What documents belong here — helps the AI choose" />
          </div>
          <ProcessingTimeInput id="new-type-time" v-model:days="newType.processing_days" v-model:hours="newType.processing_hours" />
          <button class="btn btn-primary w-full justify-center" :disabled="busy === 'add-type' || !newType.name.trim()" :aria-busy="busy === 'add-type'"><FIcon name="plus" :size="16" /> Add type</button>
        </form>
      </aside>
    </div>

    <!-- AI knowledge -->
    <div v-else class="space-y-6">
      <div v-if="data && !data.ai_configured" class="flex items-start gap-3 rounded-2xl border border-amber/40 bg-amber/12 p-4 text-sm text-amber-ink">
        <FIcon name="alert-triangle" :size="18" class="mt-0.5 shrink-0" />
        <span>The AI isn’t switched on for this server (GROQ_API_KEY is missing). Files are stored and read, and will be used once it is.</span>
      </div>

      <section class="card card-pad">
        <h2 class="text-lg">Add knowledge</h2>
        <p class="mt-1 text-sm text-ink-body">
          Manuals, ordinances, office directories, procedure guides — anything that explains how your organization works. When someone uploads a document, the AI reads the
          passages that match it before filling in the title, description and type.
        </p>
        <div class="mt-5 grid grid-cols-1 gap-4 lg:grid-cols-2">
          <label
            class="flex cursor-pointer flex-col items-center justify-center rounded-2xl border-2 border-dashed px-6 py-10 text-center transition-colors"
            :class="dragging ? 'border-terracotta bg-terracotta/[0.05]' : 'border-line hover:border-ink-3'"
            @dragover.prevent="dragging = true"
            @dragleave.prevent="dragging = false"
            @drop.prevent="dragging = false; pick($event.dataTransfer?.files?.[0])"
          >
            <input type="file" class="sr-only" :accept="ACCEPT" @change="pick(($event.target as HTMLInputElement).files?.[0])" />
            <span class="grid size-12 place-items-center rounded-2xl bg-terracotta/12 text-terracotta-ink"><FIcon name="upload-cloud" /></span>
            <span class="mt-4 text-sm font-semibold">{{ picked ? picked.name : 'Drop a file or click to browse' }}</span>
            <span class="mt-1 text-xs text-ink-2">{{ picked ? formatBytes(picked.size) : `PDF, Word (.docx), text, Markdown or CSV · up to ${formatBytes(maxBytes)}` }}</span>
          </label>
          <form class="space-y-3" @submit.prevent="sendKnowledge">
            <div>
              <label class="field-label" for="kf-title">Title</label>
              <input id="kf-title" v-model="upload.title" class="input" maxlength="255" placeholder="e.g. Citizen’s Charter 2026" />
            </div>
            <div>
              <label class="field-label" for="kf-desc">Description <span class="font-normal text-ink-2">(optional)</span></label>
              <textarea id="kf-desc" v-model="upload.description" class="input" rows="3" maxlength="2000" placeholder="What this file covers" />
            </div>
            <div v-if="progress !== null" class="space-y-1">
              <div class="h-2 overflow-hidden rounded-full bg-ink/[0.06]"><div class="h-full rounded-full bg-terracotta transition-all" :style="{ width: `${progress}%` }" /></div>
              <p class="text-xs text-ink-2">{{ progress < 100 ? `Uploading… ${progress}%` : 'Reading the text…' }}</p>
            </div>
            <button class="btn btn-primary w-full justify-center" :disabled="!picked || progress !== null"><FIcon name="upload" :size="16" /> Upload</button>
          </form>
        </div>
      </section>

      <section class="card overflow-hidden">
        <div class="card-pad flex flex-wrap items-end justify-between gap-2 pb-3">
          <div>
            <h2 class="text-lg">Knowledge files</h2>
            <p class="mt-1 text-sm text-ink-body">{{ usableChars.toLocaleString() }} characters in use by the AI.</p>
          </div>
        </div>
        <div v-if="!files.length" class="px-6 pb-6">
          <EmptyState icon="book-open" title="No knowledge yet" description="Upload your first file above." />
        </div>
        <ul v-else class="divide-y divide-line/60 border-t border-line/60">
          <li v-for="f in files" :key="f.id" class="flex flex-col gap-3 p-4 sm:flex-row sm:items-start" :class="!f.is_active && 'opacity-60'">
            <span class="grid size-10 shrink-0 place-items-center rounded-xl bg-ink/[0.05] text-ink-2"><FIcon name="file-text" :size="18" /></span>
            <div class="min-w-0 flex-1">
              <p class="flex flex-wrap items-center gap-2 text-sm font-semibold">
                {{ f.title }}
                <ToneBadge :tone="STATUS[f.status].tone" dot>{{ STATUS[f.status].label }}</ToneBadge>
                <ToneBadge v-if="f.status === 'READY' && !f.is_active" tone="neutral">Not used</ToneBadge>
              </p>
              <p v-if="f.description" class="mt-0.5 text-[13px] text-ink-body">{{ f.description }}</p>
              <p class="mt-1 text-xs text-ink-2">
                {{ f.file_name }} · {{ formatBytes(f.file_size) }}<template v-if="f.status === 'READY'"> · {{ f.char_count.toLocaleString() }} characters</template>
                · {{ formatDate(f.created_at) }}<template v-if="f.uploader"> · {{ fullName(f.uploader) }}</template>
              </p>
              <p v-if="f.error" class="mt-1 text-xs text-danger-ink">{{ f.error }}</p>
            </div>
            <div class="flex shrink-0 gap-1">
              <button v-if="f.status === 'READY'" class="btn btn-sm btn-ghost" :disabled="busy === `kf-${f.id}`" :aria-busy="busy === `kf-${f.id}`" @click="toggleFile(f)">
                <FIcon :name="f.is_active ? 'pause' : 'play'" :size="14" /> {{ f.is_active ? 'Stop using' : 'Use' }}
              </button>
              <a :href="`/api/org/knowledge/${f.id}/file`" class="btn btn-sm btn-ghost" title="Download"><FIcon name="download" :size="14" /></a>
              <button class="btn btn-sm btn-ghost text-danger-ink" title="Delete" :disabled="busy === `kfdel-${f.id}`" :aria-busy="busy === `kfdel-${f.id}`" @click="removeFile(f)"><FIcon name="trash-2" :size="14" /></button>
            </div>
          </li>
        </ul>
      </section>
    </div>
  </div>
</template>
