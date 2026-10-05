<script setup lang="ts">
withDefaults(defineProps<{ icon?: string; title: string; description?: string }>(), { icon: 'inbox' })
</script>

<template>
  <div class="flex flex-col items-center justify-center px-6 py-12 text-center">
    <span class="grid size-12 place-items-center rounded-2xl bg-ink/[0.04] text-ink-2">
      <FIcon :name="icon" :size="22" />
    </span>
    <p class="mt-4 font-display text-base font-semibold">{{ title }}</p>
    <p v-if="description" class="mt-1 max-w-sm text-sm text-ink-body">{{ description }}</p>
    <div v-if="$slots.default" class="mt-5"><slot /></div>
  </div>
</template>
