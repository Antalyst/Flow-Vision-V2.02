<script setup lang="ts">
import type { Tone } from '~/utils/format'

withDefaults(defineProps<{ tone?: Tone; dot?: boolean; icon?: string }>(), { tone: 'neutral', dot: false })
</script>

<template>
  <span class="badge" :class="TONE_CLASSES[tone]">
    <span v-if="dot" class="size-1.5 rounded-full" :class="TONE_DOT[tone]" />
    <FIcon v-if="icon" :name="icon" :size="12" :stroke="2.25" />
    <slot />
  </span>
</template>
