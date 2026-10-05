<script setup lang="ts">
import { gsap } from 'gsap'

/**
 * Shimmering placeholder in the shape of the content that is loading.
 * A soft GSAP wave runs across the blocks and the caption cycles, so long loads still feel alive.
 */
const props = withDefaults(
  defineProps<{
    variant?: 'dashboard' | 'list' | 'cards' | 'detail'
    rows?: number
    /** Short phrases shown under the skeleton, one after another. */
    messages?: string[]
  }>(),
  { variant: 'list', rows: 5, messages: () => ['Loading…'] },
)

const root = ref<HTMLElement | null>(null)
const msgIndex = ref(0)
let tween: gsap.core.Tween | null = null
let timer: ReturnType<typeof setInterval> | undefined

onMounted(() => {
  if (props.messages.length > 1) timer = setInterval(() => (msgIndex.value = (msgIndex.value + 1) % props.messages.length), 1800)
  if (!root.value || window.matchMedia('(prefers-reduced-motion: reduce)').matches) return
  const blocks = root.value.querySelectorAll('.skeleton')
  gsap.from(blocks, { opacity: 0, y: 8, duration: 0.5, ease: 'power2.out', stagger: 0.03 })
  tween = gsap.to(blocks, { opacity: 0.55, duration: 0.9, ease: 'sine.inOut', yoyo: true, repeat: -1, stagger: { each: 0.06, from: 'start' }, delay: 0.5 })
})
onBeforeUnmount(() => {
  tween?.kill()
  clearInterval(timer)
})
</script>

<template>
  <div ref="root" role="status" aria-live="polite" :aria-label="messages[msgIndex]">
    <!-- Dashboard: stat tiles + a list -->
    <template v-if="variant === 'dashboard'">
      <div class="grid grid-cols-2 gap-3 sm:gap-4 xl:grid-cols-4">
        <div v-for="i in 4" :key="i" class="card card-pad">
          <div class="flex items-start justify-between">
            <div class="skeleton h-3.5 w-24" />
            <div class="skeleton size-9 rounded-xl" />
          </div>
          <div class="skeleton mt-4 h-8 w-16" />
          <div class="skeleton mt-3 h-3 w-28" />
        </div>
      </div>
      <div class="mt-6 grid gap-4 lg:grid-cols-[1.4fr_1fr]">
        <div class="card card-pad space-y-4">
          <div class="skeleton h-4 w-40" />
          <div v-for="i in rows" :key="i" class="flex items-center gap-3">
            <div class="skeleton size-10 shrink-0 rounded-xl" />
            <div class="flex-1 space-y-2">
              <div class="skeleton h-3.5" :style="{ width: `${70 - (i % 3) * 12}%` }" />
              <div class="skeleton h-3 w-1/3" />
            </div>
          </div>
        </div>
        <div class="card card-pad">
          <div class="skeleton h-4 w-32" />
          <div class="skeleton mt-5 h-44 w-full rounded-2xl" />
        </div>
      </div>
    </template>

    <!-- Cards grid -->
    <div v-else-if="variant === 'cards'" class="grid gap-4 sm:grid-cols-2 xl:grid-cols-3">
      <div v-for="i in rows" :key="i" class="card card-pad">
        <div class="flex items-center gap-3">
          <div class="skeleton size-10 rounded-xl" />
          <div class="flex-1 space-y-2">
            <div class="skeleton h-3.5 w-2/3" />
            <div class="skeleton h-3 w-1/3" />
          </div>
        </div>
        <div class="skeleton mt-5 h-3 w-full" />
        <div class="skeleton mt-2 h-3 w-4/5" />
        <div class="mt-5 flex gap-2">
          <div class="skeleton h-6 w-20 rounded-full" />
          <div class="skeleton h-6 w-16 rounded-full" />
        </div>
      </div>
    </div>

    <!-- Detail: header + body + side panel -->
    <div v-else-if="variant === 'detail'" class="grid gap-4 lg:grid-cols-[1.5fr_1fr]">
      <div class="card card-pad space-y-4">
        <div class="skeleton h-3 w-24" />
        <div class="skeleton h-7 w-3/4" />
        <div class="skeleton h-3.5 w-full" />
        <div class="skeleton h-3.5 w-5/6" />
        <div class="skeleton mt-4 h-40 w-full rounded-2xl" />
      </div>
      <div class="card card-pad space-y-4">
        <div class="skeleton h-4 w-28" />
        <div v-for="i in 4" :key="i" class="flex gap-3">
          <div class="skeleton size-3 shrink-0 rounded-full" />
          <div class="flex-1 space-y-2">
            <div class="skeleton h-3 w-2/3" />
            <div class="skeleton h-3 w-1/3" />
          </div>
        </div>
      </div>
    </div>

    <!-- List rows -->
    <div v-else class="card divide-y divide-line/70 overflow-hidden">
      <div v-for="i in rows" :key="i" class="flex items-center gap-4 px-5 py-4">
        <div class="skeleton size-10 shrink-0 rounded-xl" />
        <div class="min-w-0 flex-1 space-y-2">
          <div class="skeleton h-3.5" :style="{ width: `${62 - (i % 3) * 10}%` }" />
          <div class="skeleton h-3 w-2/5" />
        </div>
        <div class="skeleton hidden h-6 w-20 rounded-full sm:block" />
      </div>
    </div>

    <p class="mt-4 flex items-center justify-center gap-2 text-[13px] text-ink-2">
      <span class="relative flex size-2">
        <span class="absolute inline-flex size-full animate-ping rounded-full bg-terracotta/60" />
        <span class="relative inline-flex size-2 rounded-full bg-terracotta" />
      </span>
      <Transition mode="out-in" enter-active-class="transition duration-300" enter-from-class="opacity-0 translate-y-1" leave-active-class="transition duration-200" leave-to-class="opacity-0 -translate-y-1">
        <span :key="msgIndex">{{ messages[msgIndex] }}</span>
      </Transition>
    </p>
  </div>
</template>
