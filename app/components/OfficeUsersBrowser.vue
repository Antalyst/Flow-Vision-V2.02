<script setup lang="ts">
import type { AccountType, LiaisonProfile, Office } from '~/types'

/**
 * Office cards → a modal with the users of the chosen office (team pages of the ADMIN and the
 * Department Head). The server decides which offices and users this account may see
 * (server/lib/directory.ts); this component only asks and renders. Filters (umbrella office, role,
 * search) combine and run on the server, one page at a time.
 */

export interface DirectoryMember {
  id: string
  email: string
  first_name: string
  last_name: string
  phone: string | null
  account_type: AccountType
  status: 'ACTIVE' | 'SUSPENDED'
  must_change_password: boolean
  office_id: string | null
  office: (Office & { parent?: { id: string; name: string; code: string } | null }) | null
  last_login_at: string | null
  liaisonProfile: LiaisonProfile | null
  page_access: string[] | null
  delegated: boolean
  permissions: string[] | null
  can_manage: boolean
}

interface OfficeCard {
  id: string
  name: string
  code: string
  is_active: boolean
  is_umbrella: boolean
  counts: { total: number; by_role: Record<string, number> }
  main_count: number
  umbrellas: Array<{ id: string; name: string; code: string; is_active: boolean; count: number }>
}
interface Cards {
  offices: OfficeCard[]
  unassigned: { total: number; by_role: Record<string, number> } | null
}

const emit = defineEmits<{ edit: [member: DirectoryMember] }>()
const api = useApi()

// ── Office cards ───────────────────────────────────────────────────────────────
const { data: cards, status: cardsStatus, error: cardsError, refresh: refreshCards } = useAsyncData('directory-offices', () => api.get<Cards>('/users/directory/offices'), { lazy: true })

// ── The users modal ────────────────────────────────────────────────────────────
const NO_OFFICE = 'none'
const open = ref(false)
const selected = ref<{ id: string; name: string; code: string | null; umbrellas: OfficeCard['umbrellas'] } | null>(null)
const umbrella = ref('')
const role = ref<AccountType | ''>('')
const search = ref('')
const debouncedSearch = refDebounced(search, 300)
const page = ref(1)

const rows = ref<DirectoryMember[]>([])
const meta = ref<{ total: number; page: number; pages: number } | null>(null)
const loading = ref(false)
const loadError = ref<string | null>(null)
let requestId = 0

async function load() {
  if (!selected.value) return
  const id = ++requestId
  loading.value = true
  loadError.value = null
  try {
    const res = await api.get<{ data: DirectoryMember[]; meta: { total: number; page: number; pages: number } }>('/users/directory', {
      office_id: selected.value.id,
      umbrella_id: umbrella.value || undefined,
      account_type: role.value || undefined,
      q: debouncedSearch.value.trim() || undefined,
      page: page.value,
      limit: 20,
    })
    // A slower, older request must not overwrite a newer one (fast typing, quick filter changes).
    if (id !== requestId) return
    rows.value = res.data
    meta.value = res.meta
  } catch (err) {
    if (id !== requestId) return
    loadError.value = apiErrorMessage(err, 'Could not load the accounts')
  } finally {
    if (id === requestId) loading.value = false
  }
}

function openOffice(card: { id: string; name: string; code: string | null; umbrellas: OfficeCard['umbrellas'] }, umbrellaId = '') {
  selected.value = card
  umbrella.value = umbrellaId
  role.value = ''
  search.value = ''
  page.value = 1
  rows.value = []
  meta.value = null
  open.value = true
  load()
}

// Any filter change starts again from page 1.
watch([umbrella, role, debouncedSearch], () => {
  if (!open.value) return
  page.value = 1
  load()
})
watch(page, (p, before) => {
  if (open.value && p !== before && meta.value) load()
})

const firstLoad = computed(() => loading.value && !meta.value)
const filtered = computed(() => Boolean(umbrella.value || role.value || debouncedSearch.value.trim()))
const roleOptions = computed(() => (Object.keys(ROLE_META) as AccountType[]).filter((r) => selected.value?.id === NO_OFFICE || r !== 'ADMIN'))

/** Where an account sits: its office, and the main office above it when that is an umbrella office. */
function placeOf(m: DirectoryMember) {
  if (!m.office) return 'No office'
  return m.office.parent ? `${m.office.name} · under ${m.office.parent.name}` : m.office.name
}

/** Reload after an edit made by the page (the list and the card counts may have changed). */
function refresh() {
  refreshCards()
  if (open.value) load()
}
defineExpose({ refresh })
</script>

<template>
  <div>
    <PageSkeleton v-if="cardsStatus === 'pending' && !cards" variant="cards" :rows="6" :messages="['Loading offices…']" />

    <div v-else-if="cardsError && !cards" class="card card-pad flex flex-wrap items-center justify-between gap-3 text-sm text-danger-ink" role="alert">
      {{ apiErrorMessage(cardsError, 'Could not load the offices') }}
      <button class="btn btn-sm btn-ghost" @click="refreshCards()"><FIcon name="refresh-cw" :size="14" /> Try again</button>
    </div>

    <div v-else-if="cards && !cards.offices.length && !cards.unassigned" class="card">
      <EmptyState icon="grid" title="No offices yet" description="Accounts are listed by office once offices exist." />
    </div>

    <div v-else-if="cards" class="grid grid-cols-1 gap-3 sm:grid-cols-2 xl:grid-cols-3">
      <article v-for="o in cards.offices" :key="o.id" class="card flex flex-col p-5 transition-shadow hover:shadow-lift" :class="!o.is_active && 'opacity-60'">
        <button type="button" class="text-left" :aria-label="`Show the accounts of ${o.name}`" @click="openOffice(o)">
          <span class="flex items-start justify-between gap-2">
            <span class="mono rounded-md bg-ink/[0.05] px-2 py-1 text-ink-body">{{ o.code }}</span>
            <ToneBadge v-if="!o.is_active" tone="neutral">Inactive</ToneBadge>
          </span>
          <span class="mt-3 block font-display text-[15px] leading-snug font-semibold">{{ o.name }}</span>
          <span class="mt-1 block text-xs text-ink-2">{{ o.counts.total }} account{{ o.counts.total === 1 ? '' : 's' }}<template v-if="o.umbrellas.length"> · {{ o.umbrellas.length }} umbrella office{{ o.umbrellas.length === 1 ? '' : 's' }}</template></span>
          <span class="mt-3 flex flex-wrap gap-1.5">
            <template v-for="(meta2, r) in ROLE_META" :key="r">
              <ToneBadge v-if="o.counts.by_role[r]" :tone="meta2.tone" dot>{{ o.counts.by_role[r] }} {{ meta2.label }}</ToneBadge>
            </template>
          </span>
        </button>
        <div v-if="o.umbrellas.length" class="mt-4 border-t border-line/60 pt-3">
          <p class="eyebrow mb-2">Umbrella offices</p>
          <ul class="flex flex-wrap gap-1.5">
            <li v-for="u in o.umbrellas.slice(0, 6)" :key="u.id">
              <button type="button" class="rounded-full border border-line px-2.5 py-1 text-xs hover:border-ink/30" :class="!u.is_active && 'opacity-60'" :aria-label="`Show the accounts of ${u.name}`" @click="openOffice(o, u.id)">
                {{ u.name }} <span class="text-ink-2">{{ u.count }}</span>
              </button>
            </li>
            <li v-if="o.umbrellas.length > 6">
              <button type="button" class="rounded-full px-2.5 py-1 text-xs text-terracotta-ink hover:underline" @click="openOffice(o)">+{{ o.umbrellas.length - 6 }} more</button>
            </li>
          </ul>
        </div>
      </article>

      <article v-if="cards.unassigned" class="card flex flex-col p-5">
        <button type="button" class="text-left" aria-label="Show the accounts without an office" @click="openOffice({ id: NO_OFFICE, name: 'No office', code: null, umbrellas: [] })">
          <span class="grid size-9 place-items-center rounded-xl bg-ink/[0.05] text-ink-body"><FIcon name="shield" :size="16" /></span>
          <span class="mt-3 block font-display text-[15px] leading-snug font-semibold">No office</span>
          <span class="mt-1 block text-xs text-ink-2">Administrators and other accounts not placed in an office · {{ cards.unassigned.total }}</span>
        </button>
      </article>
    </div>

    <AppModal :open="open" :title="selected ? `Accounts · ${selected.name}` : 'Accounts'" :description="selected?.code ? `Office code ${selected.code}` : undefined" width="lg" @close="open = false">
      <div class="grid grid-cols-1 gap-2 sm:grid-cols-[1fr_1fr_1.2fr]">
        <label v-if="selected?.umbrellas.length" class="block">
          <span class="field-label">Umbrella office</span>
          <select v-model="umbrella" class="input !min-h-10 !text-sm">
            <option value="">All ({{ selected.name }} and its umbrella offices)</option>
            <option value="main">{{ selected.name }} only</option>
            <option v-for="u in selected.umbrellas" :key="u.id" :value="u.id">{{ u.name }}</option>
          </select>
        </label>
        <label class="block">
          <span class="field-label">Role</span>
          <select v-model="role" class="input !min-h-10 !text-sm">
            <option value="">All roles</option>
            <option v-for="r in roleOptions" :key="r" :value="r">{{ ROLE_META[r].label }}</option>
          </select>
        </label>
        <label class="block" :class="!selected?.umbrellas.length && 'sm:col-span-2'">
          <span class="field-label">Search</span>
          <input v-model="search" type="search" class="input !min-h-10 !text-sm" placeholder="Name or email" />
        </label>
      </div>

      <div class="relative mt-4" :aria-busy="loading">
        <!-- First load: rows shaped like the list -->
        <div v-if="firstLoad" class="divide-y divide-line/60" role="status" aria-label="Loading accounts">
          <div v-for="i in 5" :key="i" class="flex items-center gap-3 py-3" aria-hidden="true">
            <div class="skeleton size-9 shrink-0 rounded-full" />
            <div class="flex-1 space-y-2">
              <div class="skeleton h-3.5" :style="{ width: `${55 - (i % 3) * 10}%` }" />
              <div class="skeleton h-3 w-1/3" />
            </div>
            <div class="skeleton hidden h-6 w-24 rounded-full sm:block" />
          </div>
        </div>

        <div v-else-if="loadError && !rows.length" class="rounded-2xl bg-danger/10 px-4 py-3 text-sm text-danger-ink" role="alert">
          {{ loadError }}
          <button class="btn btn-sm btn-ghost ml-2" @click="load()"><FIcon name="refresh-cw" :size="14" /> Try again</button>
        </div>

        <EmptyState v-else-if="!rows.length" icon="users" :title="filtered ? 'No one matches' : 'No accounts here yet'" :description="filtered ? 'Try another umbrella office, role or search.' : undefined" />

        <template v-else>
          <p v-if="loadError" class="mb-2 text-xs text-danger-ink" role="alert">{{ loadError }} <button class="underline" @click="load()">Try again</button></p>
          <ul class="divide-y divide-line/60 transition-opacity" :class="loading && 'opacity-60'">
            <li v-for="m in rows" :key="m.id" class="flex flex-col gap-2 py-3 sm:flex-row sm:items-center">
              <div class="flex min-w-0 flex-1 items-center gap-3">
                <UserAvatar :user="m" />
                <div class="min-w-0">
                  <p class="flex flex-wrap items-center gap-1.5 text-sm font-semibold">
                    {{ fullName(m) }}
                    <ToneBadge v-if="m.status === 'SUSPENDED'" tone="danger">Suspended</ToneBadge>
                    <ToneBadge v-else-if="m.must_change_password" tone="warning">Temp password</ToneBadge>
                  </p>
                  <p class="truncate text-xs text-ink-2">{{ m.email }} · {{ placeOf(m) }}</p>
                </div>
              </div>
              <div class="flex items-center gap-2 sm:justify-end">
                <ToneBadge :tone="roleMeta(m.account_type).tone" dot>{{ roleMeta(m.account_type).label }}{{ m.delegated ? ' (delegated)' : '' }}</ToneBadge>
                <button v-if="m.can_manage" class="btn btn-sm btn-ghost border-0" @click="emit('edit', m)"><FIcon name="edit-2" :size="14" /> Edit</button>
              </div>
            </li>
          </ul>
          <span v-if="loading" class="absolute top-2 right-2 spinner" aria-hidden="true" />
        </template>
      </div>

      <template #footer>
        <div class="flex w-full flex-wrap items-center justify-between gap-2">
          <span class="text-xs text-ink-2" aria-live="polite">{{ meta ? `${meta.total} account${meta.total === 1 ? '' : 's'}` : '' }}</span>
          <span v-if="meta && meta.pages > 1" class="flex items-center gap-1">
            <button class="btn btn-sm btn-ghost" :disabled="page <= 1 || loading" aria-label="Previous page" @click="page--"><FIcon name="chevron-left" :size="15" /></button>
            <span class="text-xs text-ink-2">Page {{ meta.page }} of {{ meta.pages }}</span>
            <button class="btn btn-sm btn-ghost" :disabled="page >= meta.pages || loading" aria-label="Next page" @click="page++"><FIcon name="chevron-right" :size="15" /></button>
          </span>
        </div>
      </template>
    </AppModal>
  </div>
</template>
