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

const { data, refresh, status, error } = await useAsyncData('staff-dashboard', () => api.get<StaffDashboard>('/dashboard'), { lazy: true })
const { data: pending, refresh: refreshPending } = await useAsyncData('staff-dashboard-pending', () =>
  auth.user?.has_approval_authority ? api.get<{ data: Approval[] }>('/approvals') : Promise.resolve({ data: [] as Approval[] }),
  { lazy: true },
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
    <PageHeader eyebrow="C1 · Staff" :title="auth.user?.office?.name ?? 'Your office'" :description="auth.user?.office?.parent ? `Under ${auth.user.office.parent.name}` : auth.user?.office?.code" />

    <AsyncState :status="status" :ready="Boolean(data)" :error="error" variant="dashboard" what="your dashboard" :messages="['Loading your office…']" @retry="refresh()">

    <AuthorityBanner :authority="Boolean(data?.has_approval_authority)" :office-name="auth.user?.office?.name" class="mb-6" />

    <template v-if="data?.has_approval_authority && data.approvals">
      <section class="grid grid-cols-1 gap-3 sm:grid-cols-3 sm:gap-4">
        <StatCard label="Pending approval" :value="data.approvals.pending" icon="clock" :tone="data.approvals.pending ? 'warning' : 'neutral'" to="/staff/approval" />
        <StatCard label="Approved · last 7 days" :value="data.approvals.approved_7d" icon="check-circle" tone="success" />
        <StatCard label="Returned · last 7 days" :value="data.approvals.returned_7d" icon="corner-up-left" tone="danger" />
      </section>

      <section class="mt-6">
        <div class="mb-4 flex items-center justify-between">
          <h2 class="text-lg">Next for approval</h2>
          <NuxtLink to="/staff/approval" class="text-sm font-medium text-terracotta-ink hover:underline">Open approvals</NuxtLink>
        </div>
        <div v-if="!pending?.data.length" class="card">
          <EmptyState icon="check-square" title="No pending approvals" description="Documents appear here after your office confirms receipt at the last office." />
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
        <StatCard label="To receive" :value="data.counts.awaiting_receipt" icon="inbox" tone="warning" />
        <StatCard label="In progress" :value="data.counts.in_process" icon="edit-3" tone="primary" />
        <StatCard label="Received today" :value="data.counts.received_today" icon="check" tone="success" />
      </section>
      <section class="mt-6">
        <div class="mb-4 flex items-center justify-between">
          <h2 class="text-lg">At your office</h2>
          <NuxtLink to="/staff/view" class="text-sm font-medium text-terracotta-ink hover:underline">Search documents</NuxtLink>
        </div>
        <div v-if="!data.documents.length" class="card">
          <EmptyState icon="eye" title="No documents at your office" description="Use Document view to see the timeline of any document in any office." />
        </div>
        <div v-else class="grid grid-cols-1 gap-3 lg:grid-cols-2">
          <DocumentCard v-for="d in data.documents" :key="d.id" :doc="d" show-submitter />
        </div>
      </section>
    </template>
    </AsyncState>
  </div>
</template>
