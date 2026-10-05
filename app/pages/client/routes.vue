<script setup lang="ts">
import type { Office, OrgRoute } from '~/types'

useHead({ title: 'Document Routes · FlowVision' })

interface DraftStep {
  key: number
  office_id: string
  action_label: string
}

const routesApi = useRoutes()
const { busy, run } = useAction()

const [{ data: routeData, refresh }, { data: officeData }] = await Promise.all([
  useAsyncData('routes-list', () => routesApi.list()),
  useAsyncData('route-offices', () => routesApi.offices()),
])

const routes = computed<OrgRoute[]>(() => routeData.value?.data ?? [])
const offices = computed<Office[]>(() => officeData.value?.data ?? [])
const officeById = computed(() => new Map(offices.value.map((o) => [o.id, o])))
const departments = computed(() => [...new Set(offices.value.map((o) => o.department_name))])

// ---------------------------------------------------------------------------
// Builder: create a new route, or edit one (`editing` = the route being edited)
// ---------------------------------------------------------------------------
let nextKey = 1
const mode = ref<'list' | 'build'>('list')
const editing = ref<OrgRoute | null>(null)
const name = ref('')
const description = ref('')
const steps = ref<DraftStep[]>([])

function openBuilder(route: OrgRoute | null) {
  editing.value = route
  name.value = route?.name ?? (routes.value.length ? '' : 'Standard document route')
  description.value = route?.description ?? ''
  steps.value = route?.steps.map((s) => ({ key: nextKey++, office_id: s.office_id, action_label: s.action_label })) ?? []
  if (!steps.value.length && offices.value[0]) addStep()
  mode.value = 'build'
  if (import.meta.client) window.scrollTo({ top: 0, behavior: 'smooth' })
}

function closeBuilder() {
  mode.value = 'list'
  editing.value = null
}

function addStep() {
  const last = steps.value.at(-1)?.office_id
  const used = new Set(steps.value.map((s) => s.office_id))
  const office = offices.value.find((o) => !used.has(o.id)) ?? offices.value.find((o) => o.id !== last) ?? offices.value[0]
  if (!office) return
  steps.value.push({ key: nextKey++, office_id: office.id, action_label: 'Review' })
}

function move(i: number, delta: number) {
  const j = i + delta
  if (j < 0 || j >= steps.value.length) return
  const copy = [...steps.value]
  ;[copy[i], copy[j]] = [copy[j]!, copy[i]!]
  steps.value = copy
}

const problems = computed(() => {
  const list: string[] = []
  const trimmed = name.value.trim()
  if (!trimmed) list.push('Give the route a name.')
  else if (routes.value.some((r) => r.id !== editing.value?.id && r.name.toLowerCase() === trimmed.toLowerCase())) list.push(`Another route is already called "${trimmed}".`)
  if (!steps.value.length) list.push('Add at least one step.')
  steps.value.forEach((s, i) => {
    if (i > 0 && s.office_id === steps.value[i - 1]!.office_id) list.push(`Steps ${i} and ${i + 1} use the same office back to back.`)
  })
  return list
})

const preview = computed(() =>
  steps.value.map((s, i) => ({
    step_number: i + 1,
    action_label: s.action_label || 'Review',
    is_final_checkpoint: i === steps.value.length - 1,
    office: officeById.value.get(s.office_id) ?? null,
  })),
)

/** Whether the edit touches the steps (renaming alone never affects documents in flight). */
const stepsChanged = computed(() => {
  const before = editing.value?.steps ?? []
  return (
    before.length !== steps.value.length ||
    steps.value.some((s, i) => s.office_id !== before[i]!.office_id || (s.action_label.trim() || 'Review') !== before[i]!.action_label)
  )
})

async function save() {
  if (problems.value.length) return
  const body = {
    name: name.value.trim(),
    description: description.value.trim(),
    steps: steps.value.map(({ office_id, action_label }) => ({ office_id, action_label })),
  }
  const route = editing.value
  const ok = route
    ? await run('save', () => routesApi.update(route.id, body), `“${body.name}” updated`)
    : await run('save', () => routesApi.create(body), `“${body.name}” created — uploaders can pick it now`)
  if (ok) {
    closeBuilder()
    await refresh()
    // A final checkpoint office may have changed — refresh the cached user too.
    useAuthStore().fetchMe().catch(() => {})
  }
}

// ---------------------------------------------------------------------------
// Remove
// ---------------------------------------------------------------------------
const removing = ref<OrgRoute | null>(null)

async function confirmRemove() {
  const route = removing.value
  if (!route) return
  const result = await run('remove', () => routesApi.remove(route.id))
  if (result) {
    useUiStore().success(result.retired ? `“${route.name}” retired` : `“${route.name}” deleted`, result.retired ? 'Documents already on it keep their history.' : undefined)
    removing.value = null
    await refresh()
    useAuthStore().fetchMe().catch(() => {})
  }
}
</script>

<template>
  <div class="fv-rise">
    <PageHeader
      eyebrow="A2 · Routing"
      :title="mode === 'build' ? (editing ? `Edit route` : 'New Document Route') : 'Document Routes'"
      :description="
        mode === 'build'
          ? 'Arrange the offices this kind of document passes through, in order. The last office is the final checkpoint, where it is approved. How long a document may take is set per document type in Organization Settings.'
          : 'Create one route per kind of document. Whoever uploads a document picks the route it follows; the last office on each route is its final checkpoint.'
      "
    >
      <template #actions>
        <button v-if="mode === 'list' && offices.length" class="btn btn-primary" @click="openBuilder(null)"><FIcon name="plus" :size="16" /> New route</button>
      </template>
    </PageHeader>

    <div v-if="!offices.length" class="card">
      <EmptyState icon="grid" title="Add offices first" description="A route is a sequence of offices. Create your offices, then come back to arrange them.">
        <NuxtLink to="/client/offices" class="btn btn-primary btn-sm">Go to offices</NuxtLink>
      </EmptyState>
    </div>

    <!-- Route list -->
    <template v-else-if="mode === 'list'">
      <div v-if="!routes.length" class="card">
        <EmptyState icon="git-commit" title="No routes yet" description="Documents can't be submitted until your organization has at least one Document Route.">
          <button class="btn btn-primary btn-sm" @click="openBuilder(null)">Create route</button>
        </EmptyState>
      </div>

      <div v-else class="space-y-4">
        <p class="text-sm text-ink-2">{{ routes.length }} active route{{ routes.length === 1 ? '' : 's' }}</p>
        <section v-for="r in routes" :key="r.id" class="card card-pad">
          <div class="flex flex-wrap items-start justify-between gap-3">
            <div class="min-w-0">
              <h2 class="text-xl">{{ r.name }}</h2>
              <p v-if="r.description" class="mt-1 text-sm text-ink-body">{{ r.description }}</p>
              <div class="mt-2 flex flex-wrap items-center gap-2 text-xs text-ink-2">
                <ToneBadge tone="neutral">{{ r.steps.length }} step{{ r.steps.length === 1 ? '' : 's' }}</ToneBadge>
                <ToneBadge v-if="r.in_flight_documents" tone="info" dot>{{ r.in_flight_documents }} in flight</ToneBadge>
                <span>Updated {{ formatDate(r.updated_at) }}</span>
              </div>
            </div>
            <div class="flex shrink-0 gap-2">
              <button class="btn btn-secondary btn-sm" @click="openBuilder(r)"><FIcon name="edit-2" :size="14" /> Edit</button>
              <button class="btn btn-ghost btn-sm text-danger-ink" :aria-label="`Remove ${r.name}`" @click="removing = r"><FIcon name="trash-2" :size="14" /> Remove</button>
            </div>
          </div>
          <div class="mt-5"><RouteFlow :steps="r.steps" /></div>
        </section>
      </div>
    </template>

    <!-- Builder -->
    <div v-else class="grid grid-cols-1 gap-6 xl:grid-cols-[minmax(0,1fr)_minmax(0,1fr)]">
      <section class="card card-pad">
        <div class="grid grid-cols-1 gap-4">
          <div>
            <label class="field-label" for="route-name">Route name</label>
            <input id="route-name" v-model="name" class="input" maxlength="191" placeholder="e.g. Purchase requests, Leave applications" />
          </div>
          <div>
            <label class="field-label" for="route-desc">Description</label>
            <input id="route-desc" v-model="description" class="input" placeholder="Optional: which documents should use this route" maxlength="2000" />
          </div>
        </div>

        <h3 class="mt-7 mb-3 text-base">Steps</h3>
        <ol class="space-y-3">
          <li v-for="(s, i) in steps" :key="s.key" class="rounded-2xl border border-line bg-card/70 p-4">
            <div class="mb-3 flex items-center justify-between">
              <span class="flex items-center gap-2 text-sm font-semibold">
                <span class="grid size-7 place-items-center rounded-full text-xs" :class="i === steps.length - 1 ? 'bg-sage text-white' : 'bg-terracotta/12 text-terracotta-ink'">
                  <FIcon v-if="i === steps.length - 1" name="award" :size="13" />
                  <template v-else>{{ i + 1 }}</template>
                </span>
                Step {{ i + 1 }}
                <ToneBadge v-if="i === steps.length - 1" tone="success">Final checkpoint</ToneBadge>
              </span>
              <span class="flex gap-1">
                <button class="grid size-9 place-items-center rounded-lg text-ink-2 hover:bg-ink/5 disabled:opacity-30" :disabled="i === 0" aria-label="Move up" @click="move(i, -1)"><FIcon name="arrow-up" :size="16" /></button>
                <button class="grid size-9 place-items-center rounded-lg text-ink-2 hover:bg-ink/5 disabled:opacity-30" :disabled="i === steps.length - 1" aria-label="Move down" @click="move(i, 1)"><FIcon name="arrow-down" :size="16" /></button>
                <button class="grid size-9 place-items-center rounded-lg text-danger-ink hover:bg-danger/10 disabled:opacity-30" :disabled="steps.length === 1" aria-label="Remove step" @click="steps.splice(i, 1)"><FIcon name="trash-2" :size="16" /></button>
              </span>
            </div>
            <div class="grid grid-cols-1 gap-3 sm:grid-cols-[minmax(0,1.4fr)_minmax(0,1fr)]">
              <div>
                <label class="sr-only" :for="`office-${s.key}`">Office</label>
                <select :id="`office-${s.key}`" v-model="s.office_id" class="input">
                  <optgroup v-for="dept in departments" :key="dept" :label="dept">
                    <option v-for="o in offices.filter((x) => x.department_name === dept)" :key="o.id" :value="o.id">{{ o.name }} ({{ o.code }})</option>
                  </optgroup>
                </select>
              </div>
              <div>
                <label class="sr-only" :for="`action-${s.key}`">Action</label>
                <input :id="`action-${s.key}`" v-model="s.action_label" class="input" placeholder="Action, e.g. Review" maxlength="100" />
              </div>
            </div>
          </li>
        </ol>
        <button class="btn btn-secondary mt-3 w-full" @click="addStep"><FIcon name="plus" :size="16" /> Add step</button>
      </section>

      <section class="space-y-6">
        <div class="card card-pad">
          <div class="flex items-center justify-between">
            <h3 class="text-base">Preview</h3>
            <span class="text-sm text-ink-2">{{ steps.length }} step{{ steps.length === 1 ? '' : 's' }}</span>
          </div>
          <div class="mt-5"><RouteFlow :steps="preview" /></div>
        </div>

        <div v-if="problems.length" class="rounded-2xl border border-amber/40 bg-amber/12 p-4 text-sm text-amber-ink">
          <ul class="list-inside list-disc space-y-1"><li v-for="p in problems" :key="p">{{ p }}</li></ul>
        </div>
        <div v-else-if="editing?.in_flight_documents && stepsChanged" class="rounded-2xl border border-info/30 bg-info/10 p-4 text-sm text-info-ink">
          {{ editing.in_flight_documents }} document{{ editing.in_flight_documents === 1 ? '' : 's' }} in flight will finish on the current steps. New submissions follow the edited route.
        </div>

        <div class="flex justify-end gap-2">
          <button class="btn btn-ghost" @click="closeBuilder">Cancel</button>
          <button class="btn btn-primary" :disabled="problems.length > 0 || busy === 'save'" @click="save">
            <FIcon name="check" :size="16" /> {{ editing ? 'Save changes' : 'Create route' }}
          </button>
        </div>
      </section>
    </div>

    <AppModal
      :open="Boolean(removing)"
      :title="`Remove “${removing?.name ?? ''}”?`"
      description="It disappears from the list and can no longer be picked for new documents."
      width="sm"
      @close="removing = null"
    >
      <ul class="list-inside list-disc space-y-1.5 text-sm text-ink-body">
        <li v-if="removing?.in_flight_documents">{{ removing.in_flight_documents }} document{{ removing.in_flight_documents === 1 ? '' : 's' }} in flight will still finish on this route.</li>
        <li>Documents that used it keep their history.</li>
        <li>Drafts and returned documents on it must pick another route when they are submitted.</li>
      </ul>
      <template #footer>
        <button class="btn btn-ghost" @click="removing = null">Cancel</button>
        <button class="btn btn-danger" :disabled="busy === 'remove'" @click="confirmRemove"><FIcon name="trash-2" :size="16" /> Remove route</button>
      </template>
    </AppModal>
  </div>
</template>
