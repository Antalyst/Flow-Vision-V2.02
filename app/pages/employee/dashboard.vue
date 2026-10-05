<script setup lang="ts">
import type { FlowDocument, Office } from '~/types'

useHead({ title: 'Dashboard · FlowVision' })

interface OfficeDashboard {
  office: Office | null
  counts: { awaiting_receipt: number; in_process: number; awaiting_pickup: number; outbound: number; incoming: number; received_today: number }
  documents: FlowDocument[]
  /** Recent documents uploaded by this office's staff. */
  staff_uploads?: FlowDocument[]
}

const api = useApi()
const auth = useAuthStore()

const { data, refresh } = await useAsyncData('employee-dashboard', () => api.get<OfficeDashboard>('/dashboard'))
useLiveRefresh(refresh)

const pickupDoc = ref<FlowDocument | null>(null)
</script>

<template>
  <div class="fv-rise">
    <PageHeader :eyebrow="auth.user?.office?.department_name" :title="auth.user?.office?.name ?? 'Your office'" description="Documents assigned to your office and what each one needs next.">
      <template #actions>
        <NuxtLink to="/employee/queue" class="btn btn-ghost"><FIcon name="inbox" :size="16" /> Open queue</NuxtLink>
        <NuxtLink to="/scan" class="btn btn-primary"><FIcon name="maximize" :size="16" /> Scan to receive</NuxtLink>
      </template>
    </PageHeader>

    <div v-if="!data?.office" class="card">
      <EmptyState icon="alert-circle" title="No office assigned" description="Ask your organization's Client administrator to assign you to an office." />
    </div>

    <template v-else>
      <section class="grid grid-cols-2 gap-3 sm:gap-4 lg:grid-cols-4">
        <StatCard label="Incoming" :value="data.counts.incoming" icon="navigation" tone="info" hint="On the way to you" to="/employee/queue?tab=incoming" />
        <StatCard label="Awaiting receipt" :value="data.counts.awaiting_receipt" icon="inbox" :tone="data.counts.awaiting_receipt ? 'warning' : 'neutral'" to="/employee/queue?tab=arrived" />
        <StatCard label="In process" :value="data.counts.in_process" icon="edit-3" tone="primary" hint="Received, ready to release" to="/employee/queue?tab=process" />
        <StatCard label="Awaiting pickup" :value="data.counts.awaiting_pickup" icon="package" tone="neutral" :hint="`${data.counts.received_today} received today`" to="/employee/queue?tab=pickup" />
      </section>

      <section class="mt-6">
        <h2 class="mb-4 text-lg">At your office now</h2>
        <div v-if="!data.documents.length" class="card">
          <EmptyState icon="check-circle" title="Desk is clear" description="Nothing is waiting at your office. New arrivals appear here instantly." />
        </div>
        <div v-else class="grid grid-cols-1 gap-3 lg:grid-cols-2">
          <DocumentCard v-for="d in data.documents" :key="d.id" :doc="d" show-submitter>
            <template #actions>
              <NuxtLink v-if="!d.received_at" to="/scan" class="btn btn-sm btn-primary"><FIcon name="maximize" :size="14" /> Scan to receive</NuxtLink>
              <button v-else-if="!d.pickup_requested_at && d.next_office_name" class="btn btn-sm btn-primary" @click="pickupDoc = d">
                <FIcon name="truck" :size="14" /> Release → {{ d.next_office_name }}
              </button>
              <NuxtLink v-else-if="!d.next_office_name" :to="`/documents/${d.id}#approval`" class="btn btn-sm btn-success"><FIcon name="check-square" :size="14" /> Last office — review &amp; approve</NuxtLink>
              <ToneBadge v-else tone="warning" icon="package">Waiting for {{ d.liaison ? fullName(d.liaison) : 'messenger' }}</ToneBadge>
              <NuxtLink :to="`/documents/${d.id}`" class="btn btn-sm btn-ghost ml-auto">Details</NuxtLink>
            </template>
          </DocumentCard>
        </div>
      </section>

      <section class="mt-8">
        <div class="mb-4 flex items-center justify-between gap-3">
          <h2 class="text-lg">Uploaded by your staff</h2>
          <NuxtLink to="/documents" class="btn btn-sm btn-ghost">All office documents <FIcon name="arrow-right" :size="14" /></NuxtLink>
        </div>
        <div v-if="!data.staff_uploads?.length" class="card">
          <EmptyState icon="users" title="Nothing from your staff yet" description="Documents your office staff submit appear here so you can track them." />
        </div>
        <div v-else class="grid grid-cols-1 gap-3 lg:grid-cols-2">
          <DocumentCard v-for="d in data.staff_uploads" :key="d.id" :doc="d" show-submitter />
        </div>
      </section>
    </template>

    <RequestPickupModal :open="Boolean(pickupDoc)" :doc="pickupDoc" @close="pickupDoc = null" @requested="refresh()" />
  </div>
</template>
