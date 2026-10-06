<script setup lang="ts">
import type { FlowDocument, Issue } from '~/types'
import type { Tone } from '~/utils/format'

useHead({ title: 'Issues · FlowVision' })

const api = useApi()
const auth = useAuthStore()
const route = useRoute()
const { busy, run } = useAction()

const status = ref<'' | Issue['status']>('')
const { data, refresh } = await useAsyncData('issues', () => api.get<{ data: Issue[] }>('/issues', { status: status.value || undefined }), {
  watch: [status],
})

const CATEGORIES = ['MISSING_DOCUMENT', 'DELAY', 'DAMAGE', 'INCORRECT_ROUTING', 'SYSTEM', 'OTHER']
const SEVERITY_TONE: Record<Issue['severity'], Tone> = { LOW: 'neutral', MEDIUM: 'info', HIGH: 'warning', CRITICAL: 'danger' }
const STATUS_TONE: Record<Issue['status'], Tone> = { OPEN: 'danger', IN_PROGRESS: 'warning', RESOLVED: 'success', CLOSED: 'neutral' }
const label = (s: string) => s.replace(/_/g, ' ').toLowerCase().replace(/^\w/, (c) => c.toUpperCase())

// Report — every issue is about a document, so the form needs one.
const formOpen = ref(false)
const form = reactive({ title: '', description: '', category: 'OTHER', severity: 'MEDIUM', document_id: '' })
const documentOptions = ref<FlowDocument[]>([])

async function openReport() {
  formOpen.value = true
  if (!documentOptions.value.length) {
    documentOptions.value = (await api.get<{ data: FlowDocument[] }>('/documents', { scope: 'all', limit: 100 })).data.filter((d) => d.status !== 'CREATED')
  }
}

onMounted(() => {
  if (typeof route.query.document === 'string') {
    form.document_id = route.query.document
    form.category = 'DELAY'
    openReport()
  }
})

async function report() {
  const ok = await run('report', () => api.post('/issues', { ...form }), 'Issue reported')
  if (ok) {
    formOpen.value = false
    Object.assign(form, { title: '', description: '', category: 'OTHER', severity: 'MEDIUM', document_id: '' })
    refresh()
  }
}

// Update
const resolving = ref<Issue | null>(null)
const resolution = ref('')
const canManage = (i: Issue) => auth.role === 'CLIENT' || i.reported_by === auth.user?.id || i.assigned_to === auth.user?.id

async function setStatus(i: Issue, next: Issue['status'], extra: Record<string, unknown> = {}) {
  const ok = await run(`status-${i.id}`, () => api.patch(`/issues/${i.id}`, { status: next, ...extra }), `Issue marked ${label(next).toLowerCase()}`)
  if (ok) {
    resolving.value = null
    resolution.value = ''
    refresh()
  }
}
</script>

<template>
  <div class="fv-rise">
    <PageHeader eyebrow="Collaborate" title="Issues" description="Flag delays, missing paperwork or routing mistakes so the right people can fix them.">
      <template #actions>
        <button class="btn btn-primary" @click="openReport"><FIcon name="flag" :size="16" /> Report issue</button>
      </template>
    </PageHeader>

    <div class="mb-5 flex w-fit max-w-full gap-1 overflow-x-auto rounded-xl bg-ink/[0.04] p-1" role="tablist">
      <button v-for="s in ['', 'OPEN', 'IN_PROGRESS', 'RESOLVED', 'CLOSED'] as const" :key="s" class="tab shrink-0" :class="status === s && 'tab-active'" role="tab" :aria-selected="status === s" @click="status = s">
        {{ s ? label(s) : 'All' }}
      </button>
    </div>

    <div v-if="!data?.data.length" class="card">
      <EmptyState icon="check-circle" title="No issues" description="Nothing has been reported here." />
    </div>
    <div v-else class="space-y-3">
      <article v-for="i in data.data" :key="i.id" class="card card-pad">
        <div class="flex flex-wrap items-start justify-between gap-3">
          <div class="min-w-0">
            <div class="flex flex-wrap items-center gap-2">
              <ToneBadge :tone="STATUS_TONE[i.status]" dot>{{ label(i.status) }}</ToneBadge>
              <ToneBadge :tone="SEVERITY_TONE[i.severity]">{{ label(i.severity) }}</ToneBadge>
              <span class="text-xs text-ink-2">{{ label(i.category) }}</span>
            </div>
            <h2 class="mt-2 text-base">{{ i.title }}</h2>
            <p class="mt-1 text-xs text-ink-2">
              Reported by {{ fullName(i.reporter) }} · {{ timeAgo(i.created_at) }}
              <template v-if="i.assignee"> · assigned to {{ fullName(i.assignee) }}</template>
            </p>
          </div>
          <NuxtLink v-if="i.document" :to="`/documents/${i.document.id}`" class="btn btn-sm btn-ghost"><FIcon name="file-text" :size="14" /> {{ i.document.tracking_number }}</NuxtLink>
        </div>
        <p v-if="i.description" class="mt-3 text-sm whitespace-pre-wrap text-ink-body">{{ i.description }}</p>
        <p v-if="i.resolution" class="mt-3 rounded-xl bg-sage/10 px-3 py-2 text-sm text-sage-ink"><strong>Resolution:</strong> {{ i.resolution }}</p>
        <div v-if="canManage(i) && !['RESOLVED', 'CLOSED'].includes(i.status)" class="mt-4 flex flex-wrap gap-2 border-t border-line/60 pt-4">
          <button v-if="i.status === 'OPEN'" class="btn btn-sm btn-ghost" :disabled="!!busy" :aria-busy="busy === `status-${i.id}`" @click="setStatus(i, 'IN_PROGRESS')">Start working on it</button>
          <button class="btn btn-sm btn-secondary" @click="resolving = i"><FIcon name="check" :size="14" /> Resolve</button>
        </div>
        <div v-else-if="canManage(i) && i.status === 'RESOLVED'" class="mt-4 border-t border-line/60 pt-4">
          <button class="btn btn-sm btn-ghost" :disabled="!!busy" :aria-busy="busy === `status-${i.id}`" @click="setStatus(i, 'CLOSED')">Close</button>
        </div>
      </article>
    </div>

    <AppModal :open="formOpen" title="Report an issue" @close="formOpen = false">
      <form id="issue-form" class="space-y-4" @submit.prevent="report">
        <div>
          <label class="field-label" for="i-title">What's wrong?</label>
          <input id="i-title" v-model="form.title" class="input" required maxlength="255" placeholder="e.g. Document stuck at Budget for 3 days" />
        </div>
        <div class="grid grid-cols-1 gap-4 sm:grid-cols-2">
          <div>
            <label class="field-label" for="i-cat">Category</label>
            <select id="i-cat" v-model="form.category" class="input">
              <option v-for="c in CATEGORIES" :key="c" :value="c">{{ label(c) }}</option>
            </select>
          </div>
          <div>
            <label class="field-label" for="i-sev">Severity</label>
            <select id="i-sev" v-model="form.severity" class="input">
              <option v-for="s in ['LOW', 'MEDIUM', 'HIGH', 'CRITICAL']" :key="s" :value="s">{{ label(s) }}</option>
            </select>
          </div>
        </div>
        <div>
          <label class="field-label" for="i-desc">Details</label>
          <textarea id="i-desc" v-model="form.description" class="input" rows="4" maxlength="5000" />
        </div>
        <div>
          <label class="field-label" for="i-doc">Document</label>
          <select id="i-doc" v-model="form.document_id" class="input" required>
            <option value="" disabled>Which document is this about?</option>
            <option v-for="d in documentOptions" :key="d.id" :value="d.id">{{ d.tracking_number }} · {{ d.title }}</option>
          </select>
        </div>
      </form>
      <template #footer>
        <button class="btn btn-ghost" @click="formOpen = false">Cancel</button>
        <button class="btn btn-primary" form="issue-form" :disabled="busy === 'report'" :aria-busy="busy === 'report'">Report issue</button>
      </template>
    </AppModal>

    <AppModal :open="Boolean(resolving)" title="Resolve issue" :description="resolving?.title" width="sm" @close="resolving = null">
      <label class="field-label" for="resolution">How was it resolved?</label>
      <textarea id="resolution" v-model="resolution" class="input" rows="3" maxlength="5000" />
      <template #footer>
        <button class="btn btn-ghost" @click="resolving = null">Cancel</button>
        <button class="btn btn-primary" :disabled="!!busy" :aria-busy="busy === `status-${resolving?.id}`" @click="setStatus(resolving!, 'RESOLVED', { resolution: resolution || undefined })">Mark resolved</button>
      </template>
    </AppModal>
  </div>
</template>
