<script setup lang="ts">
/**
 * A time shown relative to now ("just now", "5m ago", then the date), from the stored timestamp.
 * The server and the first client render show the same fixed text (date and time, Philippine time),
 * so hydration matches; after mounting it switches to the relative form and keeps it current.
 */
const props = defineProps<{ value: string | null | undefined }>()
const now = useNow()
const text = computed(() => (props.value ? (now.value ? timeAgo(props.value, now.value) : formatDateTime(props.value)) : ''))
</script>

<template>
  <time v-if="value" :datetime="value" :title="formatDateTime(value)">{{ text }}</time>
</template>
