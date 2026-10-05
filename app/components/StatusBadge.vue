<script setup lang="ts">
import type { DocumentStatus } from '~/types'

const props = defineProps<{ status: DocumentStatus }>()
const meta = computed(() => STATUS_META[props.status] ?? { label: props.status, tone: 'neutral' as const })
</script>

<template>
  <ToneBadge :tone="meta.tone" dot>{{ meta.label }}</ToneBadge>
</template>
