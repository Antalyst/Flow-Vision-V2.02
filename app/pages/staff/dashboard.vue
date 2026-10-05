<script setup lang="ts">
import type { Approval, FlowDocument, Office } from '~/types'

useHead({ title: 'Dashboard · FlowVision' })

interface StaffDashboard {
  office: Office | null
  has_approval_authority: boolean
  counts: { awaiting_receipt: number; in_process: number; awaiting_pickup: number; incoming: number; received_today: number }
  approvals?: { pending: number; approved_7d: number; returned_7d: number }
  documents: FlowDocument[]
}

const api = useApi()
const auth = useAuthStore()

const { data, refresh } = await useAsyncData('staff-dashboard', () => api.get<StaffDashboard>('/dashboard'))
const { data: pending, refresh: refreshPending } = await useAsyncData('staff-dashboard-pending', () =>
  auth.user?.has_approval_authority ? api.get<{ data: Approval[] }>('/approvals') : Promise.resolve({ data: [] as Approval[] }),
)
useLiveRefresh(() => Promise.all([refresh(), refreshPending()]))

// Server truth wins: if the route changed, refresh the cached user so nav + guard agree.
watch(
  () => data.value?.has_approval_authority,
  (authority) => {
    if (authority !== undefined && authority !== auth.user?.has_approval_authority) auth.fetchMe()
  },
)
</script>

<template>
  <div class="fv-rise">
    <PageHeader eyebrow="C1 · Staff" :title="auth.user?.office?.name ?? 'Your office'" :description="auth.user?.office?.department_name" />

    <AuthorityBanner :authority="Boolean(data?.has_approval_authority)" :office-name="auth.user?.office?.name" class="mb-6" />

    <template v-if="data?.has_approval_authority && data.approvals">
      <section class="grid grid-cols-1 gap-3 sm:grid-cols-3 sm:gap-4">
        <StatCard label="Waiting for your decision" :value="data.approvals.pending" icon="clock" :tone="data.approvals.pending ? 'warning' : 'neutral'" to="/staff/approval" />
        <StatCard label="Approved · last 7 days" :value="data.approvals.approved_7d" icon="check-circle" tone="success" />
        <StatCard label="Returned · last 7 days" :value="data.approvals.returned_7d" icon="corner-up-left" tone="danger" />
      </section>

      <section class="mt-6">
        <div class="mb-4 flex items-center justify-between">
          <h2 class="text-lg">Next up for approval</h2>
          <NuxtLink to="/staff/approval" class="text-sm font-medium text-terracotta-ink hover:underline">Open approvals</NuxtLink>
        </div>
        <div v-if="!pending?.data.length" class="card">
          <EmptyState icon="check-square" title="Nothing to approve" description="Documents appear here once your office confirms receiving them at the final checkpoint." />
        </div>
        <div v-else class="grid grid-cols-1 gap-3 lg:grid-cols-2">
          <DocumentCard v-for="a in pending.data.slice(0, 4)" :key="a.id" :doc="a.document!" show-submitter>
            <template #actions>
              <NuxtLink to="/staff/approval" class="btn btn-sm btn-success"><FIcon name="check-square" :size="14" /> Review</NuxtLink>
              <span class="ml-auto self-center text-xs text-ink-2">Requested {{ timeAgo(a.requested_at) }}</span>
            </template>
          </DocumentCard>
        </div>
      </section>
    </template>

    <template v-else-if="data">
      <section class="grid grid-cols-2 gap-3 sm:gap-4 lg:grid-cols-4">
        <StatCard label="Incoming" :value="data.counts.incoming" icon="navigation" tone="info" />
        <StatCard label="Awaiting receipt" :value="data.counts.awaiting_receipt" icon="inbox" tone="warning" />
        <StatCard label="In process" :value="data.counts.in_process" icon="edit-3" tone="primary" />
        <StatCard label="Received today" :value="data.counts.received_today" icon="check" tone="success" />
      </section>
      <section class="mt-6">
        <div class="mb-4 flex items-center justify-between">
          <h2 class="text-lg">At your office</h2>
          <NuxtLink to="/staff/view" class="text-sm font-medium text-terracotta-ink hover:underline">Look up any document</NuxtLink>
        </div>
        <div v-if="!data.documents.length" class="card">
          <EmptyState icon="eye" title="Nothing at your office" description="Use Document view to follow any document's timeline across every office." />
        </div>
        <div v-else class="grid grid-cols-1 gap-3 lg:grid-cols-2">
          <DocumentCard v-for="d in data.documents" :key="d.id" :doc="d" show-submitter />
        </div>
      </section>
    </template>
  </div>
</template>
