<script setup lang="ts">
const ui = useUiStore()
const icons = { success: 'check-circle', danger: 'alert-circle', info: 'bell' }
const tones = { success: 'text-sage-ink', danger: 'text-danger-ink', info: 'text-info-ink' }
</script>

<template>
  <div
    class="pointer-events-none fixed inset-x-0 bottom-4 z-[60] flex flex-col items-center gap-2 px-4 sm:inset-x-auto sm:right-6 sm:bottom-6 sm:items-end"
    aria-live="polite"
  >
    <TransitionGroup
      enter-active-class="transition duration-300 ease-out"
      enter-from-class="translate-y-2 opacity-0"
      leave-active-class="transition duration-200 ease-in"
      leave-to-class="opacity-0"
    >
      <div v-for="t in ui.toasts" :key="t.id" class="glass-strong pointer-events-auto flex w-full max-w-sm items-start gap-3 rounded-2xl p-4">
        <FIcon :name="icons[t.tone]" :size="18" :class="tones[t.tone]" class="mt-0.5" />
        <div class="min-w-0 flex-1">
          <p class="text-sm font-semibold">{{ t.title }}</p>
          <p v-if="t.body" class="mt-0.5 text-[13px] text-ink-body">{{ t.body }}</p>
          <NuxtLink
            v-if="t.link"
            :to="t.link"
            class="mt-1 inline-block text-[13px] font-medium text-terracotta-ink hover:underline"
            @click="ui.dismiss(t.id)"
          >
            Open
          </NuxtLink>
        </div>
        <button class="text-ink-2 hover:text-ink" aria-label="Dismiss" @click="ui.dismiss(t.id)">
          <FIcon name="x" :size="16" />
        </button>
      </div>
    </TransitionGroup>
  </div>
</template>
