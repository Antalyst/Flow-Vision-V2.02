<script setup lang="ts">
// Marks the moment the server-rendered page becomes interactive (used by E2E tests).
onMounted(() => {
  document.documentElement.dataset.hydrated = 'true'
})
</script>

<template>
  <NuxtRouteAnnouncer />
  <NuxtLoadingIndicator color="linear-gradient(90deg, #E5322D, #FF7A45)" :height="2" :throttle="120" />
  <NuxtLayout>
    <NuxtPage />
  </NuxtLayout>
  <ToastHost />
</template>
