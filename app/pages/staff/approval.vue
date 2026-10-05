<script setup lang="ts">
import type { Approval } from '~/types'

useHead({ title: 'Approvals · FlowVision' })

const api = useApi()
const auth = useAuthStore()

const tab = ref<'PENDING' | 'APPROVED' | 'RETURNED'>('PENDING')
const { data, refresh, status } = await useAsyncData(
  'staff-approvals',
  () => api.get<{ data: Approval[]; has_approval_authority: boolean }>('/approvals', { status: tab.value }),
  { watch: [tab] },
)
useLiveRefresh(refresh)

function onDecided(id: string) {
  if (data.value) data.value.data = data.value.data.filter((a) => a.id !== id)
}
</script>

<template>
  <div class="fv-rise">
    <PageHeader eyebrow="C2 · Final checkpoint" title="Approvals" :description="`Documents that reached ${auth.user?.office?.name}. Approving completes them; returning sends them back to the submitter.`" />

    <AuthorityBanner authority :office-name="auth.user?.office?.name" class="mb-6" />

    <div class="mb-5 flex w-fit max-w-full gap-1 overflow-x-auto rounded-xl bg-ink/[0.04] p-1" role="tablist">
      <button v-for="t in ['PENDING', 'APPROVED', 'RETURNED'] as const" :key="t" role="tab" :aria-selected="tab === t" class="tab" :class="tab === t && 'tab-active'" @click="tab = t">
        {{ t === 'PENDING' ? 'Pending' : t === 'APPROVED' ? 'Approved' : 'Returned' }}
      </button>
    </div>

    <p v-if="status === 'pending' && !data" class="py-16 text-center text-sm text-ink-2">Loading…</p>
    <div v-else-if="!data?.data.length" class="card">
      <EmptyState
        :icon="tab === 'PENDING' ? 'check-square' : 'archive'"
        :title="tab === 'PENDING' ? 'All caught up' : 'Nothing here yet'"
        :description="tab === 'PENDING' ? 'New documents appear the moment your office receives them.' : undefined"
      />
    </div>

    <div v-else-if="tab === 'PENDING'" class="space-y-4">
      <ApprovalCard v-for="a in data.data" :key="a.id" :approval="a" @decided="onDecided" />
    </div>

    <ul v-else class="card divide-y divide-line/60">
      <li v-for="a in data.data" :key="a.id" class="flex flex-col gap-2 px-5 py-4 sm:flex-row sm:items-center">
        <div class="min-w-0 flex-1">
          <NuxtLink :to="`/documents/${a.document_id}`" class="block truncate text-sm font-semibold hover:text-terracotta-ink">{{ a.document?.title }}</NuxtLink>
          <p class="mt-0.5 text-xs text-ink-2">
            <span class="mono">{{ a.document?.tracking_number }}</span> · {{ fullName(a.decider) }} · {{ formatDateTime(a.decided_at) }}
          </p>
          <p v-if="a.remarks" class="mt-1 text-[13px] text-ink-body italic">“{{ a.remarks }}”</p>
        </div>
        <ToneBadge :tone="a.status === 'APPROVED' ? 'success' : 'danger'" dot>{{ a.status.toLowerCase() }}</ToneBadge>
      </li>
    </ul>
  </div>
</template>
