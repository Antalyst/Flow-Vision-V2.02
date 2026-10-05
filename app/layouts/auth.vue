<script setup lang="ts">
const route = [
  { name: 'Records', state: 'done' },
  { name: 'HRMSO', state: 'done' },
  { name: 'Budget', state: 'current' },
  { name: 'Mayor', state: 'next' },
] as const
</script>

<template>
  <div class="min-h-dvh bg-cream">
    <SiteNav />

    <div class="mx-auto grid min-h-dvh max-w-6xl gap-8 px-4 pt-28 pb-8 sm:px-6 lg:grid-cols-[minmax(0,1.05fr)_minmax(0,1fr)] lg:gap-16 lg:pt-24">
      <!-- Brand panel: a duotone photo like the landing page hero -->
      <section class="photo photo-shade hidden flex-col rounded-[2rem] p-10 text-white lg:flex">
        <img src="/images/landing/monitors.jpg" alt="" width="1280" height="853" />
        <p v-reveal="{ scroll: false }" class="relative text-[11px] font-semibold tracking-[0.16em] text-white/55 uppercase">Bago City LGU</p>

        <div v-reveal="{ stagger: 0.12, scroll: false, delay: 0.2 }" class="relative mt-auto max-w-md">
          <h1 class="text-[40px] leading-[1.04] font-semibold tracking-[-0.04em] text-white">Every document, every office, one clear line.</h1>
          <p class="mt-4 text-[15px] leading-relaxed text-white/65">
            Route paperwork through your offices, hand it off with a scan, and know exactly who approved what, and when.
          </p>

          <div class="mt-10 rounded-3xl border border-white/10 bg-black/40 p-5 backdrop-blur-xl">
            <div class="flex items-center">
              <template v-for="(s, i) in route" :key="s.name">
                <div class="flex flex-col items-center gap-2">
                  <span
                    class="grid size-8 place-items-center rounded-full text-[11px] font-semibold"
                    :class="{
                      'bg-white text-ink': s.state === 'done',
                      'bg-terracotta text-white ring-4 ring-terracotta/25': s.state === 'current',
                      'border border-white/20 text-white/50': s.state === 'next',
                    }"
                  >
                    <FIcon v-if="s.state === 'done'" name="check" :size="13" :stroke="2.5" />
                    <FIcon v-else-if="s.state === 'next'" name="award" :size="13" />
                    <span v-else>{{ i + 1 }}</span>
                  </span>
                  <span class="text-[11px] text-white/60">{{ s.name }}</span>
                </div>
                <span v-if="i < route.length - 1" class="mx-1.5 mb-6 h-px flex-1" :class="s.state === 'done' ? 'bg-white/70' : 'bg-white/15'" />
              </template>
            </div>
          </div>
        </div>
      </section>

      <section class="flex items-center justify-center py-6">
        <div class="w-full max-w-[420px]" data-page-enter>
          <slot />
        </div>
      </section>
    </div>
  </div>
</template>
