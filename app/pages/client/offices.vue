<script setup lang="ts">
import type { Office } from '~/types'
import { pickCode } from '#shared/office-code'

useHead({ title: 'Offices · FlowVision' })

const routesApi = useRoutes()
const { busy, run } = useAction()
const { data, refresh, status, error } = await useAsyncData('offices-all', () => routesApi.offices(true), { lazy: true })

// Offices A–Z, each with its umbrella offices (added by the office's Department Head).
const q = ref('')
const tree = computed(() => {
  const all = data.value?.data ?? []
  const match = (o: Office) => !q.value || `${o.name} ${o.code}`.toLowerCase().includes(q.value.toLowerCase())
  return all
    .filter((o) => !o.parent_office_id)
    .map((o) => ({ office: o, umbrellas: all.filter((u) => u.parent_office_id === o.id) }))
    .filter((t) => match(t.office) || t.umbrellas.some(match))
})

const modalOpen = ref(false)
const editing = ref<Office | null>(null)
const form = reactive({ name: '', location: '', regenerate: false })

function openForm(office?: Office) {
  editing.value = office ?? null
  Object.assign(form, { name: office?.name ?? '', location: office?.location ?? '', regenerate: false })
  modalOpen.value = true
}

/**
 * The code the server will most likely give (shared/office-code.ts): made from the name, skipping
 * codes already used by this organization's offices. Only a preview — the server decides. An edit
 * keeps the current code unless "Make a new code" is ticked.
 */
const previewCode = computed(() => {
  const current = editing.value
  if (current && !form.regenerate) return current.code
  const all = data.value?.data ?? []
  const parent = current?.parent_office_id ? all.find((o) => o.id === current.parent_office_id) : null
  const prefix = parent ? `${parent.code}-` : ''
  const taken = all.filter((o) => o.id !== current?.id && (!prefix || o.code.startsWith(prefix))).map((o) => o.code.slice(prefix.length))
  const code = pickCode(form.name, taken)
  return code ? `${prefix}${code}` : null
})

async function save() {
  const body: Record<string, unknown> = { name: form.name, location: form.location }
  if (editing.value && form.regenerate) body.regenerate_code = true
  const ok = await run(
    'save',
    () => (editing.value ? routesApi.updateOffice(editing.value.id, body) : routesApi.createOffice(body)),
    editing.value ? 'Office updated' : 'Office created',
  )
  if (ok) {
    modalOpen.value = false
    refresh()
  }
}

async function toggleActive(o: Office) {
  const ok = await run(`toggle-${o.id}`, () => routesApi.updateOffice(o.id, { is_active: !o.is_active }), o.is_active ? 'Office deactivated' : 'Office reactivated')
  if (ok) refresh()
}
</script>

<template>
  <div class="fv-rise">
    <PageHeader
      eyebrow="Organization"
      title="Offices"
      description="The offices documents pass through. Each office's Department Head adds its umbrella offices (divisions or units). Office codes appear on QR labels."
    >
      <template #actions>
        <button class="btn btn-primary" @click="openForm()"><FIcon name="plus" :size="16" /> Add office</button>
      </template>
    </PageHeader>

    <div v-if="(data?.data.length ?? 0) > 6" class="relative mb-5 max-w-sm">
      <FIcon name="search" :size="16" class="absolute top-1/2 left-3.5 -translate-y-1/2 text-ink-2" />
      <input v-model="q" type="search" class="input pl-10" placeholder="Search offices by name or code" aria-label="Search offices" />
    </div>

    <PageSkeleton v-if="status === 'pending' && !data" variant="cards" :rows="6" :messages="['Loading offices…']" />
    <div v-else-if="error && !data" class="card card-pad flex flex-wrap items-center justify-between gap-3 text-sm text-danger-ink" role="alert">
      {{ apiErrorMessage(error, 'Could not load the offices') }}
      <button class="btn btn-sm btn-ghost" @click="refresh()"><FIcon name="refresh-cw" :size="14" /> Try again</button>
    </div>
    <div v-else-if="!data?.data.length" class="card">
      <EmptyState icon="grid" title="No offices yet" description="Add the offices documents pass through — for example Records, HR, Budget and the Mayor's office.">
        <button class="btn btn-primary btn-sm" @click="openForm()">Add your first office</button>
      </EmptyState>
    </div>
    <p v-else-if="!tree.length" class="text-sm text-ink-2">No office matches “{{ q }}”.</p>

    <div class="grid grid-cols-1 gap-3 sm:grid-cols-2 xl:grid-cols-3">
      <article v-for="t in tree" :key="t.office.id" class="card p-5" :class="!t.office.is_active && 'opacity-60'">
        <div class="flex items-start justify-between gap-2">
          <span class="mono rounded-md bg-ink/[0.05] px-2 py-1 text-ink-body">{{ t.office.code }}</span>
          <div class="flex flex-wrap justify-end gap-1.5">
            <ToneBadge v-if="t.office.is_final_checkpoint" tone="success" icon="award">Last office</ToneBadge>
            <ToneBadge v-if="!t.office.is_active" tone="neutral">Inactive</ToneBadge>
          </div>
        </div>
        <p class="mt-3 font-display text-[15px] leading-snug font-semibold">{{ t.office.name }}</p>
        <p class="mt-1 flex items-center gap-1.5 text-xs text-ink-2"><FIcon name="map-pin" :size="12" /> {{ t.office.location || 'No location set' }}</p>

        <ul v-if="t.umbrellas.length" class="mt-3 space-y-1.5 border-t border-line/60 pt-3" :aria-label="`Umbrella offices of ${t.office.name}`">
          <li v-for="u in t.umbrellas" :key="u.id" class="flex items-center gap-2 text-[13px]" :class="!u.is_active && 'opacity-60'">
            <FIcon name="corner-down-right" :size="13" class="shrink-0 text-ink-3" />
            <span class="min-w-0 flex-1 truncate">{{ u.name }}</span>
            <span class="mono shrink-0 text-xs text-ink-2">{{ u.code }}</span>
            <button class="btn btn-ghost btn-sm shrink-0 border-0 !px-2" :disabled="busy === `toggle-${u.id}`" :title="u.is_active ? 'Deactivate' : 'Reactivate'" @click="toggleActive(u)">
              <FIcon :name="u.is_active ? 'pause' : 'play'" :size="13" />
            </button>
          </li>
        </ul>

        <div class="mt-4 flex items-center justify-between border-t border-line/60 pt-3">
          <span class="text-xs text-ink-2">
            {{ t.office.member_count ?? 0 }} member{{ Number(t.office.member_count) === 1 ? '' : 's' }} · {{ t.office.messenger_count ?? 0 }} messenger{{ t.office.messenger_count === 1 ? '' : 's' }}
          </span>
          <span class="flex gap-1">
            <button class="btn btn-sm btn-ghost border-0" @click="openForm(t.office)"><FIcon name="edit-2" :size="14" /> Edit</button>
            <button class="btn btn-sm btn-ghost border-0" :disabled="busy === `toggle-${t.office.id}`" :aria-busy="busy === `toggle-${t.office.id}`" @click="toggleActive(t.office)">
              {{ t.office.is_active ? 'Deactivate' : 'Reactivate' }}
            </button>
          </span>
        </div>
      </article>
    </div>

    <AppModal :open="modalOpen" :title="editing ? 'Edit office' : 'Add office'" @close="modalOpen = false">
      <form id="office-form" class="grid grid-cols-1 gap-4" @submit.prevent="save">
        <div>
          <label class="field-label" for="o-name">Office name</label>
          <input id="o-name" v-model="form.name" class="input" required placeholder="City Health Office" />
        </div>
        <div>
          <p class="field-label">Office code</p>
          <p class="flex flex-wrap items-center gap-2">
            <span class="mono rounded-md bg-ink/[0.05] px-2 py-1 text-ink-body" aria-live="polite">{{ previewCode ?? '—' }}</span>
            <span class="text-xs text-ink-2">{{ editing && !form.regenerate ? 'Stays the same when you rename the office.' : 'Made from the name. The final code is confirmed when you save.' }}</span>
          </p>
          <label v-if="editing" class="mt-2 flex items-center gap-2 text-sm">
            <input v-model="form.regenerate" type="checkbox" class="size-4" /> Make a new code from the name
          </label>
          <p class="field-hint">
            It starts every QR code of documents uploaded here (e.g. {{ previewCode ?? 'CHO' }}-102026-123456)<template v-if="!editing?.parent_office_id"> and the codes of its umbrella offices</template>.
            <template v-if="editing && form.regenerate && !editing.parent_office_id"> A new code also changes its umbrella offices' codes; QR labels already printed keep working.</template>
          </p>
          <p v-if="!previewCode && form.name.trim()" class="field-hint text-amber-ink">Use letters or digits in the name so a code can be made.</p>
        </div>
        <div>
          <label class="field-label" for="o-loc">Address <span class="font-normal text-ink-2">(optional)</span></label>
          <input id="o-loc" v-model="form.location" class="input" placeholder="City Hall, 2nd floor" />
        </div>
      </form>
      <template #footer>
        <button class="btn btn-ghost" @click="modalOpen = false">Cancel</button>
        <button class="btn btn-primary" form="office-form" :disabled="busy === 'save' || (!editing && !previewCode)" :aria-busy="busy === 'save'">Save office</button>
      </template>
    </AppModal>
  </div>
</template>
