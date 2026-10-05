<script setup lang="ts">
defineProps<{ eyebrow?: string; title: string; description?: string }>()
</script>

<template>
  <header class="mb-6 flex flex-col gap-4 sm:mb-8 sm:flex-row sm:items-end sm:justify-between">
    <div class="min-w-0">
      <p v-if="eyebrow" class="eyebrow mb-2">{{ eyebrow }}</p>
      <h1 class="text-[26px] leading-tight sm:text-[30px]">{{ title }}</h1>
      <p v-if="description" class="mt-2 max-w-2xl text-[15px] text-ink-body">{{ description }}</p>
    </div>
    <div v-if="$slots.actions" class="flex shrink-0 flex-wrap items-center gap-2">
      <slot name="actions" />
    </div>
  </header>
</template>
