<script setup lang="ts">
// Read-only for staff, editable for staff the Department Head made responsible (server/lib/internal-routes.ts).
useHead({ title: 'Internal routes · FlowVision' })
</script>

<template>
  <InternalRoutesManager />
</template>
