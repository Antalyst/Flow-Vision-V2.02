<script setup lang="ts">
withDefaults(defineProps<{ size?: number; dark?: boolean; withName?: boolean }>(), { size: 32, dark: false, withName: true })
</script>

<template>
  <span class="inline-flex items-center gap-2.5">
    <div class="w-12">
      <img src="~/assets/logo/icon.png" alt="">
    </div>
    <span v-if="withName" class="font-display text-[17px] font-semibold tracking-tight" :class="dark ? 'text-night-text' : 'text-ink'">FlowVision</span>
  </span>
</template>
