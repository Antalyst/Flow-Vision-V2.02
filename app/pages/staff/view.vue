<script setup lang="ts">
import type { DocumentDetail } from '~/composables/useDocuments'

useHead({ title: 'Document view · FlowVision' })

const docsApi = useDocuments()
const auth = useAuthStore()

const q = ref('')
const debouncedQ = refDebounced(q, 300)
const { data, refresh } = await useAsyncData('staff-view-list', () => docsApi.list({ scope: 'all', q: debouncedQ.value || undefined, limit: 50 }), {
  watch: [debouncedQ],
})

const selectedId = ref<string | null>(null)
const detail = ref<DocumentDetail | null>(null)
const loadingDetail = ref(false)

async function select(id: string) {
  selectedId.value = id
  loadingDetail.value = true
  try {
    detail.value = await docsApi.get(id)
  } finally {
    loadingDetail.value = false
  }
}

useLiveRefresh(() => {
  refresh()
  if (selectedId.value) select(selectedId.value)
})
</script>

<template>
  <div class="fv-rise">
    <PageHeader eyebrow="C3 · View only" title="Document view" description="Track the documents you uploaded across every office on their route. This view is read-only." />

    <AuthorityBanner v-if="!auth.user?.has_approval_authority" :authority="false" :office-name="auth.user?.office?.name" class="mb-6" />

    <div class="grid grid-cols-1 gap-6 lg:grid-cols-[360px_minmax(0,1fr)]">
      <section class="card flex max-h-[calc(100dvh-220px)] flex-col overflow-hidden">
        <div class="border-b border-line/60 p-4">
          <div class="relative">
            <FIcon name="search" :size="16" class="absolute top-1/2 left-3.5 -translate-y-1/2 text-ink-2" />
            <input v-model="q" class="input pl-10" placeholder="Search title or tracking no." aria-label="Search documents" />
          </div>
        </div>
        <ul class="flex-1 divide-y divide-line/50 overflow-y-auto">
          <li v-if="!data?.data.length" class="p-6 text-center text-sm text-ink-2">No documents found.</li>
          <li v-for="d in data?.data" :key="d.id">
            <button
              class="w-full px-4 py-3 text-left transition-colors"
              :class="selectedId === d.id ? 'bg-terracotta/[0.07]' : 'hover:bg-ink/[0.025]'"
              :aria-pressed="selectedId === d.id"
              @click="select(d.id)"
            >
              <div class="flex items-center justify-between gap-2">
                <span class="mono text-ink-2">{{ d.tracking_number }}</span>
                <StatusBadge :status="d.status" />
              </div>
              <p class="mt-1 truncate text-sm font-medium">{{ d.title }}</p>
              <p class="mt-0.5 truncate text-xs text-ink-2">{{ whereabouts(d) }}</p>
            </button>
          </li>
        </ul>
      </section>

      <section class="min-w-0">
        <div v-if="!selectedId" class="card">
          <EmptyState icon="eye" title="Select a document" description="Pick a document on the left to see its route and full timeline." />
        </div>
        <PageSkeleton v-else-if="loadingDetail && !detail" variant="detail" :messages="['Opening document…', 'Loading the timeline…']" />
        <div v-else-if="detail" class="space-y-6">
          <div class="card card-pad">
            <div class="flex flex-wrap items-center gap-2">
              <span class="mono text-ink-2">{{ detail.document.tracking_number }}</span>
              <StatusBadge :status="detail.document.status" />
              <PriorityBadge :priority="detail.document.priority" />
            </div>
            <h2 class="mt-2 text-xl">{{ detail.document.title }}</h2>
            <p class="mt-1 text-sm text-ink-body">{{ whereabouts(detail.document) }}</p>
            <div v-if="detail.route" class="mt-6">
              <RouteFlow :steps="detail.route.steps" :current-step="detail.document.current_step_number" :status="detail.document.status" :received="!!detail.document.received_at" :released="!!detail.document.pickup_requested_at" :origin="detail.document.origin" :uploaded-by="detail.document.submitter ? fullName(detail.document.submitter) : null" :started-at="detail.document.submitted_at" />
            </div>
            <NuxtLink :to="`/documents/${detail.document.id}`" class="btn btn-ghost btn-sm mt-4">Open full page <FIcon name="arrow-right" :size="14" /></NuxtLink>
          </div>
          <div class="card card-pad">
            <h3 class="mb-5 text-lg">Timeline</h3>
            <DocumentTimeline :events="detail.tracking" />
          </div>
        </div>
      </section>
    </div>
  </div>
</template>
