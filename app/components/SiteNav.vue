<script setup lang="ts">
import { gsap } from 'gsap'

// Floating ink pill shared by the landing page and the sign-in / register screens.
// Three equal columns keep the section links centred whatever the brand and actions measure.
const links = [
  { label: 'Platform', href: '/#platform' },
  { label: 'How it works', href: '/#how' },
  { label: 'Roles', href: '/#roles' },
]
const route = useRoute()
const open = ref(false)
const bar = ref<HTMLElement | null>(null)
const menu = ref<HTMLElement | null>(null)

watch(() => route.fullPath, () => (open.value = false))

// Mobile menu: drops in with GSAP
watch(open, async (v) => {
  if (!v) return
  await nextTick()
  if (menu.value) gsap.from(menu.value.children, { opacity: 0, y: -8, duration: 0.35, ease: 'power2.out', stagger: 0.04 })
})

let lastY = 0
let hidden = false
function onScroll() {
  const y = window.scrollY
  const hide = y > lastY && y > 160 && !open.value
  if (hide !== hidden && bar.value) {
    hidden = hide
    gsap.to(bar.value, { yPercent: hide ? -160 : 0, duration: 0.45, ease: 'power3.out' })
  }
  lastY = y
}

onMounted(() => {
  if (!window.matchMedia('(prefers-reduced-motion: reduce)').matches && bar.value) {
    gsap.from(bar.value, { yPercent: -160, duration: 0.9, ease: 'expo.out', delay: 0.1 })
  }
  window.addEventListener('scroll', onScroll, { passive: true })
})
onBeforeUnmount(() => window.removeEventListener('scroll', onScroll))

const linkClass = 'h-9 items-center rounded-full px-3.5 text-[13px] leading-none whitespace-nowrap transition-colors'
</script>

<template>
  <header ref="bar" class="fixed inset-x-0 top-4 z-50 px-4">
    <nav
      class="mx-auto grid h-12 w-full max-w-[680px] grid-cols-[1fr_auto] items-center rounded-full bg-ink/95 px-1.5 text-white shadow-lift backdrop-blur sm:grid-cols-[1fr_auto_1fr]"
      aria-label="Main"
    >
      <NuxtLink to="/" class="inline-flex h-9 items-center gap-2 justify-self-start rounded-full pr-3 pl-0.5" aria-label="FlowVision home">
        <span class="grid size-8 place-items-center overflow-hidden rounded-full bg-white">
          <img src="~/assets/logo/icon.png" alt="" class="size-7" />
        </span>
        <span class="text-[13.5px] leading-none font-semibold tracking-tight">FlowVision</span>
      </NuxtLink>

      <ul class="hidden items-center sm:flex">
        <li v-for="l in links" :key="l.href">
          <a :href="l.href" :class="[linkClass, 'inline-flex text-white/65 hover:bg-white/[0.06] hover:text-white']">{{ l.label }}</a>
        </li>
      </ul>

      <div class="flex items-center gap-1 justify-self-end">
        <NuxtLink
          to="/login"
          :class="[linkClass, 'hidden sm:inline-flex', route.path === '/login' ? 'bg-white/10 text-white' : 'text-white/65 hover:bg-white/[0.06] hover:text-white']"
        >
          Sign in
        </NuxtLink>
        <NuxtLink
          to="/register"
          class="inline-flex h-9 items-center rounded-full bg-white px-4 text-[11.5px] leading-none font-semibold whitespace-nowrap tracking-[0.06em] text-ink uppercase transition-colors hover:bg-white/85"
          :class="route.path === '/register' && 'ring-2 ring-terracotta ring-offset-2 ring-offset-ink'"
        >
          Get started
        </NuxtLink>
        <button class="grid size-9 place-items-center rounded-full text-white/70 hover:text-white sm:hidden" :aria-expanded="open" aria-label="Menu" @click="open = !open">
          <FIcon :name="open ? 'x' : 'menu'" :size="18" />
        </button>
      </div>
    </nav>

    <div v-if="open" ref="menu" class="mx-auto mt-2 max-w-[680px] rounded-3xl bg-ink p-2 text-white shadow-lift sm:hidden">
      <a v-for="l in links" :key="l.href" :href="l.href" class="block rounded-2xl px-4 py-3 text-sm text-white/75 hover:bg-white/5" @click="open = false">
        {{ l.label }}
      </a>
      <NuxtLink to="/login" class="block rounded-2xl px-4 py-3 text-sm text-white/75 hover:bg-white/5">Sign in</NuxtLink>
    </div>
  </header>
</template>
