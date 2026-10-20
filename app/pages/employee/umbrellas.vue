<script setup lang="ts">
import type { Office, UserSummary } from '~/types'

useHead({ title: 'Umbrella offices · FlowVision' })

interface UmbrellaRow extends Office {
  head: UserSummary | null
  heads: Array<UserSummary & { delegated: boolean }>
}

const api = useApi()
const auth = useAuthStore()
const { busy, run } = useAction()
const parent = computed(() => auth.user?.office ?? null)
const prefix = computed(() => (parent.value ? `${parent.value.code}-` : ''))

const { data, refresh, error } = await useAsyncData('umbrella-offices', () => api.get<{ office: Office; data: UmbrellaRow[] }>('/offices/umbrellas'))
const umbrellas = computed(() => data.value?.data ?? [])

// Add / edit. The code is the office's code + a suffix: the suffix is all the user types.
const modalOpen = ref(false)
const editing = ref<UmbrellaRow | null>(null)
const form = reactive({ name: '', suffix: '', location: '' })

function openForm(u?: UmbrellaRow) {
  editing.value = u ?? null
  Object.assign(form, { name: u?.name ?? '', suffix: u ? u.code.slice(prefix.value.length) : '', location: u?.location ?? '' })
  modalOpen.value = true
}

async function save() {
  const suffix = form.suffix.trim().toUpperCase().replace(/\s+/g, '-').replace(/^-+/, '')
  const body = { name: form.name, code: `${prefix.value}${suffix}`, location: form.location }
  const ok = await run(
    'save',
    () => (editing.value ? api.patch(`/offices/umbrellas/${editing.value.id}`, body) : api.post('/offices/umbrellas', body)),
    editing.value ? 'Umbrella office updated' : 'Umbrella office added — assign its Department Heads in Staff & messengers',
  )
  if (ok) {
    modalOpen.value = false
    refresh()
  }
}

async function toggleActive(u: UmbrellaRow) {
  const ok = await run(`toggle-${u.id}`, () => api.patch(`/offices/umbrellas/${u.id}`, { is_active: !u.is_active }), u.is_active ? 'Umbrella office deactivated' : 'Umbrella office reactivated')
  if (ok) refresh()
}
</script>

<template>
  <div class="fv-rise">
    <PageHeader
      eyebrow="Team"
      title="Umbrella offices"
      :description="`Divisions and units under ${parent?.name ?? 'your office'}. Each has its own code and its own Department Heads, staff and messengers. Your office hands documents to them, or sends documents through several of them along an internal route.`"
    >
      <template #actions>
        <button class="btn btn-primary" :disabled="Boolean(error)" @click="openForm()"><FIcon name="plus" :size="16" /> Add umbrella office</button>
      </template>
    </PageHeader>

    <p v-if="error" class="card card-pad text-sm text-danger-ink">{{ apiErrorMessage(error, 'Could not load umbrella offices') }}</p>

    <div v-else-if="!umbrellas.length" class="card">
      <EmptyState icon="git-branch" title="No umbrella offices yet" :description="`Add the divisions or units of ${parent?.name ?? 'your office'} that process documents, e.g. a Sanitation unit with the code ${prefix}SNTR.`">
        <button class="btn btn-primary btn-sm" @click="openForm()">Add the first one</button>
      </EmptyState>
    </div>

    <div v-else class="grid grid-cols-1 gap-3 sm:grid-cols-2 xl:grid-cols-3">
      <article v-for="u in umbrellas" :key="u.id" class="card p-5" :class="!u.is_active && 'opacity-60'">
        <div class="flex items-start justify-between gap-2">
          <span class="mono rounded-md bg-ink/[0.05] px-2 py-1 text-ink-body">{{ u.code }}</span>
          <ToneBadge v-if="!u.is_active" tone="neutral">Inactive</ToneBadge>
        </div>
        <p class="mt-3 font-display text-[15px] leading-snug font-semibold">{{ u.name }}</p>
        <p class="mt-1 flex items-center gap-1.5 text-xs text-ink-2"><FIcon name="map-pin" :size="12" /> {{ u.location || 'No location set' }}</p>
        <p class="mt-3 text-[13px]">
          <template v-if="u.heads?.length"><span class="text-ink-2">Department Head{{ u.heads.length === 1 ? '' : 's' }}:</span> {{ u.heads.map((h) => fullName(h)).join(', ') }}</template>
          <NuxtLink v-else to="/employee/team" class="text-terracotta-ink hover:underline">No Department Head yet — assign one in Staff &amp; messengers</NuxtLink>
        </p>
        <div class="mt-4 flex items-center justify-between border-t border-line/60 pt-3">
          <span class="text-xs text-ink-2">{{ u.member_count ?? 0 }} member{{ Number(u.member_count) === 1 ? '' : 's' }}</span>
          <span class="flex gap-1">
            <button class="btn btn-sm btn-ghost border-0" @click="openForm(u)"><FIcon name="edit-2" :size="14" /> Edit</button>
            <button class="btn btn-sm btn-ghost border-0" :disabled="busy === `toggle-${u.id}`" :aria-busy="busy === `toggle-${u.id}`" @click="toggleActive(u)">
              {{ u.is_active ? 'Deactivate' : 'Reactivate' }}
            </button>
          </span>
        </div>
      </article>
    </div>

    <AppModal :open="modalOpen" :title="editing ? 'Edit umbrella office' : 'Add umbrella office'" @close="modalOpen = false">
      <form id="umbrella-form" class="grid grid-cols-1 gap-4" @submit.prevent="save">
        <div>
          <label class="field-label" for="u-name">Name</label>
          <input id="u-name" v-model="form.name" class="input" required maxlength="255" placeholder="Sanitation Division" />
        </div>
        <div>
          <label class="field-label" for="u-code">Code</label>
          <div class="flex items-stretch">
            <span class="mono grid place-items-center rounded-l-xl border border-r-0 border-line bg-ink/[0.04] px-3 text-sm text-ink-body">{{ prefix }}</span>
            <input id="u-code" v-model="form.suffix" class="input rounded-l-none font-mono uppercase" required maxlength="40" pattern="[A-Za-z0-9]+(-[A-Za-z0-9]+)*" placeholder="SNTR" />
          </div>
          <p class="field-hint">Documents uploaded here get QR codes like {{ prefix }}{{ form.suffix.toUpperCase() || 'SNTR' }}-102026-123456.</p>
        </div>
        <div>
          <label class="field-label" for="u-loc">Address <span class="font-normal text-ink-2">(optional)</span></label>
          <input id="u-loc" v-model="form.location" class="input" placeholder="Health Center, Room 3" />
        </div>
      </form>
      <template #footer>
        <button class="btn btn-ghost" @click="modalOpen = false">Cancel</button>
        <button class="btn btn-primary" form="umbrella-form" :disabled="busy === 'save'" :aria-busy="busy === 'save'">Save</button>
      </template>
    </AppModal>
  </div>
</template>
