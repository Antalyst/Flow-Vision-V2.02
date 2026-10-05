<script setup lang="ts">
// Floating ink pill shared by the landing page and the sign-in / register screens.
const links = [
  { label: 'Platform', href: '/#platform' },
  { label: 'How it works', href: '/#how' },
  { label: 'Roles', href: '/#roles' },
]
const open = ref(false)
</script>

<template>
  <header class="fixed inset-x-0 top-4 z-50 flex justify-center px-4">
    <nav class="flex w-full max-w-[620px] items-center gap-2 rounded-full bg-ink/95 p-1.5 pl-2 text-white shadow-lift backdrop-blur" aria-label="Main">
      <NuxtLink to="/" class="flex items-center gap-2 rounded-full pr-2" aria-label="FlowVision home">
        <span class="grid size-8 place-items-center overflow-hidden rounded-full bg-white">
          <img src="~/assets/logo/icon.png" alt="" class="size-7" />
        </span>
        <span class="text-[13px] font-semibold tracking-tight">FlowVision</span>
      </NuxtLink>

      <ul class="mx-auto hidden items-center gap-1 sm:flex">
        <li v-for="l in links" :key="l.href">
          <a :href="l.href" class="rounded-full px-3 py-1.5 text-[12.5px] text-white/65 transition-colors hover:text-white">{{ l.label }}</a>
        </li>
      </ul>

      <div class="ml-auto flex items-center gap-1 sm:ml-0">
        <NuxtLink to="/login" class="hidden rounded-full px-3 py-1.5 text-[12.5px] text-white/65 hover:text-white sm:block">Sign in</NuxtLink>
        <NuxtLink to="/register" class="rounded-full bg-white px-4 py-2 text-[11.5px] font-semibold tracking-[0.06em] text-ink uppercase hover:bg-white/90">
          Get started
        </NuxtLink>
        <button
          class="grid size-9 place-items-center rounded-full text-white/70 hover:text-white sm:hidden"
          :aria-expanded="open"
          aria-label="Menu"
          @click="open = !open"
        >
          <FIcon :name="open ? 'x' : 'menu'" :size="18" />
        </button>
      </div>
    </nav>

    <div v-if="open" class="absolute top-16 w-[calc(100%-2rem)] max-w-[620px] rounded-3xl bg-ink p-2 text-white shadow-lift sm:hidden">
      <a v-for="l in links" :key="l.href" :href="l.href" class="block rounded-2xl px-4 py-3 text-sm text-white/75 hover:bg-white/5" @click="open = false">
        {{ l.label }}
      </a>
      <NuxtLink to="/login" class="block rounded-2xl px-4 py-3 text-sm text-white/75 hover:bg-white/5" @click="open = false">Sign in</NuxtLink>
    </div>
  </header>
</template>
