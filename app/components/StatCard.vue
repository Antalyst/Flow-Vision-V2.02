<script setup lang="ts">
import type { Tone } from '~/utils/format'

const props = withDefaults(defineProps<{ label: string; value: string | number | null; icon: string; tone?: Tone; hint?: string; to?: string }>(), {
  tone: 'neutral',
})
const NuxtLink = resolveComponent('NuxtLink')
const shown = useCountUp(() => props.value)
</script>

<template>
  <component
    :is="to ? NuxtLink : 'div'"
    :to="to"
    class="card card-pad block transition-transform duration-200"
    :class="to && 'hover:-translate-y-0.5'"
  >
    <div class="flex items-start justify-between gap-3">
      <p class="text-[13px] font-medium text-ink-body">{{ label }}</p>
      <span class="grid size-9 place-items-center rounded-xl" :class="TONE_CLASSES[tone]">
        <FIcon :name="icon" :size="18" />
      </span>
    </div>
    <p class="mt-3 font-display text-[32px] leading-none font-semibold tracking-tight">{{ shown ?? '—' }}</p>
    <p v-if="hint" class="mt-2 text-xs text-ink-2">{{ hint }}</p>
  </component>
</template>
