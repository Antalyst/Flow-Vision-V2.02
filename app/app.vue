<script setup lang="ts">
// Marks the moment the server-rendered page becomes interactive (used by E2E tests).
onMounted(() => {
  document.documentElement.dataset.hydrated = 'true'
})
</script>

<template>
  <NuxtRouteAnnouncer />
  <NuxtLayout>
    <NuxtPage />
  </NuxtLayout>
  <ToastHost />
</template>
