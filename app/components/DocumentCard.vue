<script setup lang="ts">
import type { FlowDocument } from '~/types'

const props = withDefaults(defineProps<{ doc: FlowDocument; showSubmitter?: boolean }>(), { showSubmitter: false })

const progress = computed(() => {
  const total = props.doc.total_steps ?? 0
  if (!total || !props.doc.current_step_number) return 0
  if (props.doc.status === 'COMPLETED') return 100
  return Math.round(((props.doc.current_step_number - 1) / total) * 100 + 100 / total / 2)
})
const deadline = computed(() => deadlineState(props.doc))
</script>

<template>
  <article class="card group relative p-4 transition-shadow hover:shadow-lift sm:p-5">
    <div class="flex items-start gap-4">
      <div class="min-w-0 flex-1">
        <div class="flex flex-wrap items-center gap-x-2 gap-y-1">
          <span class="mono text-ink-2">{{ doc.qr_code ?? doc.tracking_number }}</span>
          <PriorityBadge :priority="doc.priority" />
          <ToneBadge v-if="deadline" :tone="deadline.tone" icon="clock">{{ deadline.label }}</ToneBadge>
          <ToneBadge v-if="(doc.file_count ?? 0) > 1" tone="neutral" icon="layers">{{ doc.file_count }} files</ToneBadge>
        </div>
        <NuxtLink
          :to="`/documents/${doc.id}`"
          class="mt-1.5 block truncate font-display text-[16px] font-semibold tracking-tight after:absolute after:inset-0 hover:text-terracotta-ink"
        >
          {{ doc.title }}
        </NuxtLink>
        <p class="mt-1 truncate text-[13px] text-ink-body">{{ whereabouts(doc) }}</p>
      </div>
      <StatusBadge :status="doc.status" class="shrink-0" />
    </div>

    <div v-if="doc.total_steps" class="mt-4 flex items-center gap-3">
      <div class="h-1.5 flex-1 overflow-hidden rounded-full bg-line/60">
        <div
          class="h-full rounded-full transition-all"
          :class="doc.status === 'RETURNED' ? 'bg-danger' : doc.status === 'COMPLETED' ? 'bg-sage' : 'bg-terracotta'"
          :style="{ width: `${progress}%` }"
        />
      </div>
      <span class="mono shrink-0 text-ink-2">
        {{ doc.status === 'COMPLETED' ? doc.total_steps : doc.current_step_number }}/{{ doc.total_steps }}
      </span>
    </div>

    <div class="mt-3 flex flex-wrap items-center justify-between gap-2 text-xs text-ink-2">
      <span v-if="doc.route_name" class="inline-flex min-w-0 items-center gap-1.5">
        <FIcon name="git-commit" :size="13" /> <span class="truncate">{{ doc.route_name }}</span>
      </span>
      <span v-if="showSubmitter && doc.submitter" class="inline-flex items-center gap-1.5">
        <FIcon name="user" :size="13" /> {{ fullName(doc.submitter) }}
      </span>
      <span v-if="doc.liaison" class="inline-flex items-center gap-1.5">
        <FIcon name="truck" :size="13" /> {{ fullName(doc.liaison) }}
      </span>
      <span class="ml-auto">Updated {{ timeAgo(doc.updated_at) }}</span>
    </div>

    <div v-if="$slots.actions" class="relative z-10 mt-4 flex flex-wrap gap-2 border-t border-line/60 pt-4">
      <slot name="actions" />
    </div>
  </article>
</template>
