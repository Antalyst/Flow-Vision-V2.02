<script setup lang="ts">
const props = withDefaults(
  defineProps<{ user?: { first_name: string; last_name: string } | null; size?: 'sm' | 'md' | 'lg'; dark?: boolean }>(),
  { size: 'md' },
)
const sizes = { sm: 'size-7 text-[11px]', md: 'size-9 text-xs', lg: 'size-12 text-sm' }

// Deterministic warm hue per person so avatars are distinguishable without photos.
const hue = computed(() => {
  const s = `${props.user?.first_name ?? ''}${props.user?.last_name ?? ''}`
  let h = 0
  for (const ch of s) h = (h * 31 + ch.charCodeAt(0)) % 360
  return h
})
</script>

<template>
  <span
    class="grid shrink-0 place-items-center rounded-full font-semibold"
    :class="sizes[size]"
    :style="
      dark
        ? { background: `hsl(${hue} 22% 30%)`, color: '#EDEAE3' }
        : { background: `hsl(${hue} 35% 90%)`, color: `hsl(${hue} 30% 32%)` }
    "
    aria-hidden="true"
  >
    {{ initials(user) }}
  </span>
</template>
