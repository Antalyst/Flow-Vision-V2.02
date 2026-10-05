<script setup lang="ts">
import type { DocumentScope } from '~/composables/useDocuments'

const auth = useAuthStore()
// The CLIENT administrator sees every document. An EMPLOYEE sees its own uploads, its office staff's
// uploads and everything that reaches its office. STAFF see only their own uploads (enforced on the server).
const everyone = auth.role === 'CLIENT'
const isEmployee = auth.role === 'EMPLOYEE'
const pageTitle = everyone ? 'Documents' : isEmployee ? 'Office documents' : 'My uploads'
useHead({ title: `${pageTitle} · FlowVision` })

const SCOPES: Array<{ key: DocumentScope; label: string }> = [
  { key: 'all', label: 'Everything I can see' },
  { key: 'mine', label: 'My uploads' },
  { key: 'team', label: 'Office staff uploads' },
  { key: 'visited', label: 'Reached my office' },
]
const scope = ref<DocumentScope>(everyone || isEmployee ? 'all' : 'mine')

const docsApi = useDocuments()
const route = useRoute()

const TABS = [
  { key: '', label: 'All' },
  { key: 'START,PICKED_UP,IN_TRANSIT,ARRIVED_AT_OFFICE', label: 'In progress' },
  { key: 'COMPLETED', label: 'Completed' },
  { key: 'RETURNED', label: 'Returned' },
  { key: 'CREATED', label: 'Drafts' },
]

const tab = ref(typeof route.query.status === 'string' ? route.query.status : '')
const q = ref('')
const page = ref(1)
const debouncedQ = refDebounced(q, 300)

const { data, status, refresh } = await useAsyncData(
  'documents-list',
  () => docsApi.list({ scope: scope.value, status: tab.value || undefined, q: debouncedQ.value || undefined, page: page.value, limit: 20 }),
  { watch: [tab, debouncedQ, page, scope] },
)
watch([tab, debouncedQ, scope], () => (page.value = 1))
useLiveRefresh(refresh)

const totalPages = computed(() => Math.max(1, Math.ceil((data.value?.meta.total ?? 0) / 20)))
</script>

<template>
  <div class="fv-rise">
    <PageHeader
      eyebrow="A3 · Documents"
      :title="pageTitle"
      :description="
        everyone
          ? 'Everything your organization has submitted, with its live position on its route.'
          : isEmployee
            ? 'Your uploads, your office staff’s uploads, and every document that has reached your office — with its live position on its route.'
            : 'Documents you uploaded, with their live position on their route.'
      "
    >
      <template #actions>
        <NuxtLink to="/documents/new" class="btn btn-primary"><FIcon name="plus" :size="16" /> Upload document</NuxtLink>
      </template>
    </PageHeader>

    <div v-if="isEmployee" class="mb-3 flex flex-wrap gap-2" role="group" aria-label="Whose documents">
      <button
        v-for="s in SCOPES"
        :key="s.key"
        class="btn btn-sm"
        :class="scope === s.key ? 'btn-primary' : 'btn-ghost'"
        :aria-pressed="scope === s.key"
        @click="scope = s.key"
      >
        {{ s.label }}
      </button>
    </div>

    <div class="mb-5 flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
      <div class="flex gap-1 overflow-x-auto rounded-xl bg-ink/[0.04] p-1" role="tablist">
        <button
          v-for="t in TABS"
          :key="t.key"
          role="tab"
          :aria-selected="tab === t.key"
          class="tab shrink-0"
          :class="tab === t.key && 'tab-active'"
          @click="tab = t.key"
        >
          {{ t.label }}
        </button>
      </div>
      <div class="relative sm:w-72">
        <FIcon name="search" :size="16" class="absolute top-1/2 left-3.5 -translate-y-1/2 text-ink-2" />
        <input v-model="q" class="input pl-10" placeholder="Search title or tracking no." aria-label="Search documents" />
      </div>
    </div>

    <PageSkeleton v-if="status === 'pending' && !data" variant="list" :rows="6" :messages="['Loading documents…', 'Fetching routes and status…']" />
    <div v-else-if="!data?.data.length" class="card">
      <EmptyState icon="file-text" :title="q ? 'No matches' : 'Nothing here yet'" :description="q ? 'Try a different search.' : 'Documents you submit will show up here.'" />
    </div>
    <div v-else class="grid grid-cols-1 gap-3 lg:grid-cols-2">
      <DocumentCard v-for="d in data.data" :key="d.id" :doc="d" :show-submitter="everyone || isEmployee" />
    </div>

    <nav v-if="totalPages > 1" class="mt-6 flex items-center justify-center gap-2" aria-label="Pagination">
      <button class="btn btn-sm btn-ghost" :disabled="page <= 1" @click="page--"><FIcon name="chevron-left" :size="16" /> Prev</button>
      <span class="mono px-2 text-ink-2">{{ page }} / {{ totalPages }}</span>
      <button class="btn btn-sm btn-ghost" :disabled="page >= totalPages" @click="page++">Next <FIcon name="chevron-right" :size="16" /></button>
    </nav>
  </div>
</template>
