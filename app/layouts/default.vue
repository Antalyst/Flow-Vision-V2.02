<script setup lang="ts">
import type { AccountType } from '~/types'

interface NavItem {
  to: string
  label: string
  icon: string
  hidden?: boolean
}
interface NavGroup {
  id: string
  /** No title: the items sit at the top, without a foldable header. */
  title: string | null
  items: NavItem[]
}

const auth = useAuthStore()
const ui = useUiStore()
const notifications = useNotificationsStore()
const route = useRoute()

/** Each role's sidebar, grouped by what the role does. */
const ROLE_NAV: Record<AccountType, NavGroup[]> = {
  CLIENT: [
    { id: 'overview', title: null, items: [{ to: '/client/dashboard', label: 'Dashboard', icon: 'home' }] },
    {
      id: 'documents',
      title: 'Documents',
      items: [
        { to: '/documents', label: 'All documents', icon: 'file-text' },
        { to: '/documents/new', label: 'Upload document', icon: 'plus-circle' },
      ],
    },
    {
      id: 'organization',
      title: 'Organization',
      items: [
        { to: '/client/routes', label: 'Document Routes', icon: 'git-commit' },
        { to: '/client/offices', label: 'Offices', icon: 'grid' },
        { to: '/client/accounts', label: 'Team accounts', icon: 'users' },
        { to: '/client/settings', label: 'Organization settings', icon: 'settings' },
      ],
    },
  ],
  EMPLOYEE: [
    { id: 'overview', title: null, items: [{ to: '/employee/dashboard', label: 'Dashboard', icon: 'home' }] },
    {
      id: 'office',
      title: 'Office work',
      items: [
        { to: '/employee/queue', label: 'Office queue', icon: 'inbox' },
        { to: '/scan', label: 'Scan to receive', icon: 'maximize' },
        { to: '/employee/liaison', label: 'Release to messenger', icon: 'truck' },
      ],
    },
    {
      id: 'documents',
      title: 'Documents',
      items: [
        { to: '/documents', label: 'Office documents', icon: 'file-text' },
        { to: '/documents/new', label: 'Upload document', icon: 'plus-circle' },
      ],
    },
    { id: 'team', title: 'Team', items: [{ to: '/employee/team', label: 'Staff & messengers', icon: 'users' }] },
  ],
  STAFF: [
    { id: 'overview', title: null, items: [{ to: '/staff/dashboard', label: 'Dashboard', icon: 'home' }] },
    {
      id: 'review',
      title: 'Review',
      items: [
        { to: '/staff/approval', label: 'Approvals', icon: 'check-square', hidden: !auth.user?.has_approval_authority },
        { to: '/staff/view', label: 'Document view', icon: 'eye' },
        { to: '/scan', label: 'Scan to receive', icon: 'maximize' },
      ],
    },
    {
      id: 'documents',
      title: 'Documents',
      items: [
        { to: '/documents', label: 'My uploads', icon: 'file-text' },
        { to: '/documents/new', label: 'Upload document', icon: 'plus-circle' },
      ],
    },
  ],
  LIAISON: [
    { id: 'overview', title: null, items: [{ to: '/liaison/dashboard', label: 'Pickups', icon: 'home' }] },
    {
      id: 'deliveries',
      title: 'Deliveries',
      items: [
        { to: '/scan', label: 'Scan QR', icon: 'maximize' },
        { to: '/liaison/tracking', label: 'My deliveries', icon: 'activity' },
      ],
    },
  ],
}

/** The same for every role. */
const SHARED_GROUPS: NavGroup[] = [
  {
    id: 'collaborate',
    title: 'Collaborate',
    items: [
      { to: '/messages', label: 'Messages', icon: 'message-circle' },
      { to: '/issues', label: 'Issues', icon: 'alert-octagon' },
    ],
  },
  {
    id: 'activity',
    title: 'Activity',
    items: [
      { to: '/notifications', label: 'Notifications', icon: 'bell' },
      { to: '/logs', label: 'Activity log', icon: 'list' },
    ],
  },
]

const groups = computed(() =>
  [...(auth.role ? ROLE_NAV[auth.role] : []), ...SHARED_GROUPS]
    .map((g) => ({ ...g, items: g.items.filter((i) => !i.hidden) }))
    .filter((g) => g.items.length),
)

// The most specific match wins, so /documents/new highlights "Upload document", not "Documents".
const activeTo = computed(
  () =>
    groups.value
      .flatMap((g) => g.items.map((i) => i.to))
      .filter((to) => route.path === to || route.path.startsWith(`${to}/`))
      .sort((a, b) => b.length - a.length)[0],
)
const isActive = (to: string) => to === activeTo.value

// ---------------------------------------------------------------------------
// Collapsing — both remembered in cookies, so the server renders the same layout.
// ---------------------------------------------------------------------------

/** Desktop: the whole sidebar folds down to a strip of icons. */
const collapsedCookie = useCookie<boolean>('fv_sidebar_collapsed', { default: () => false, maxAge: 60 * 60 * 24 * 365, sameSite: 'lax' })
// The mobile drawer always opens full width.
const rail = computed(() => collapsedCookie.value && !ui.sidebarOpen)
const toggleRail = () => (collapsedCookie.value = !collapsedCookie.value)

/** Each titled group folds on its own. The group holding the current page always stays open. */
const foldedCookie = useCookie<string[]>('fv_nav_folded', { default: () => [], maxAge: 60 * 60 * 24 * 365, sameSite: 'lax' })
const holdsActive = (g: NavGroup) => g.items.some((i) => isActive(i.to))
const isFolded = (g: NavGroup) => Boolean(g.title) && foldedCookie.value.includes(g.id) && !holdsActive(g)
function toggleGroup(g: NavGroup) {
  const folded = new Set(foldedCookie.value)
  if (folded.has(g.id)) folded.delete(g.id)
  else folded.add(g.id)
  foldedCookie.value = [...folded]
}

const unreadLabel = computed(() => (notifications.unread > 99 ? '99+' : String(notifications.unread)))

watch(() => route.fullPath, () => (ui.sidebarOpen = false))

onMounted(() => connectRealtime())
</script>

<template>
  <div class="relative min-h-dvh">
    <div class="fv-ambient" aria-hidden="true" />

    <!-- Mobile top bar -->
    <header class="glass sticky top-0 z-30 flex h-14 items-center justify-between rounded-none border-x-0 border-t-0 px-4 lg:hidden">
      <button class="grid size-10 place-items-center rounded-lg hover:bg-ink/5" aria-label="Open menu" @click="ui.sidebarOpen = true">
        <FIcon name="menu" />
      </button>
      <NuxtLink :to="auth.homePath"><BrandMark :size="28" /></NuxtLink>
      <NuxtLink to="/notifications" class="relative grid size-10 place-items-center rounded-lg hover:bg-ink/5" aria-label="Notifications">
        <FIcon name="bell" />
        <span v-if="notifications.unread" class="absolute top-1.5 right-1.5 size-2.5 rounded-full bg-terracotta ring-2 ring-cream" />
      </NuxtLink>
    </header>

    <!-- Drawer overlay (mobile) -->
    <Transition enter-active-class="transition-opacity duration-200" enter-from-class="opacity-0" leave-active-class="transition-opacity duration-150" leave-to-class="opacity-0">
      <div v-if="ui.sidebarOpen" class="fixed inset-0 z-40 bg-night/40 lg:hidden" @click="ui.sidebarOpen = false" />
    </Transition>

    <!-- Sidebar: full width, or (desktop) a strip of icons when collapsed -->
    <aside
      class="fixed inset-y-0 left-0 z-50 flex flex-col bg-night text-night-text transition-[transform,width] duration-300 ease-out lg:translate-x-0"
      :class="[ui.sidebarOpen ? 'translate-x-0' : '-translate-x-full', rail ? 'w-[76px]' : 'w-[272px]']"
      aria-label="Main navigation"
    >
      <!-- Brand + collapse -->
      <div class="flex items-center pt-5 pb-4" :class="rail ? 'flex-col gap-3 px-2' : 'justify-between px-5'">
        <NuxtLink :to="auth.homePath" :title="rail ? 'FlowVision' : undefined"><BrandMark dark :with-name="!rail" /></NuxtLink>
        <button
          class="hidden size-9 place-items-center rounded-lg text-night-text-2 hover:bg-white/5 hover:text-night-text lg:grid"
          :aria-label="rail ? 'Expand sidebar' : 'Collapse sidebar'"
          :title="rail ? 'Expand sidebar' : 'Collapse sidebar'"
          :aria-expanded="!rail"
          @click="toggleRail"
        >
          <FIcon :name="rail ? 'chevrons-right' : 'chevrons-left'" :size="18" />
        </button>
        <button class="grid size-9 place-items-center rounded-lg text-night-text-2 hover:bg-white/5 lg:hidden" aria-label="Close menu" @click="ui.sidebarOpen = false">
          <FIcon name="x" :size="18" />
        </button>
      </div>

      <!-- Organization -->
      <div v-if="!rail" class="glass-dark mx-4 mb-4 rounded-xl px-3.5 py-3">
        <p class="truncate text-[13px] font-medium">{{ auth.user?.organization?.name }}</p>
        <!-- Role and office: shown for messengers only. -->
        <p v-if="auth.role === 'LIAISON'" class="mt-0.5 flex items-center gap-1.5 truncate text-xs text-night-text-2">
          <span class="size-1.5 rounded-full" :class="auth.role ? TONE_DOT[ROLE_META[auth.role].tone] : ''" />
          {{ auth.role && ROLE_META[auth.role].label }}<template v-if="auth.user?.office"> · {{ auth.user.office.name }}</template>
        </p>
      </div>

      <nav class="flex-1 overflow-x-hidden overflow-y-auto" :class="rail ? 'px-2' : 'px-3'">
        <div v-for="(g, gi) in groups" :key="g.id" :class="gi > 0 && (rail ? 'mt-2 border-t border-white/[0.06] pt-2' : 'mt-4')">
          <!-- Group header: folds the group (hidden in the icon strip) -->
          <button
            v-if="g.title && !rail"
            type="button"
            class="flex w-full items-center gap-2 rounded-lg px-3 pb-1.5 text-left text-[10.5px] font-semibold tracking-[0.14em] text-night-text-2/80 uppercase hover:text-night-text"
            :aria-expanded="!isFolded(g)"
            :aria-controls="`nav-${g.id}`"
            @click="toggleGroup(g)"
          >
            <span class="flex-1">{{ g.title }}</span>
            <FIcon name="chevron-down" :size="14" class="transition-transform" :class="isFolded(g) && '-rotate-90'" />
          </button>

          <ul v-show="rail || !isFolded(g)" :id="`nav-${g.id}`" class="space-y-0.5">
            <li v-for="item in g.items" :key="item.to">
              <NuxtLink
                :to="item.to"
                class="relative flex min-h-11 items-center gap-3 rounded-xl text-[14px] transition-colors"
                :class="[
                  rail ? 'justify-center px-0' : 'px-3',
                  isActive(item.to) ? 'bg-white/[0.08] font-medium text-white' : 'text-night-text-2 hover:bg-white/[0.04] hover:text-night-text',
                ]"
                :title="rail ? item.label : undefined"
                :aria-label="rail ? item.label : undefined"
              >
                <FIcon :name="item.icon" :size="18" class="shrink-0" :class="isActive(item.to) && 'text-terracotta'" />
                <span v-if="!rail" class="flex-1 truncate">{{ item.label }}</span>
                <template v-if="item.to === '/notifications' && notifications.unread">
                  <span v-if="rail" class="absolute top-2 right-3 size-2 rounded-full bg-terracotta ring-2 ring-night" />
                  <span v-else class="rounded-full bg-terracotta px-2 py-0.5 text-[11px] font-semibold text-white">{{ unreadLabel }}</span>
                </template>
              </NuxtLink>
            </li>
          </ul>
        </div>
      </nav>

      <!-- Account -->
      <div class="border-t border-white/[0.06] p-3" :class="rail && 'px-2'">
        <NuxtLink to="/profile" class="flex items-center gap-3 rounded-xl p-2.5 hover:bg-white/[0.04]" :class="rail && 'justify-center px-0'" :title="rail ? `${fullName(auth.user)} · Profile` : undefined">
          <UserAvatar :user="auth.user" dark />
          <span v-if="!rail" class="min-w-0 flex-1">
            <span class="block truncate text-sm font-medium">{{ fullName(auth.user) }}</span>
            <span class="block truncate text-xs text-night-text-2">{{ auth.user?.email }}</span>
          </span>
        </NuxtLink>
        <button
          class="mt-1 flex min-h-10 w-full items-center gap-3 rounded-xl text-[13px] text-night-text-2 hover:bg-white/[0.04] hover:text-night-text"
          :class="rail ? 'justify-center' : 'px-3'"
          :title="rail ? 'Sign out' : undefined"
          :aria-label="rail ? 'Sign out' : undefined"
          @click="auth.signOut()"
        >
          <FIcon name="log-out" :size="16" /> <span v-if="!rail">Sign out</span>
        </button>
      </div>
    </aside>

    <main class="relative z-10 transition-[padding] duration-300 ease-out" :class="collapsedCookie ? 'lg:pl-[76px]' : 'lg:pl-[272px]'">
      <div class="mx-auto w-full max-w-[1200px] px-4 py-6 sm:px-8 sm:py-10">
        <NuxtLink
          v-if="auth.user?.must_change_password && route.path !== '/profile'"
          to="/profile"
          class="mb-6 flex items-center gap-3 rounded-2xl border border-amber/40 bg-amber/15 px-4 py-3 text-sm text-amber-ink"
        >
          <FIcon name="key" :size="18" />
          <span class="flex-1">You're using a temporary password. Set your own password now.</span>
          <FIcon name="arrow-right" :size="16" />
        </NuxtLink>
        <slot />
      </div>
    </main>
  </div>
</template>
