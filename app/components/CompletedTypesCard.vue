<script setup lang="ts">
/**
 * The dashboard's "Completed" card as a carousel of document types: one slide per type with how
 * many were completed and how long that type usually takes. With an office picked, the counts
 * cover the documents that office uploaded.
 */
const props = defineProps<{
  byType: Array<{ type: string; count: number; avg_minutes: number | null; target_hours: number }>
  officeName?: string | null
}>()

/** How long the type takes: from its completed documents, else the time Organization Settings allows. */
function typeHint(t: (typeof props.byType)[number]) {
  if (t.avg_minutes != null) return `Usually done in ${formatDuration(t.avg_minutes)}`
  if (t.target_hours > 0) return `None done yet · allowed ${formatSla(t.target_hours)}`
  return 'None done yet'
}

const slides = computed(() =>
  props.byType.length
    ? props.byType.map((t) => ({ key: t.type, title: t.type, count: t.count, hint: typeHint(t) }))
    : [
        {
          key: '__none',
          title: 'No document types yet',
          count: 0,
          hint: props.officeName ? `${props.officeName} hasn't uploaded anything yet` : 'Add document types in Organization Settings',
        },
      ],
)

const index = ref(0)
// New data (another office picked) starts again from the first document type.
watch(
  () => props.byType.map((t) => t.type).join('|') + props.officeName,
  () => (index.value = 0),
)
const current = computed(() => slides.value[Math.min(index.value, slides.value.length - 1)]!)
const go = (i: number) => (index.value = (i + slides.value.length) % slides.value.length)

const paused = ref(false)
let timer: ReturnType<typeof setInterval> | undefined
onMounted(() => {
  timer = setInterval(() => {
    if (!paused.value && !document.hidden && slides.value.length > 1) go(index.value + 1)
  }, 4500)
})
onBeforeUnmount(() => clearInterval(timer))
</script>

<template>
  <div class="card card-pad flex flex-col" @mouseenter="paused = true" @mouseleave="paused = false" @focusin="paused = true" @focusout="paused = false">
    <div class="flex items-start justify-between gap-3">
      <div class="min-w-0">
        <p class="text-[13px] font-medium text-ink-body">Completed</p>
        <p class="mt-0.5 truncate text-xs font-medium text-sage-ink" :title="current.title">{{ current.title }}</p>
      </div>
      <span class="grid size-9 shrink-0 place-items-center rounded-xl" :class="TONE_CLASSES.success">
        <FIcon name="check-circle" :size="18" />
      </span>
    </div>

    <Transition name="fade" mode="out-in">
      <div :key="current.key" class="mt-2" aria-live="polite">
        <p class="font-display text-[32px] leading-none font-semibold tracking-tight">{{ current.count }}</p>
        <p v-if="current.hint" class="mt-2 truncate text-xs text-ink-2" :title="current.hint">{{ current.hint }}</p>
      </div>
    </Transition>

    <div v-if="slides.length > 1" class="mt-auto flex items-center gap-1.5 pt-3">
      <button type="button" class="grid size-6 place-items-center rounded-md text-ink-2 hover:bg-ink/5" aria-label="Previous document type" @click="go(index - 1)">
        <FIcon name="chevron-left" :size="14" />
      </button>
      <div class="flex flex-1 flex-wrap justify-center gap-1">
        <button
          v-for="(s, i) in slides"
          :key="s.key"
          type="button"
          class="h-1.5 rounded-full transition-all"
          :class="i === index ? 'w-4 bg-sage' : 'w-1.5 bg-line'"
          :aria-label="`Show ${s.title}`"
          @click="go(i)"
        />
      </div>
      <button type="button" class="grid size-6 place-items-center rounded-md text-ink-2 hover:bg-ink/5" aria-label="Next document type" @click="go(index + 1)">
        <FIcon name="chevron-right" :size="14" />
      </button>
    </div>
  </div>
</template>

<style scoped>
.fade-enter-active,
.fade-leave-active {
  transition:
    opacity 0.2s ease,
    transform 0.2s ease;
}
.fade-enter-from {
  opacity: 0;
  transform: translateY(4px);
}
.fade-leave-to {
  opacity: 0;
  transform: translateY(-4px);
}
</style>
