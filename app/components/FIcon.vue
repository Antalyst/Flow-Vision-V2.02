<script setup lang="ts">
import feather from 'feather-icons'

const props = withDefaults(defineProps<{ name: string; size?: number; stroke?: number }>(), { size: 20, stroke: 1.75 })

const svg = computed(
  () =>
    feather.icons[props.name]?.toSvg({
      width: props.size,
      height: props.size,
      'stroke-width': props.stroke,
      'aria-hidden': 'true',
      focusable: 'false',
    }) ?? '',
)
</script>

<template>
  <span class="inline-flex shrink-0 items-center justify-center" v-html="svg" />
</template>
