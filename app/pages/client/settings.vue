<script setup lang="ts">
import type { DocumentTemplateItem, DocumentTypeItem, HolidayItem, KnowledgeFileItem, WorkCalendarSettings } from '~/types'
import { describeCalendar, parseClock } from '#shared/work-calendar'

useHead({ title: 'Organization Settings · FlowVision' })

interface SettingsData {
  organization: { id: string; name: string; description: string | null; website: string | null; logo_url: string | null }
  work_calendar: WorkCalendarSettings
  holidays: HolidayItem[]
  document_types: DocumentTypeItem[]
  templates: DocumentTemplateItem[]
  knowledge_files: KnowledgeFileItem[]
  limits: { knowledge_max_bytes: number }
  ai_configured: boolean
}

const api = useApi()
const ui = useUiStore()
const auth = useAuthStore()
const { busy, run } = useAction()

const { data, refresh } = await useAsyncData('org-settings', () => api.get<SettingsData>('/org/settings'))

type Tab = 'profile' | 'hours' | 'types' | 'templates' | 'knowledge'
const route = useRoute()
const router = useRouter()
const TABS: Array<{ key: Tab; label: string; icon: string }> = [
  { key: 'profile', label: 'Organization', icon: 'home' },
  { key: 'hours', label: 'Working hours', icon: 'clock' },
  { key: 'types', label: 'Document types', icon: 'tag' },
  { key: 'templates', label: 'Templates', icon: 'layout' },
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
// How processing time is counted: in working days and hours, once working hours are set.
const calendarText = computed(() => {
  const c = data.value?.work_calendar
  if (!c?.configured) return null
  return describeCalendar({ start: parseClock(c.work_start) ?? 480, end: parseClock(c.work_end) ?? 1020, days: c.work_days, holidays: [], recurring: [] })
})
// Who a type is offered to: Global (every office, e.g. Payroll) or one office / umbrella office.
const scopeOptions = computed(() => {
  const all = offices.value as Array<{ id: string; name: string; code: string; parent_office_id?: string | null }>
  const out: Array<{ id: string; label: string }> = [{ id: '', label: 'Global — every office' }]
  for (const o of all.filter((x) => !x.parent_office_id)) {
    out.push({ id: o.id, label: `${o.name} (${o.code})` })
    for (const u of all.filter((x) => x.parent_office_id === o.id)) out.push({ id: u.id, label: `↳ ${u.name} (${u.code})` })
  }
  return out
})
const typeScope = ref('all')
const shownTypes = computed(() => (typeScope.value === 'all' ? types.value : types.value.filter((t) => (t.office_id ?? '') === (typeScope.value === 'global' ? '' : typeScope.value))))

const newType = reactive({ name: '', description: '', office_id: '', processing_days: 1, processing_hours: 0, processing_minutes: 0 })
async function addType() {
  if (!newType.name.trim()) return
  const ok = await run('add-type', () => api.post('/org/document-types', { ...newType, office_id: newType.office_id || null }), `“${newType.name.trim()}” added`)
  if (ok) {
    Object.assign(newType, { name: '', description: '', office_id: newType.office_id, processing_days: 1, processing_hours: 0, processing_minutes: 0 })
    refresh()
  }
}

const editing = ref<string | null>(null)
const editForm = reactive({ name: '', description: '', office_id: '', processing_days: 0, processing_hours: 0, processing_minutes: 0 })
function startEdit(t: DocumentTypeItem) {
  editing.value = t.id
  suggestion.value = null
  Object.assign(editForm, {
    name: t.name,
    description: t.description ?? '',
    office_id: t.office_id ?? '',
    processing_days: t.processing_days,
    processing_hours: t.processing_hours,
    processing_minutes: t.processing_minutes ?? 0,
  })
}

// "Suggest from Citizen's Charter": read from the charter text of the type's service. Nothing is
// saved until the admin applies it and saves.
interface TimeSuggestion {
  found: boolean
  days?: number
  hours?: number
  minutes?: number
  basis?: 'total' | 'stated' | 'sum_of_steps' | 'ai'
  source?: { title: string; page: number | null }
  lines?: string[]
  reason?: string
}
const suggestion = ref<TimeSuggestion | null>(null)
const BASIS_TEXT: Record<NonNullable<TimeSuggestion['basis']>, string> = {
  total: 'the total processing time the charter states',
  stated: 'the processing time the charter states',
  sum_of_steps: 'the charter’s step times added up — check it',
  ai: 'the AI’s reading of the charter (quoted below) — check it',
}
async function suggestTime(t: DocumentTypeItem) {
  suggestion.value = null
  const res = await run(`suggest-${t.id}`, () => api.post<{ suggestion: TimeSuggestion }>(`/org/document-types/${t.id}/suggest-time`))
  if (res) suggestion.value = res.suggestion
}
function applySuggestion() {
  const sgt = suggestion.value
  if (!sgt?.found) return
  Object.assign(editForm, { processing_days: sgt.days ?? 0, processing_hours: sgt.hours ?? 0, processing_minutes: sgt.minutes ?? 0 })
}

// "Import from Citizen's Charter": the charter's List of Services, ticked rows become types.
interface CharterRow {
  office: string
  parent_office: string
  division: string | null
  category: 'INTERNAL' | 'EXTERNAL' | null
  name: string
  page: number | null
  office_id: string | null
  already_exists: boolean
  pick?: boolean
}
const importOpen = ref(false)
const importFileId = ref('')
const importRows = ref<CharterRow[]>([])
const importNeedsReread = ref(false)
const switchOffDefaults = ref(true)
const charterFiles = computed(() => files.value.filter((f) => f.status === 'READY'))
const importGroups = computed(() => {
  const groups: Array<{ office: string; rows: CharterRow[] }> = []
  for (const r of importRows.value) {
    if (groups.at(-1)?.office !== r.office) groups.push({ office: r.office, rows: [] })
    groups.at(-1)!.rows.push(r)
  }
  return groups
})
const importPicked = computed(() => importRows.value.filter((r) => r.pick))
function openImport() {
  importOpen.value = true
  importRows.value = []
  importFileId.value = charterFiles.value.find((f) => f.kind === 'CITIZENS_CHARTER')?.id ?? charterFiles.value[0]?.id ?? ''
  if (importFileId.value) loadPreview()
}
async function loadPreview() {
  importRows.value = []
  if (!importFileId.value) return
  const res = await run('preview', () => api.post<{ rows: CharterRow[]; needs_reread: boolean }>('/org/document-types/charter/preview', { file_id: importFileId.value }))
  if (!res) return
  importNeedsReread.value = res.needs_reread
  importRows.value = res.rows.map((r) => ({ ...r, pick: !r.already_exists }))
}
/** One office choice per charter office group; Global = '' (every office). */
function setGroupOffice(group: { rows: CharterRow[] }, officeId: string) {
  for (const r of group.rows) r.office_id = officeId || null
}
function setGroupPick(group: { rows: CharterRow[] }, value: boolean) {
  for (const r of group.rows) r.pick = value && !r.already_exists
}
async function runImport() {
  const rows = importPicked.value.map(({ name, category, office_id, page }) => ({ name, category, office_id, page }))
  const res = await run('import', () =>
    api.post<{ created: number; skipped: number; switched_off: number }>('/org/document-types/charter/import', { file_id: importFileId.value, rows, switch_off_defaults: switchOffDefaults.value }),
  )
  if (res) {
    ui.success(
      `${res.created} document type${res.created === 1 ? '' : 's'} imported`,
      [res.skipped && `${res.skipped} already existed`, res.switched_off && `${res.switched_off} starting type${res.switched_off === 1 ? '' : 's'} switched off`, 'set their processing times next'].filter(Boolean).join(' · '),
    )
    importOpen.value = false
    refresh()
  }
}
async function saveEdit(t: DocumentTypeItem) {
  const ok = await run(`edit-${t.id}`, () => api.patch(`/org/document-types/${t.id}`, { ...editForm, office_id: editForm.office_id || null }), 'Document type saved')
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
// office_id '' = organization-wide. The scope is chosen here, never taken from the uploader's office.
const upload = reactive({ title: '', description: '', office_id: '', charter: false })
const { data: officeData } = useLazyAsyncData('knowledge-offices', () => api.get<{ data: Array<{ id: string; name: string; code: string; parent_office_id?: string | null }> }>('/offices'), { server: false })
const offices = computed(() => officeData.value?.data ?? [])
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
  if (upload.office_id) fd.append('office_id', upload.office_id)
  fd.append('kind', upload.charter ? 'CITIZENS_CHARTER' : 'GENERAL')

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
      Object.assign(upload, { title: '', description: '', office_id: '', charter: false })
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
/** Who the AI may use this file for: '' = the whole organization, else one office (and admins). */
async function setFileScope(f: KnowledgeFileItem, officeId: string) {
  if ((f.office?.id ?? '') === officeId) return
  const name = offices.value.find((o) => o.id === officeId)?.name
  const ok = await run(`kfscope-${f.id}`, () => api.patch(`/org/knowledge/${f.id}`, { office_id: officeId || null }), name ? `Only ${name} (and admins) can use this file now` : 'The whole organization can use this file now')
  if (ok) refresh()
}

async function toggleCharter(f: KnowledgeFileItem) {
  const charter = f.kind !== 'CITIZENS_CHARTER'
  const ok = await run(`kfkind-${f.id}`, () => api.patch(`/org/knowledge/${f.id}`, { kind: charter ? 'CITIZENS_CHARTER' : 'GENERAL' }), charter ? 'Marked as Citizen’s Charter' : 'No longer marked as Citizen’s Charter')
  if (ok) refresh()
}

/** Files uploaded before pages and headings were kept: read the stored copy again. */
async function rereadFile(f: KnowledgeFileItem) {
  const ok = await run(`kfre-${f.id}`, () => api.post(`/org/knowledge/${f.id}/reindex`), 'File re-read — pages and headings are kept now')
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
    <PageHeader
      eyebrow="Administration"
      title="Organization Settings"
      description="Your organization’s profile and logo, working hours, the document types offered when uploading, document templates, and the knowledge the AI uses."
    />

    <div class="mb-6 flex w-fit max-w-full gap-1 overflow-x-auto rounded-xl bg-ink/[0.04] p-1" role="tablist">
      <button v-for="t in TABS" :key="t.key" role="tab" class="tab shrink-0" :class="tab === t.key && 'tab-active'" :aria-selected="tab === t.key" @click="tab = t.key">
        <FIcon :name="t.icon" :size="15" /> {{ t.label }}
        <span v-if="t.key === 'types'" class="text-xs text-ink-2">{{ types.length }}</span>
        <span v-else-if="t.key === 'templates'" class="text-xs text-ink-2">{{ data?.templates.length ?? 0 }}</span>
        <span v-else-if="t.key === 'knowledge'" class="text-xs text-ink-2">{{ files.length }}</span>
      </button>
    </div>

    <!-- Organization profile and logo -->
    <div v-if="tab === 'profile'" class="space-y-6">
      <section class="card card-pad max-w-2xl">
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
      <SettingsOrgLogo :logo-url="data?.organization.logo_url ?? null" @changed="refresh()" />
    </div>

    <!-- Working hours and holidays: processing time pauses outside them -->
    <SettingsWorkHours v-else-if="tab === 'hours' && data" :calendar="data.work_calendar" :holidays="data.holidays" @changed="refresh()" />

    <!-- Document templates for the AI Assistant's canvases -->
    <SettingsTemplates
      v-else-if="tab === 'templates' && data"
      :templates="data.templates"
      :organization="{ name: data.organization.name, logo_url: data.organization.logo_url }"
      :available="data.work_calendar.available"
      @changed="refresh()"
    />

    <!-- Document types -->
    <div v-else-if="tab === 'types'" class="grid grid-cols-1 gap-6 lg:grid-cols-[minmax(0,1fr)_340px]">
      <section class="card overflow-hidden">
        <div class="card-pad pb-3">
          <h2 class="text-lg">Document types</h2>
          <div class="flex flex-wrap items-start justify-between gap-2">
            <p class="mt-1 max-w-2xl text-sm text-ink-body">
              Offered when someone uploads a document: <strong>Global</strong> types to every office (e.g. Payroll), the others only to their office. Each type's processing time sets the deadline of documents submitted with it.
            </p>
            <button type="button" class="btn btn-secondary btn-sm" @click="openImport"><FIcon name="book-open" :size="14" /> Import from Citizen’s Charter</button>
          </div>
          <label class="mt-3 block max-w-xs">
            <span class="sr-only">Show the types of</span>
            <select v-model="typeScope" class="input !min-h-9 !text-sm">
              <option value="all">All types ({{ types.length }})</option>
              <option value="global">Global types</option>
              <option v-for="o in scopeOptions.slice(1)" :key="o.id" :value="o.id">{{ o.label }}</option>
            </select>
          </label>
          <p class="mt-2 flex items-start gap-2 rounded-xl bg-ink/[0.035] px-3 py-2 text-[13px] text-ink-body">
            <FIcon name="clock" :size="14" class="mt-0.5 shrink-0 text-ink-2" />
            <span v-if="calendarText">Processing time counts working time only — {{ calendarText }}. Nights, days off and holidays don’t count, so 1 day means one working day.</span>
            <span v-else>Processing time runs around the clock. Set your <button type="button" class="font-medium underline" @click="tab = 'hours'">working hours and holidays</button> to pause it outside them.</span>
          </p>
        </div>
        <div v-if="!types.length" class="px-6 pb-6">
          <EmptyState icon="tag" title="No document types yet" description="Add the kinds of documents your organization handles." />
        </div>
        <ul v-else class="divide-y divide-line/60 border-t border-line/60">
          <li v-for="(t, i) in shownTypes" :key="t.id" class="flex gap-3 p-4" :class="!t.is_active && 'opacity-60'">
            <div class="flex shrink-0 flex-col">
              <button class="grid size-6 place-items-center rounded text-ink-2 hover:bg-ink/5 disabled:opacity-30" :disabled="i === 0" aria-label="Move up" @click="moveType(t, -1)"><FIcon name="chevron-up" :size="14" /></button>
              <button class="grid size-6 place-items-center rounded text-ink-2 hover:bg-ink/5 disabled:opacity-30" :disabled="i === shownTypes.length - 1" aria-label="Move down" @click="moveType(t, 1)"><FIcon name="chevron-down" :size="14" /></button>
            </div>

            <form v-if="editing === t.id" class="min-w-0 flex-1 space-y-2" @submit.prevent="saveEdit(t)">
              <input v-model="editForm.name" class="input" maxlength="100" required aria-label="Name" />
              <textarea v-model="editForm.description" class="input" rows="2" maxlength="500" placeholder="What documents belong here (helps the AI choose)" aria-label="Description" />
              <label class="block">
                <span class="field-label">Offered to</span>
                <select v-model="editForm.office_id" class="input">
                  <option v-for="o in scopeOptions" :key="o.id" :value="o.id">{{ o.label }}</option>
                </select>
              </label>
              <ProcessingTimeInput :id="`edit-time-${t.id}`" v-model:days="editForm.processing_days" v-model:hours="editForm.processing_hours" v-model:minutes="editForm.processing_minutes" :working="!!calendarText" />
              <div>
                <button type="button" class="btn btn-ghost btn-sm" :disabled="busy === `suggest-${t.id}`" :aria-busy="busy === `suggest-${t.id}`" @click="suggestTime(t)">
                  <FIcon name="zap" :size="14" /> Suggest from Citizen’s Charter
                </button>
                <div v-if="suggestion" class="mt-2 rounded-xl px-3 py-2 text-[13px]" :class="suggestion.found ? 'bg-info/10 text-info-ink' : 'bg-ink/[0.04] text-ink-body'">
                  <template v-if="suggestion.found">
                    <p>
                      Suggested: <strong>{{ processingLabel(suggestion.days ?? 0, suggestion.hours ?? 0, !!calendarText, suggestion.minutes ?? 0) }}</strong> — from {{ BASIS_TEXT[suggestion.basis!] }}.
                      <span class="block text-xs opacity-80">{{ suggestion.source?.title }}<template v-if="suggestion.source?.page">, p. {{ suggestion.source.page }}</template></span>
                    </p>
                    <ul class="mt-1 list-inside list-disc text-xs opacity-80"><li v-for="(l, li) in suggestion.lines" :key="li">{{ l }}</li></ul>
                    <button type="button" class="btn btn-sm btn-secondary mt-2" @click="applySuggestion">Use this time</button>
                  </template>
                  <template v-else>{{ suggestion.reason }}</template>
                </div>
              </div>
              <p v-if="editForm.processing_days !== t.processing_days || editForm.processing_hours !== t.processing_hours || editForm.processing_minutes !== (t.processing_minutes ?? 0)" class="text-xs text-ink-2">
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
                  <ToneBadge :tone="t.office ? 'info' : 'primary'">{{ t.office ? t.office.name : 'Global' }}</ToneBadge>
                  <ToneBadge v-if="t.service_category" tone="neutral">{{ t.service_category === 'INTERNAL' ? 'Internal' : 'External' }}</ToneBadge>
                </p>
                <p v-if="t.description" class="mt-0.5 text-[13px] text-ink-body">{{ t.description }}</p>
                <p class="mt-1 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-ink-2">
                  <span class="inline-flex items-center gap-1" :class="t.total_minutes ? 'text-ink-body' : ''">
                    <FIcon name="clock" :size="12" /> {{ t.total_minutes ? `Process within ${processingLabel(t.processing_days, t.processing_hours, !!calendarText, t.processing_minutes ?? 0)}` : 'No time limit set' }}
                  </span>
                  <span v-if="t.source_page">Citizen’s Charter p. {{ t.source_page }}</span>
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
          <div>
            <label class="field-label" for="type-scope">Offered to</label>
            <select id="type-scope" v-model="newType.office_id" class="input">
              <option v-for="o in scopeOptions" :key="o.id" :value="o.id">{{ o.label }}</option>
            </select>
            <p class="field-hint">Global types (e.g. Payroll) are offered to every office.</p>
          </div>
          <ProcessingTimeInput id="new-type-time" v-model:days="newType.processing_days" v-model:hours="newType.processing_hours" v-model:minutes="newType.processing_minutes" :working="!!calendarText" />
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
            <div>
              <label class="field-label" for="kf-office">Who the AI may use it for</label>
              <select id="kf-office" v-model="upload.office_id" class="input">
                <option value="">The whole organization</option>
                <option v-for="o in offices" :key="o.id" :value="o.id">Only {{ o.name }} (and admins)</option>
              </select>
              <p class="field-hint">An office’s own Citizen’s Charter can be limited to that office.</p>
            </div>
            <label class="flex items-center gap-2 text-sm">
              <input v-model="upload.charter" type="checkbox" class="size-4" /> This is a Citizen’s Charter (services, requirements, fees, processing times)
            </label>
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
                <ToneBadge v-if="f.kind === 'CITIZENS_CHARTER'" tone="info">Citizen’s Charter</ToneBadge>
                <ToneBadge :tone="f.office ? 'warning' : 'neutral'">{{ f.office ? `Only ${f.office.name}` : 'Whole organization' }}</ToneBadge>
              </p>
              <p v-if="f.description" class="mt-0.5 text-[13px] text-ink-body">{{ f.description }}</p>
              <p class="mt-1 text-xs text-ink-2">
                {{ f.file_name }} · {{ formatBytes(f.file_size) }}<template v-if="f.status === 'READY'"> · {{ f.char_count.toLocaleString() }} characters</template>
                · {{ formatDate(f.created_at) }}<template v-if="f.uploader"> · {{ fullName(f.uploader) }}</template>
              </p>
              <p v-if="f.error" class="mt-1 text-xs text-danger-ink">{{ f.error }}</p>
              <p v-if="f.needs_reread" class="mt-1 text-xs text-amber-ink">Read before pages and headings were kept — re-read it so answers can cite pages.</p>
              <div class="mt-2 flex flex-wrap items-center gap-2">
                <label class="sr-only" :for="`kf-scope-${f.id}`">Who the AI may use {{ f.title }} for</label>
                <select
                  :id="`kf-scope-${f.id}`"
                  class="input h-8 w-auto py-0 text-xs"
                  :value="f.office?.id ?? ''"
                  :disabled="busy === `kfscope-${f.id}`"
                  @change="setFileScope(f, ($event.target as HTMLSelectElement).value)"
                >
                  <option value="">Whole organization</option>
                  <option v-for="o in offices" :key="o.id" :value="o.id">Only {{ o.name }}</option>
                </select>
                <button class="btn btn-sm btn-ghost" :disabled="busy === `kfkind-${f.id}`" :aria-busy="busy === `kfkind-${f.id}`" @click="toggleCharter(f)">
                  <FIcon name="book-open" :size="14" /> {{ f.kind === 'CITIZENS_CHARTER' ? 'Unmark charter' : 'Mark as Citizen’s Charter' }}
                </button>
                <button v-if="f.needs_reread" class="btn btn-sm btn-ghost" :disabled="busy === `kfre-${f.id}`" :aria-busy="busy === `kfre-${f.id}`" @click="rereadFile(f)">
                  <FIcon name="refresh-cw" :size="14" /> Re-read
                </button>
              </div>
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
    <AppModal :open="importOpen" title="Import from Citizen’s Charter" description="Services in the charter’s List of Services become document types. Processing times stay empty until you set them (or accept a suggestion)." width="lg" @close="importOpen = false">
      <div v-if="!charterFiles.length" class="text-sm text-ink-body">Upload the Citizen’s Charter first, in the AI knowledge tab.</div>
      <template v-else>
        <label class="block">
          <span class="field-label">Charter file</span>
          <select v-model="importFileId" class="input" @change="loadPreview">
            <option v-for="f in charterFiles" :key="f.id" :value="f.id">{{ f.title }}{{ f.kind === 'CITIZENS_CHARTER' ? '' : ' (not marked as charter)' }}</option>
          </select>
        </label>
        <p v-if="busy === 'preview'" class="mt-4 flex items-center gap-2 text-sm text-ink-2"><span class="spinner" /> Reading the List of Services…</p>
        <p v-else-if="importNeedsReread" class="mt-4 text-sm text-amber-ink">This file was read before pages and lines were kept. Press <strong>Re-read</strong> on it in the AI knowledge tab, then try again.</p>
        <p v-else-if="!importRows.length" class="mt-4 text-sm text-ink-2">No List of Services was found in this file.</p>
        <template v-else>
          <p class="mt-4 text-sm text-ink-body">
            {{ importRows.length }} services in {{ importGroups.length }} offices · <strong>{{ importPicked.length }}</strong> ticked. Choose the FlowVision office for each charter office, or Global.
          </p>
          <div class="mt-3 max-h-[50vh] space-y-4 overflow-y-auto pr-1">
            <section v-for="g in importGroups" :key="g.office" class="rounded-xl border border-line p-3">
              <div class="flex flex-wrap items-center gap-2">
                <p class="min-w-0 flex-1 text-sm font-semibold">{{ g.office }}</p>
                <select class="input !min-h-8 w-auto !py-0 !text-xs" :value="g.rows[0]?.office_id ?? ''" :aria-label="`FlowVision office for ${g.office}`" @change="setGroupOffice(g, ($event.target as HTMLSelectElement).value)">
                  <option v-for="o in scopeOptions" :key="o.id" :value="o.id">{{ o.label }}</option>
                </select>
                <button type="button" class="btn btn-ghost btn-sm" @click="setGroupPick(g, !g.rows.some((r) => r.pick))">{{ g.rows.some((r) => r.pick) ? 'Untick all' : 'Tick all' }}</button>
              </div>
              <ul class="mt-2 space-y-1">
                <li v-for="(r, ri) in g.rows" :key="ri">
                  <label class="flex items-start gap-2 text-[13px]" :class="r.already_exists && 'opacity-50'">
                    <input v-model="r.pick" type="checkbox" class="mt-0.5 size-4" :disabled="r.already_exists" />
                    <span class="min-w-0 flex-1">{{ r.name }}<span class="text-ink-2"> · {{ r.category === 'INTERNAL' ? 'Internal' : r.category === 'EXTERNAL' ? 'External' : 'Unlabelled' }}<template v-if="r.page"> · p. {{ r.page }}</template><template v-if="r.already_exists"> · already a type</template></span></span>
                  </label>
                </li>
              </ul>
            </section>
          </div>
          <label class="mt-4 flex items-center gap-2 text-sm">
            <input v-model="switchOffDefaults" type="checkbox" class="size-4" /> Switch off the starting types (Purchase Request, Leave Application, …). They aren’t deleted; you can switch them on again.
          </label>
        </template>
      </template>
      <template #footer>
        <button class="btn btn-ghost" @click="importOpen = false">Cancel</button>
        <button class="btn btn-primary" :disabled="!importPicked.length || busy === 'import'" :aria-busy="busy === 'import'" @click="runImport"><FIcon name="download" :size="16" /> Import {{ importPicked.length }}</button>
      </template>
    </AppModal>

  </div>
</template>
