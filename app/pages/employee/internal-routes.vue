<script setup lang="ts">
import type { InternalRoute } from '~/types'

useHead({ title: 'Internal routes · FlowVision' })

interface Unit {
  id: string
  name: string
  code: string
}

const api = useApi()
const auth = useAuthStore()
const { busy, run } = useAction()
const office = computed(() => auth.user?.office ?? null)

const { data, refresh, error, status } = await useAsyncData('internal-routes', () => api.get<{ data: InternalRoute[]; units: Unit[] }>('/internal-routes'), { lazy: true })
const routes = computed(() => data.value?.data ?? [])
const units = computed(() => data.value?.units ?? [])

// Add / edit: name, description and the ordered units.
const modalOpen = ref(false)
const editing = ref<InternalRoute | null>(null)
const form = reactive({ name: '', description: '', steps: [] as Array<{ office_id: string; action_label: string }> })

function openForm(r?: InternalRoute) {
  editing.value = r ?? null
  form.name = r?.name ?? ''
  form.description = r?.description ?? ''
  form.steps = r
    ? r.steps.map((s) => ({ office_id: s.office_id, action_label: s.action_label ?? '' }))
    : units.value.slice(0, 2).map((u) => ({ office_id: u.id, action_label: '' }))
  modalOpen.value = true
}

const unused = (keep?: string) => units.value.filter((u) => u.id === keep || !form.steps.some((s) => s.office_id === u.id))
function addStep() {
  const next = unused()[0]
  if (next) form.steps.push({ office_id: next.id, action_label: '' })
}
function move(i: number, by: -1 | 1) {
  const j = i + by
  if (j < 0 || j >= form.steps.length) return
  const [step] = form.steps.splice(i, 1)
  form.steps.splice(j, 0, step!)
}

// The same rules as the server, shown before saving.
const problems = computed(() => {
  const out: string[] = []
  if (form.steps.length < 2) out.push('Add at least two umbrella offices. To send a document to one, use “Hand to umbrella office” on the document.')
  if (new Set(form.steps.map((s) => s.office_id)).size !== form.steps.length) out.push('Each umbrella office can appear only once.')
  return out
})

async function save() {
  const body = {
    name: form.name,
    description: form.description || null,
    steps: form.steps.map((s) => ({ office_id: s.office_id, action_label: s.action_label || null })),
  }
  const ok = await run(
    'save',
    () => (editing.value ? api.patch(`/internal-routes/${editing.value.id}`, body) : api.post('/internal-routes', body)),
    editing.value ? 'Internal route updated — documents already on it keep the steps they started with' : 'Internal route added',
  )
  if (ok) {
    modalOpen.value = false
    refresh()
  }
}

async function toggleActive(r: InternalRoute) {
  const ok = await run(`toggle-${r.id}`, () => api.patch(`/internal-routes/${r.id}`, { is_active: !r.is_active }), r.is_active ? 'Internal route deactivated — documents already on it finish it' : 'Internal route reactivated')
  if (ok) refresh()
}
</script>

<template>
  <div class="fv-rise">
    <PageHeader
      eyebrow="Team"
      title="Internal routes"
      :description="`Paths through the umbrella offices of ${office?.name ?? 'your office'}. A document received here can follow one: each unit scans it in and passes it on, and it comes back to your office at the end. It stays on the same step of its Document Route the whole time; only your office releases it onward.`"
    >
      <template #actions>
        <button class="btn btn-primary" :disabled="Boolean(error) || units.length < 2" @click="openForm()"><FIcon name="plus" :size="16" /> New internal route</button>
      </template>
    </PageHeader>

    <AsyncState :status="status" :ready="Boolean(data) || Boolean(error)" :error="null" variant="cards" :rows="3" :messages="['Loading internal routes…']" @retry="refresh()">

    <p v-if="error" class="card card-pad text-sm text-danger-ink">{{ apiErrorMessage(error, 'Could not load internal routes') }}</p>

    <template v-else>
      <p v-if="units.length < 2" class="card card-pad mb-4 text-sm text-ink-body">
        An internal route needs at least two active umbrella offices.
        <NuxtLink to="/employee/umbrellas" class="text-terracotta-ink hover:underline">Add umbrella offices</NuxtLink> first.
      </p>

      <div v-if="!routes.length" class="card">
        <EmptyState icon="shuffle" title="No internal routes yet" description="Create one for a document that always goes through the same units of your office, e.g. Records → Payroll → Audit." />
      </div>

      <div v-else class="grid grid-cols-1 gap-3 lg:grid-cols-2">
        <article v-for="r in routes" :key="r.id" class="card p-5" :class="!r.is_active && 'opacity-60'">
          <div class="flex items-start justify-between gap-2">
            <p class="font-display text-[15px] leading-snug font-semibold">{{ r.name }}</p>
            <ToneBadge v-if="!r.is_active" tone="neutral">Inactive</ToneBadge>
          </div>
          <p v-if="r.description" class="mt-1 text-[13px] text-ink-body">{{ r.description }}</p>
          <ol class="mt-3 flex flex-wrap items-center gap-1.5 text-xs">
            <template v-for="(s, i) in r.steps" :key="s.step_number">
              <li class="rounded-lg bg-ink/[0.04] px-2 py-1" :class="s.office && !s.office.is_active && 'text-danger-ink line-through'">
                <span class="font-medium">{{ s.step_number }}. {{ s.office?.name ?? 'Unknown office' }}</span><template v-if="s.action_label"> · {{ s.action_label }}</template>
              </li>
              <FIcon v-if="i < r.steps.length - 1" name="chevron-right" :size="12" class="text-ink-3" aria-hidden="true" />
            </template>
          </ol>
          <p v-if="r.steps.some((s) => s.office && !s.office.is_active)" class="mt-2 text-xs text-danger-ink">A unit on this route was deactivated. Edit the route before using it again.</p>
          <div class="mt-4 flex justify-end gap-1 border-t border-line/60 pt-3">
            <button class="btn btn-sm btn-ghost border-0" @click="openForm(r)"><FIcon name="edit-2" :size="14" /> Edit</button>
            <button class="btn btn-sm btn-ghost border-0" :disabled="busy === `toggle-${r.id}`" :aria-busy="busy === `toggle-${r.id}`" @click="toggleActive(r)">
              {{ r.is_active ? 'Deactivate' : 'Reactivate' }}
            </button>
          </div>
        </article>
      </div>
    </template>

    </AsyncState>
    <AppModal :open="modalOpen" :title="editing ? 'Edit internal route' : 'New internal route'" @close="modalOpen = false">
      <form id="internal-route-form" class="grid grid-cols-1 gap-4" @submit.prevent="save">
        <div>
          <label class="field-label" for="ir-name">Name</label>
          <input id="ir-name" v-model="form.name" class="input" required maxlength="120" placeholder="Payroll check" />
        </div>
        <div>
          <label class="field-label" for="ir-desc">Description <span class="font-normal text-ink-2">(optional)</span></label>
          <input id="ir-desc" v-model="form.description" class="input" maxlength="500" placeholder="When a document needs records, payroll and audit" />
        </div>
        <fieldset>
          <legend class="field-label">Steps, in order</legend>
          <ol class="space-y-2">
            <li v-for="(s, i) in form.steps" :key="i" class="flex flex-wrap items-center gap-2 rounded-xl border border-line/70 p-2">
              <span class="grid size-7 shrink-0 place-items-center rounded-full bg-ink/[0.05] text-xs font-semibold">{{ i + 1 }}</span>
              <label class="sr-only" :for="`ir-unit-${i}`">Umbrella office for step {{ i + 1 }}</label>
              <select :id="`ir-unit-${i}`" v-model="s.office_id" class="input min-w-0 flex-1 py-1.5 text-sm" required>
                <option v-for="u in unused(s.office_id)" :key="u.id" :value="u.id">{{ u.name }} ({{ u.code }})</option>
              </select>
              <label class="sr-only" :for="`ir-action-${i}`">What happens at step {{ i + 1 }}</label>
              <input :id="`ir-action-${i}`" v-model="s.action_label" class="input min-w-0 flex-1 py-1.5 text-sm" maxlength="255" placeholder="Action (optional)" />
              <span class="flex gap-0.5">
                <button type="button" class="btn btn-sm btn-ghost border-0 px-2" :disabled="i === 0" :aria-label="`Move step ${i + 1} up`" @click="move(i, -1)"><FIcon name="arrow-up" :size="14" /></button>
                <button type="button" class="btn btn-sm btn-ghost border-0 px-2" :disabled="i === form.steps.length - 1" :aria-label="`Move step ${i + 1} down`" @click="move(i, 1)"><FIcon name="arrow-down" :size="14" /></button>
                <button type="button" class="btn btn-sm btn-ghost border-0 px-2" :aria-label="`Remove step ${i + 1}`" @click="form.steps.splice(i, 1)"><FIcon name="x" :size="14" /></button>
              </span>
            </li>
          </ol>
          <button type="button" class="btn btn-sm btn-ghost mt-2" :disabled="!unused().length" @click="addStep"><FIcon name="plus" :size="14" /> Add step</button>
          <p class="field-hint">After the last step the document comes back to {{ office?.name ?? 'your office' }}. Documents already on this route keep the steps they started with.</p>
        </fieldset>
        <ul v-if="problems.length" class="space-y-1 text-sm text-danger-ink">
          <li v-for="p in problems" :key="p">{{ p }}</li>
        </ul>
      </form>
      <template #footer>
        <button class="btn btn-ghost" @click="modalOpen = false">Cancel</button>
        <button class="btn btn-primary" form="internal-route-form" :disabled="busy === 'save' || problems.length > 0" :aria-busy="busy === 'save'">Save</button>
      </template>
    </AppModal>
  </div>
</template>
