<script setup lang="ts">
const props = withDefaults(defineProps<{ open: boolean; title: string; description?: string; width?: 'sm' | 'md' | 'lg' }>(), {
  width: 'md',
})
const emit = defineEmits<{ close: [] }>()
const widths = { sm: 'sm:max-w-md', md: 'sm:max-w-xl', lg: 'sm:max-w-3xl' }

function onKey(e: KeyboardEvent) {
  if (e.key === 'Escape' && props.open) emit('close')
}
onMounted(() => window.addEventListener('keydown', onKey))
onBeforeUnmount(() => window.removeEventListener('keydown', onKey))
</script>

<template>
  <Teleport to="#teleports">
    <Transition :css="false" @enter="modalMotion.onEnter" @leave="modalMotion.onLeave">
      <div
        v-if="open"
        class="fixed inset-0 z-50 flex items-end justify-center sm:items-center sm:p-6"
        role="dialog"
        aria-modal="true"
        :aria-label="title"
      >
        <div data-backdrop class="absolute inset-0 bg-night/40 backdrop-blur-[2px]" @click="emit('close')" />
        <div data-panel class="glass-strong relative flex max-h-[92vh] w-full flex-col rounded-t-3xl sm:rounded-3xl" :class="widths[width]">
          <div class="flex items-start justify-between gap-4 border-b border-line/60 px-6 pt-6 pb-4">
            <div>
              <h2 class="text-lg">{{ title }}</h2>
              <p v-if="description" class="mt-1 text-sm text-ink-body">{{ description }}</p>
            </div>
            <button class="-mr-2 grid size-9 place-items-center rounded-lg text-ink-2 hover:bg-ink/5 hover:text-ink" aria-label="Close" @click="emit('close')">
              <FIcon name="x" :size="18" />
            </button>
          </div>
          <div class="overflow-y-auto px-6 py-5"><slot /></div>
          <div v-if="$slots.footer" class="flex flex-wrap justify-end gap-2 border-t border-line/60 px-6 py-4">
            <slot name="footer" />
          </div>
        </div>
      </div>
    </Transition>
  </Teleport>
</template>
