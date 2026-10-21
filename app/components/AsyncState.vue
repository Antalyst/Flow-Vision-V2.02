<script setup lang="ts">
/**
 * The loading states of a data-driven page section, the same everywhere:
 *   no data yet + loading  → a skeleton shaped like the content (PageSkeleton)
 *   no data yet + failed   → the error and a "Try again" button
 *   data                   → the content (slot); a refresh or a filter change keeps it on screen,
 *                            marked busy, instead of blanking it
 * Empty results are the content's own business (its EmptyState), so "nothing found" never looks
 * like "still loading". Pages fetch with useAsyncData({ lazy: true }), so navigating shows this at
 * once; the first server-rendered load already has its data.
 */
const props = withDefaults(
  defineProps<{
    /** useAsyncData's status. */
    status: 'idle' | 'pending' | 'success' | 'error'
    /** Whether there is data to show (e.g. Boolean(data)). */
    ready: boolean
    error?: unknown
    variant?: 'dashboard' | 'list' | 'cards' | 'detail'
    rows?: number
    messages?: string[]
    /** What failed, for the error message. */
    what?: string
  }>(),
  { variant: 'list', rows: 5, messages: () => ['Loading…'], what: 'this page', error: undefined },
)
const emit = defineEmits<{ retry: [] }>()
const showSkeleton = computed(() => !props.ready && (props.status === 'pending' || props.status === 'idle'))
</script>

<template>
  <PageSkeleton v-if="showSkeleton" :variant="variant" :rows="rows" :messages="messages" />
  <div v-else-if="!ready && error" class="card card-pad flex flex-wrap items-center justify-between gap-3 text-sm text-danger-ink" role="alert">
    <span class="flex items-center gap-2"><FIcon name="alert-circle" :size="16" /> {{ apiErrorMessage(error, `Could not load ${what}`) }}</span>
    <button class="btn btn-sm btn-ghost" @click="emit('retry')"><FIcon name="refresh-cw" :size="14" /> Try again</button>
  </div>
  <div v-else :aria-busy="status === 'pending'" class="transition-opacity" :class="status === 'pending' && 'opacity-70'">
    <slot />
  </div>
</template>
