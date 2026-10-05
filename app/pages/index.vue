<script setup lang="ts">
import { gsap } from 'gsap'
import { ScrollTrigger } from 'gsap/ScrollTrigger'

// Public landing page. Signed-in users never see it: the global middleware sends them to their portal.
definePageMeta({ layout: false })
useHead({ title: 'FlowVision · Every document, in focus' })

const IMG = '/images/landing'

const offices = ['Records Section', 'HRMSO', 'City Budget Office', 'City Accounting', 'Office of the City Mayor']

const heroWords = ['Bring', 'every', 'document', 'into', 'focus']
const statement =
  'As paperwork moves between offices, the need for a single source of truth has never been more critical. FlowVision puts every hand-off on one timeline.'.split(' ')

const route = [
  { name: 'Records', state: 'done' },
  { name: 'HRMSO', state: 'done' },
  { name: 'Budget', state: 'current' },
  { name: 'Mayor', state: 'next' },
] as const

const foundation = [
  {
    title: 'Document Routes',
    body: 'Design the path each document takes through your offices. Edit a route any time; documents in flight finish on the steps they started with.',
  },
  {
    title: 'QR hand-offs',
    body: 'Every document gets one QR label on upload. Messengers scan to pick up, offices scan to receive, and each scan lands on the timeline.',
  },
  {
    title: 'Final-checkpoint approval',
    body: 'Only the last office on the route can approve or return a document, and the server enforces it. Returns carry remarks so the uploader can resubmit.',
  },
]
const activeFoundation = ref(0)

const tracking = [
  { title: 'Live timeline', body: 'Who received it, who carried it and when, on one shared record.' },
  { title: 'Realtime notifications', body: 'The next office knows a document is incoming before it arrives.' },
  { title: 'Messenger assignment', body: 'Only free messengers can be chosen, so nothing waits in a busy pair of hands.' },
  { title: 'AI document typing', body: 'Uploads are classified against your own document types and knowledge files.' },
]
const activeTracking = ref(0)

const roles = {
  Client: [
    { title: 'Document Routes', body: 'Set the offices each document type moves through.', img: 'skyline' },
    { title: 'Team accounts', body: 'Invite employees, staff and messengers to your organization.', img: 'laptop-window' },
    { title: 'Organization settings', body: 'Document types and AI knowledge files in one place.', img: 'monitors' },
    { title: 'Live overview', body: 'Every document across every office, as it moves.', img: 'building-night' },
  ],
  Employee: [
    { title: 'Office queue', body: 'Documents waiting at your office, oldest first.', img: 'work-papers' },
    { title: 'Scan to receive', body: 'Camera or typed code; your name goes on the timeline.', img: 'phone-scan' },
    { title: 'Release & assign', body: 'Hand the document to a free messenger for the next office.', img: 'post-boxes' },
    { title: 'Upload & route', body: 'Submit a document and pick the route it follows.', img: 'typing' },
  ],
  Staff: [
    { title: 'Approvals', body: 'Approve or return documents at the final checkpoint.', img: 'signing' },
    { title: 'Return with remarks', body: 'Tell the uploader exactly what to fix before resubmitting.', img: 'writing' },
    { title: 'Read-only view', body: 'Follow documents in your office without approval authority.', img: 'macbook-dark' },
    { title: 'Full history', body: 'See who handled what, and when, at a glance.', img: 'monitors' },
  ],
  Liaison: [
    { title: 'Pickups', body: 'Documents assigned to you, with where they go next.', img: 'mailboxes' },
    { title: 'Scan to pick up', body: 'One scan marks the document picked up and in transit.', img: 'phone-hand' },
    { title: 'Tracking', body: 'What you are carrying and which office expects it.', img: 'phone-texting' },
    { title: 'Duty status', body: 'Go on or off duty once your hands are empty.', img: 'skyline' },
  ],
} as const
type Role = keyof typeof roles
const activeRole = ref<Role>('Client')
const roleNames = Object.keys(roles) as Role[]

const steps = [
  { tag: 'Step 01 · Upload', title: 'Upload once, label automatically', img: 'typing', mono: false },
  { tag: 'Step 02 · Hand-off', title: 'Scan to carry, scan to receive', img: 'phone-scan', mono: true },
  { tag: 'Step 03 · Decision', title: 'Approve or return at the final office', img: 'pen-paper', mono: false },
]

const year = new Date().getFullYear()

// ---------------------------------------------------------------------------
// Motion
// ---------------------------------------------------------------------------
const page = ref<HTMLElement | null>(null)
const loader = ref<HTMLElement | null>(null)
const roleGrid = ref<HTMLElement | null>(null)
const progress = ref(0)
const loading = ref(true)
let ctx: gsap.Context | undefined

function intro() {
  const tl = gsap.timeline({ defaults: { ease: 'power4.out' } })
  tl.from('[data-hero-word]', { yPercent: 110, duration: 1.1, stagger: 0.07 })
    .from('[data-hero-fade]', { opacity: 0, y: 20, duration: 0.9, stagger: 0.1 }, '-=0.7')
    .fromTo('[data-hero-media]', { clipPath: 'inset(12% 8% 0% 8% round 2rem)' }, { clipPath: 'inset(0% 0% 0% 0% round 2rem)', duration: 1.4, ease: 'expo.out' }, '-=0.8')
    .from('[data-hero-media] img', { scale: 1.25, duration: 1.8, ease: 'expo.out' }, '<')
    .from('[data-hero-card]', { opacity: 0, y: 40, scale: 0.96, duration: 1 }, '-=1.2')
    .from('[data-hero-chip]', { opacity: 0, x: -24, duration: 0.8 }, '-=0.6')
}

onMounted(() => {
  const reduced = window.matchMedia('(prefers-reduced-motion: reduce)').matches
  const seen = (() => {
    try {
      return sessionStorage.getItem('fv_intro') === '1'
    } catch {
      return false
    }
  })()

  ctx = gsap.context(() => {
    // Intro loader: counts up, then lifts away. Shown once per visit.
    if (reduced || seen) {
      loading.value = false
    } else {
      const counter = { v: 0 }
      gsap
        .timeline({ onComplete: () => (loading.value = false) })
        .to(counter, { v: 100, duration: 1.1, ease: 'power2.inOut', onUpdate: () => (progress.value = Math.round(counter.v)) })
        .to('[data-loader-mark]', { scale: 0.8, opacity: 0, duration: 0.35, ease: 'power2.in' })
        .to(loader.value, { yPercent: -100, duration: 0.8, ease: 'expo.inOut' }, '-=0.1')
        .add(() => ctx?.add(intro), '-=0.45')
      try {
        sessionStorage.setItem('fv_intro', '1')
      } catch {}
    }
    if (reduced) return
    if (seen) intro()

    // Hero photo drifts slower than the page
    gsap.to('[data-hero-media] img', {
      yPercent: 12,
      ease: 'none',
      scrollTrigger: { trigger: '[data-hero-media]', start: 'top top', end: 'bottom top', scrub: true },
    })

    // Collage: each tile floats at its own speed around the heading
    gsap.utils.toArray<HTMLElement>('[data-float]').forEach((el) => {
      gsap.fromTo(
        el,
        { y: Number(el.dataset.float) },
        { y: -Number(el.dataset.float), ease: 'none', scrollTrigger: { trigger: el.closest('section'), start: 'top bottom', end: 'bottom top', scrub: 1 } },
      )
    })
    gsap.from('[data-collage-title]', {
      scale: 0.86,
      opacity: 0,
      duration: 1.2,
      ease: 'expo.out',
      scrollTrigger: { trigger: '[data-collage-title]', start: 'top 85%', once: true },
    })

    // Statement: words light up as you read down
    gsap.fromTo(
      '[data-word]',
      { opacity: 0.18 },
      { opacity: 1, stagger: 0.05, ease: 'none', scrollTrigger: { trigger: '[data-statement]', start: 'top 80%', end: 'bottom 45%', scrub: true } },
    )

    // Step photos: slow inner parallax
    gsap.utils.toArray<HTMLElement>('[data-parallax] img').forEach((img) => {
      gsap.fromTo(img, { yPercent: -8, scale: 1.15 }, { yPercent: 8, ease: 'none', scrollTrigger: { trigger: img.parentElement, start: 'top bottom', end: 'bottom top', scrub: true } })
    })
  }, page.value!)
})

onBeforeUnmount(() => ctx?.revert())

// Role tabs: the new set of cards deals in
watch(activeRole, async () => {
  await nextTick()
  if (!roleGrid.value || window.matchMedia('(prefers-reduced-motion: reduce)').matches) return
  gsap.fromTo(roleGrid.value.children, { opacity: 0, y: 30, scale: 0.97 }, { opacity: 1, y: 0, scale: 1, duration: 0.7, ease: 'power3.out', stagger: 0.07 })
})

function selectRole(r: Role) {
  activeRole.value = r
  if (import.meta.client) ScrollTrigger.refresh()
}
</script>

<template>
  <div ref="page" class="min-h-dvh overflow-x-clip bg-cream">
    <!-- Intro loader -->
    <div v-if="loading" ref="loader" class="fv-preloader fixed inset-0 z-[100] flex-col items-center justify-center bg-night text-white" aria-hidden="true">
      <div data-loader-mark class="flex flex-col items-center">
        <span class="grid size-16 place-items-center overflow-hidden rounded-2xl bg-white">
          <img src="~/assets/logo/icon.png" alt="" class="size-14" />
        </span>
        <p class="mt-6 text-[13px] font-semibold tracking-[0.2em] text-white/60 uppercase">FlowVision</p>
        <div class="mt-5 h-px w-48 overflow-hidden bg-white/10">
          <div class="h-full bg-terracotta" :style="{ width: `${progress}%` }" />
        </div>
      </div>
      <p class="absolute right-6 bottom-6 font-mono text-[clamp(3rem,9vw,7rem)] leading-none font-semibold tracking-[-0.06em] text-white/90 tabular-nums">
        {{ progress }}<span class="text-terracotta">%</span>
      </p>
    </div>

    <SiteNav />

    <main>
      <!-- Hero -->
      <section class="mx-auto max-w-6xl px-4 pt-36 sm:px-6 sm:pt-44">
        <div class="text-center">
          <h1 class="mx-auto max-w-3xl text-[clamp(2.6rem,7vw,5rem)] leading-[1.02] font-semibold tracking-[-0.045em]">
            <span v-for="w in heroWords" :key="w" class="inline-block overflow-hidden pb-1 align-bottom">
              <span data-hero-word class="inline-block">{{ w }}</span>&nbsp;
            </span>
          </h1>
          <p data-hero-fade class="mx-auto mt-6 max-w-xl text-[16px] leading-relaxed text-ink-body">
            FlowVision routes paperwork through your city hall, hands it off with a scan, and shows everyone exactly where it is.
          </p>
          <div data-hero-fade class="mt-8 flex flex-wrap justify-center gap-3">
            <NuxtLink v-magnetic to="/register" class="btn btn-primary min-h-12 px-6">Create your organization</NuxtLink>
            <NuxtLink v-magnetic to="/login" class="btn btn-secondary min-h-12 px-6">Sign in</NuxtLink>
          </div>
        </div>

        <div data-hero-media class="photo photo-shade relative mt-16 rounded-[2rem] sm:mt-20">
          <img :src="`${IMG}/hero.jpg`" alt="An officer working late at a laptop" width="1280" height="853" fetchpriority="high" />
          <div class="relative grid min-h-[440px] place-items-center px-4 py-14 sm:min-h-[580px]">
            <!-- Product mock: a document in transit -->
            <div data-hero-card class="w-full max-w-md rounded-3xl border border-white/10 bg-black/50 p-5 text-white shadow-2xl backdrop-blur-xl sm:p-6">
              <div class="flex items-center justify-between gap-3">
                <div class="min-w-0">
                  <p class="text-[11px] tracking-[0.14em] text-white/50 uppercase">Purchase Request</p>
                  <p class="mt-1 truncate font-mono text-[13px] text-white/90">BAG-ADM-RECORDS-48213907</p>
                </div>
                <span class="inline-flex shrink-0 items-center gap-1.5 rounded-full bg-terracotta/25 px-2.5 py-1 text-[11px] font-semibold text-[#FF9A90]">
                  <span class="size-1.5 animate-pulse rounded-full bg-terracotta" /> In transit
                </span>
              </div>
              <div class="mt-6 flex items-center">
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
                      <span v-else>{{ i + 1 }}</span>
                    </span>
                    <span class="text-[11px] text-white/60">{{ s.name }}</span>
                  </div>
                  <span v-if="i < route.length - 1" class="mx-1.5 mb-6 h-px flex-1" :class="s.state === 'done' ? 'bg-white/70' : 'bg-white/15'" />
                </template>
              </div>
              <div class="mt-5 flex items-center gap-3 rounded-2xl bg-white/[0.07] px-4 py-3 text-[13px]">
                <FIcon name="truck" :size="16" class="text-white/60" />
                <span class="text-white/75">Carried by <span class="text-white">J. Dela Cruz</span> to City Budget Office</span>
              </div>
            </div>

            <div data-hero-chip class="absolute bottom-6 left-6 hidden items-center gap-3 rounded-2xl bg-white p-3 pr-5 text-ink shadow-lift sm:flex">
              <span class="grid size-9 place-items-center rounded-xl bg-terracotta text-white"><FIcon name="maximize" :size="16" /></span>
              <div>
                <p class="text-[12.5px] font-semibold">Scanned in at HRMSO</p>
                <p class="text-[11px] text-ink-2">2 minutes ago</p>
              </div>
            </div>
          </div>
        </div>
      </section>

      <!-- Offices strip -->
      <section class="mx-auto max-w-6xl px-4 py-14 sm:px-6" aria-label="Offices on FlowVision">
        <ul v-reveal="{ stagger: 0.08, y: 14 }" class="flex flex-wrap items-center justify-center gap-x-10 gap-y-4 text-[14px] font-medium text-ink-3 sm:justify-between">
          <li v-for="o in offices" :key="o">{{ o }}</li>
        </ul>
      </section>

      <!-- Intelligence collage -->
      <section class="relative mx-auto max-w-6xl px-4 py-16 sm:px-6 md:py-0">
        <div class="relative flex items-center justify-center md:h-[680px]">
          <h2 data-collage-title class="relative z-10 text-center text-[clamp(2.6rem,7vw,5.25rem)] leading-[0.95] font-semibold tracking-[-0.045em]">
            Route<br />Intelligence
          </h2>

          <div data-float="40" class="photo absolute top-6 left-[6%] hidden h-36 w-56 rounded-2xl shadow-lift md:block">
            <img :src="`${IMG}/keyboard-glow.jpg`" alt="" loading="lazy" />
          </div>
          <div data-float="70" class="photo photo-mono absolute top-12 right-[8%] hidden h-44 w-56 rounded-2xl shadow-lift md:block">
            <img :src="`${IMG}/building-night.jpg`" alt="" loading="lazy" />
            <span class="absolute right-3 bottom-3 rounded-full bg-white/15 px-2.5 py-1 text-[10.5px] text-white/90 backdrop-blur">Office of the City Mayor</span>
          </div>

          <div data-float="25" class="absolute top-[44%] left-0 hidden w-52 rounded-2xl bg-white p-4 shadow-lift md:block">
            <div class="flex items-center justify-between">
              <p class="text-[11px] font-semibold text-ink-2">On duty</p>
              <span class="relative h-5 w-9 rounded-full bg-ink"><span class="absolute top-0.5 right-0.5 size-4 rounded-full bg-white" /></span>
            </div>
            <div class="mt-3 flex items-center gap-2.5">
              <span class="grid size-8 place-items-center rounded-lg bg-terracotta text-white"><FIcon name="user" :size="14" /></span>
              <div>
                <p class="text-[12px] font-semibold">Free messenger</p>
                <p class="text-[10.5px] text-ink-2">Admin dept</p>
              </div>
            </div>
          </div>

          <div data-float="55" class="photo absolute right-[2%] bottom-[24%] hidden h-40 w-60 rounded-2xl shadow-lift md:block">
            <img :src="`${IMG}/mailboxes.jpg`" alt="" loading="lazy" />
            <span class="absolute top-3 right-3 rounded-full bg-white px-2.5 py-1 text-[10.5px] font-semibold text-ink">Incoming</span>
          </div>

          <div data-float="85" class="photo photo-mono absolute bottom-6 left-[14%] hidden h-40 w-60 rounded-2xl shadow-lift md:block">
            <img :src="`${IMG}/macbook-dark.jpg`" alt="" loading="lazy" />
            <span class="absolute bottom-3 left-3 inline-flex items-center gap-1.5 rounded-full bg-black/50 px-2.5 py-1 text-[10.5px] text-white/85 backdrop-blur">
              <span class="size-1.5 rounded-full bg-terracotta" /> In transit
            </span>
          </div>

          <div data-float="35" class="absolute right-[24%] bottom-2 hidden items-center gap-3 rounded-2xl bg-white p-3 pr-4 shadow-lift md:flex">
            <span class="grid size-9 place-items-center rounded-xl bg-sage/15 text-sage-ink"><FIcon name="check-circle" :size="16" /></span>
            <div>
              <p class="text-[12px] font-semibold">Approved</p>
              <p class="text-[10.5px] text-ink-2">Final checkpoint</p>
            </div>
          </div>
        </div>

        <!-- Phones: two photos instead of the floating collage -->
        <div class="mt-10 grid grid-cols-2 gap-3 md:hidden">
          <div class="photo aspect-[4/3] rounded-2xl"><img :src="`${IMG}/keyboard-glow.jpg`" alt="" loading="lazy" /></div>
          <div class="photo photo-mono aspect-[4/3] rounded-2xl"><img :src="`${IMG}/building-night.jpg`" alt="" loading="lazy" /></div>
        </div>
      </section>

      <!-- Statement -->
      <section class="mx-auto max-w-3xl px-4 py-24 text-center sm:px-6 sm:py-32">
        <p data-statement class="text-[clamp(1.5rem,3.2vw,2.25rem)] leading-[1.25] font-medium tracking-[-0.025em]">
          <span v-for="(w, i) in statement" :key="i" data-word class="inline-block">{{ w }}&nbsp;</span>
        </p>
      </section>

      <!-- Foundation -->
      <section id="platform" class="mx-auto grid max-w-6xl scroll-mt-24 items-center gap-10 px-4 py-16 sm:px-6 lg:grid-cols-2 lg:gap-20">
        <div v-reveal class="photo photo-mono relative grid aspect-square place-items-center rounded-[2rem] p-6 sm:p-12">
          <img :src="`${IMG}/work-papers.jpg`" alt="" loading="lazy" />
          <div class="w-full max-w-sm rounded-2xl bg-white/95 p-5 shadow-lift backdrop-blur">
            <div class="flex items-center justify-between">
              <p class="text-[13px] font-semibold">Documents</p>
              <FIcon name="more-horizontal" :size="16" class="text-ink-3" />
            </div>
            <ul class="mt-4 space-y-1">
              <li
                v-for="(d, i) in ['Purchase Request · Q4', 'Travel Order', 'Leave Application', 'Disbursement Voucher']"
                :key="d"
                class="flex items-center gap-3 rounded-xl px-2 py-2.5 text-[13px] transition-colors duration-300"
                :class="i === activeFoundation ? 'bg-cream' : ''"
              >
                <FIcon name="file-text" :size="15" :class="i === activeFoundation ? 'text-terracotta' : 'text-ink-3'" />
                <span class="flex-1 truncate">{{ d }}</span>
                <span class="size-1.5 rounded-full" :class="['bg-terracotta', 'bg-amber', 'bg-sage', 'bg-ink-3'][i]" />
              </li>
            </ul>
          </div>
        </div>

        <div v-reveal="{ delay: 0.1 }">
          <h2 class="max-w-md text-[clamp(1.75rem,3.5vw,2.5rem)] leading-[1.1] font-semibold tracking-[-0.035em]">
            The intelligent foundation for your city hall.
          </h2>
          <ul class="mt-10 space-y-2">
            <li v-for="(f, i) in foundation" :key="f.title">
              <button
                class="block w-full border-l-2 py-3 pl-5 text-left transition-colors duration-300"
                :class="i === activeFoundation ? 'border-terracotta' : 'border-line hover:border-ink-3'"
                :aria-pressed="i === activeFoundation"
                @click="activeFoundation = i"
                @mouseenter="activeFoundation = i"
              >
                <span class="block text-[15px] font-semibold" :class="i === activeFoundation ? 'text-ink' : 'text-ink-2'">{{ f.title }}</span>
                <span class="mt-1.5 block text-[14px] leading-relaxed" :class="i === activeFoundation ? 'text-ink-body' : 'text-ink-3'">{{ f.body }}</span>
              </button>
            </li>
          </ul>
        </div>
      </section>

      <!-- Tracking -->
      <section class="mx-auto grid max-w-6xl items-center gap-10 px-4 py-16 sm:px-6 lg:grid-cols-2 lg:gap-20">
        <div v-reveal>
          <h2 class="max-w-md text-[clamp(1.75rem,3.5vw,2.5rem)] leading-[1.1] font-semibold tracking-[-0.035em]">
            Know where it is in seconds.
          </h2>
          <ul class="mt-10 space-y-2">
            <li v-for="(t, i) in tracking" :key="t.title">
              <button
                class="block w-full border-l-2 py-3 pl-5 text-left transition-colors duration-300"
                :class="i === activeTracking ? 'border-terracotta' : 'border-line hover:border-ink-3'"
                :aria-pressed="i === activeTracking"
                @click="activeTracking = i"
                @mouseenter="activeTracking = i"
              >
                <span class="block text-[15px] font-semibold" :class="i === activeTracking ? 'text-ink' : 'text-ink-2'">{{ t.title }}</span>
                <span class="mt-1 block text-[14px] leading-relaxed" :class="i === activeTracking ? 'text-ink-body' : 'text-ink-3'">{{ t.body }}</span>
              </button>
            </li>
          </ul>
        </div>

        <div v-reveal="{ delay: 0.1 }" class="photo relative grid aspect-square place-items-center rounded-[2rem] p-6 sm:p-12">
          <img :src="`${IMG}/phone-hand.jpg`" alt="" loading="lazy" />
          <div class="w-full max-w-sm rounded-2xl bg-white p-5 shadow-lift">
            <div class="flex items-center gap-2 text-[11px] text-ink-2">
              <span class="grid size-6 place-items-center rounded-full border border-line"><FIcon name="clock" :size="12" /></span>
              Timeline
            </div>
            <ol class="mt-4 space-y-4 border-l border-line pl-4">
              <li class="relative">
                <span class="absolute top-1.5 -left-[21px] size-2.5 rounded-full bg-terracotta ring-4 ring-terracotta/15" />
                <p class="text-[13px] font-semibold">Picked up for City Budget Office</p>
                <p class="text-[11.5px] text-ink-2">Just now</p>
              </li>
              <li class="relative">
                <span class="absolute top-1.5 -left-[20px] size-2 rounded-full bg-ink-3" />
                <p class="text-[13px] text-ink-body">Received at HRMSO</p>
                <p class="text-[11.5px] text-ink-2">10:42 AM</p>
              </li>
              <li class="relative">
                <span class="absolute top-1.5 -left-[20px] size-2 rounded-full bg-ink-3" />
                <p class="text-[13px] text-ink-body">Uploaded, QR label printed</p>
                <p class="text-[11.5px] text-ink-2">9:15 AM</p>
              </li>
            </ol>
            <div class="mt-5 flex justify-end">
              <span class="grid size-8 place-items-center rounded-full bg-terracotta text-white"><FIcon name="arrow-up-right" :size="15" /></span>
            </div>
          </div>
        </div>
      </section>

      <!-- Roles -->
      <section id="roles" class="mx-auto max-w-6xl scroll-mt-24 px-4 py-24 sm:px-6">
        <h2 v-reveal class="text-center text-[clamp(1.75rem,3.5vw,2.5rem)] font-semibold tracking-[-0.035em]">Built for every role.</h2>
        <div v-reveal="{ delay: 0.1 }" class="mt-8 flex justify-center">
          <div class="inline-flex gap-1 rounded-full bg-[#EBE9E4] p-1" role="tablist" aria-label="Roles">
            <button
              v-for="r in roleNames"
              :key="r"
              role="tab"
              :aria-selected="activeRole === r"
              class="rounded-full px-4 py-2 text-[13px] font-medium transition-colors duration-300"
              :class="activeRole === r ? 'bg-ink text-white' : 'text-ink-2 hover:text-ink'"
              @click="selectRole(r)"
            >
              {{ r }}
            </button>
          </div>
        </div>

        <div ref="roleGrid" v-reveal="{ stagger: 0.08 }" class="mt-10 grid gap-4 sm:grid-cols-2" role="tabpanel">
          <article
            v-for="(c, i) in roles[activeRole]"
            :key="`${activeRole}-${c.title}`"
            class="photo photo-shade group flex aspect-[16/10] flex-col justify-end rounded-[1.75rem] p-6 sm:p-7"
            :class="i === 2 && 'photo-mono'"
          >
            <img :src="`${IMG}/${c.img}.jpg`" alt="" loading="lazy" class="transition-transform duration-700 ease-out group-hover:scale-105" />
            <h3 class="text-[17px] font-semibold tracking-tight text-white">{{ c.title }}</h3>
            <p class="mt-1 text-[13.5px] text-white/75">{{ c.body }}</p>
          </article>
        </div>
      </section>

      <!-- Quote -->
      <section class="mx-auto max-w-4xl px-4 py-24 text-center sm:px-6 sm:py-32">
        <blockquote v-reveal class="text-[clamp(1.5rem,3.4vw,2.4rem)] leading-[1.2] font-medium tracking-[-0.025em]">
          “FlowVision was built to free city offices from chasing paper, so every team can focus on serving people.”
        </blockquote>
        <div v-reveal="{ delay: 0.15 }" class="mt-8 inline-flex items-center gap-3 text-left">
          <span class="grid size-10 place-items-center overflow-hidden rounded-xl bg-white shadow-soft">
            <img src="~/assets/logo/icon.png" alt="" class="size-9" />
          </span>
          <span>
            <span class="block text-[13px] font-semibold">The FlowVision team</span>
            <span class="block text-[12px] text-ink-2">Bago City LGU</span>
          </span>
        </div>
      </section>

      <!-- How it works -->
      <section id="how" class="mx-auto max-w-6xl scroll-mt-24 px-4 py-16 sm:px-6">
        <div v-reveal class="flex items-end justify-between gap-4">
          <h2 class="text-[clamp(1.5rem,3vw,2rem)] font-semibold tracking-[-0.03em]">How a document moves</h2>
          <NuxtLink to="/register" class="hidden text-[13px] font-medium text-ink-2 hover:text-ink sm:block">Get started →</NuxtLink>
        </div>
        <div v-reveal="{ stagger: 0.12, y: 40 }" class="mt-8 grid gap-6 md:grid-cols-3">
          <article v-for="(s, i) in steps" :key="s.tag" class="group">
            <div data-parallax class="photo grid aspect-[4/5] place-items-center rounded-[1.75rem]" :class="s.mono && 'photo-mono'">
              <img :src="`${IMG}/${s.img}.jpg`" alt="" loading="lazy" />
              <span class="text-[5rem] leading-none font-semibold tracking-[-0.06em] text-white/90 transition-transform duration-500 group-hover:scale-110">0{{ i + 1 }}</span>
            </div>
            <p class="mt-4 text-[11.5px] text-ink-2">{{ s.tag }}</p>
            <h3 class="mt-1 text-[15px] font-semibold tracking-tight">{{ s.title }}</h3>
          </article>
        </div>
      </section>

      <!-- CTA -->
      <section class="mx-auto max-w-3xl px-4 py-28 text-center sm:px-6 sm:py-36">
        <div v-reveal="{ stagger: 0.12 }">
          <span class="mx-auto grid size-11 place-items-center overflow-hidden rounded-xl bg-white shadow-soft">
            <img src="~/assets/logo/icon.png" alt="" class="size-10" />
          </span>
          <h2 class="mt-8 text-[clamp(2.2rem,6vw,4rem)] leading-[1] font-semibold tracking-[-0.045em]">
            Experience the future of document flow
          </h2>
          <div class="mt-10 flex flex-wrap justify-center gap-3">
            <NuxtLink v-magnetic to="/register" class="btn btn-primary min-h-11 px-6 text-[12px] tracking-[0.06em] uppercase">Create organization</NuxtLink>
            <NuxtLink v-magnetic to="/login" class="btn btn-secondary min-h-11 px-6 text-[12px] tracking-[0.06em] uppercase">Sign in</NuxtLink>
          </div>
        </div>
      </section>
    </main>

    <footer class="rounded-t-[2.5rem] bg-night text-night-text">
      <div class="mx-auto grid max-w-6xl gap-12 px-4 pt-16 pb-10 sm:px-6 md:grid-cols-[1.4fr_1fr_1fr_1fr]">
        <div>
          <span class="inline-flex items-center gap-2.5">
            <span class="grid size-9 place-items-center overflow-hidden rounded-xl bg-white">
              <img src="~/assets/logo/icon.png" alt="" class="size-8" />
            </span>
            <span class="text-[15px] font-semibold">FlowVision</span>
          </span>
          <p class="mt-5 max-w-xs text-[13px] leading-relaxed text-night-text-2">
            Document tracking and workflow management for Bago City LGU.
          </p>
        </div>
        <div>
          <p class="text-[11px] font-semibold tracking-[0.14em] text-night-text-2 uppercase">Platform</p>
          <ul class="mt-4 space-y-2.5 text-[13px]">
            <li><a href="#platform" class="hover:text-white">Document Routes</a></li>
            <li><a href="#platform" class="hover:text-white">QR hand-offs</a></li>
            <li><a href="#how" class="hover:text-white">How it works</a></li>
          </ul>
        </div>
        <div>
          <p class="text-[11px] font-semibold tracking-[0.14em] text-night-text-2 uppercase">Roles</p>
          <ul class="mt-4 space-y-2.5 text-[13px]">
            <li v-for="r in roleNames" :key="r">
              <a href="#roles" class="hover:text-white" @click="selectRole(r)">{{ r }}</a>
            </li>
          </ul>
        </div>
        <div>
          <p class="text-[11px] font-semibold tracking-[0.14em] text-night-text-2 uppercase">Account</p>
          <ul class="mt-4 space-y-2.5 text-[13px]">
            <li><NuxtLink to="/login" class="hover:text-white">Sign in</NuxtLink></li>
            <li><NuxtLink to="/register" class="hover:text-white">Create organization</NuxtLink></li>
          </ul>
        </div>
      </div>
      <div class="mx-auto flex max-w-6xl flex-wrap justify-between gap-2 border-t border-white/[0.08] px-4 py-6 text-[12px] text-night-text-2 sm:px-6">
        <span>© {{ year }} FlowVision</span>
        <span>Bago City Local Government Unit</span>
      </div>
    </footer>
  </div>
</template>
