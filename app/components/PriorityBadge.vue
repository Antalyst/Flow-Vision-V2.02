<script setup lang="ts">
import type { Priority } from '~/types'

const props = defineProps<{ priority: Priority }>()
const meta = computed(() => PRIORITY_META[props.priority])
const icon = computed(() => (props.priority === 'URGENT' ? 'zap' : props.priority === 'HIGH' ? 'arrow-up' : undefined))
</script>

<template>
  <ToneBadge v-if="priority !== 'NORMAL'" :tone="meta.tone" :icon="icon">{{ meta.label }}</ToneBadge>
</template>
