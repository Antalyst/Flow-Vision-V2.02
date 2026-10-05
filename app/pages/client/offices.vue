<script setup lang="ts">
import type { Office } from '~/types'

useHead({ title: 'Offices · FlowVision' })

const routesApi = useRoutes()
const { busy, run } = useAction()
const { data, refresh } = await useAsyncData('offices-all', () => routesApi.offices(true))

const grouped = computed(() => {
  const map = new Map<string, Office[]>()
  for (const o of data.value?.data ?? []) {
    const key = o.department_name || 'No department'
    map.set(key, [...(map.get(key) ?? []), o])
  }
  return [...map.entries()]
})
const departments = computed(() => [...new Set((data.value?.data ?? []).map((o) => o.department_name).filter(Boolean))])

const modalOpen = ref(false)
const editingId = ref<string | null>(null)
const form = reactive({ name: '', code: '', department: '', location: '' })

function openForm(office?: Office) {
  editingId.value = office?.id ?? null
  Object.assign(form, {
    name: office?.name ?? '',
    code: office?.code ?? '',
    department: office?.department_name ?? '',
    location: office?.location ?? '',
  })
  modalOpen.value = true
}

async function save() {
  const body = { ...form, code: form.code.trim().toUpperCase() }
  const ok = await run(
    'save',
    () => (editingId.value ? routesApi.updateOffice(editingId.value, body) : routesApi.createOffice(body)),
    editingId.value ? 'Office updated' : 'Office created',
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
    <PageHeader eyebrow="Organization" title="Offices" description="Offices are grouped by department. Liaisons pick up from any office in their department; codes appear on QR labels.">
      <template #actions>
        <button class="btn btn-primary" @click="openForm()"><FIcon name="plus" :size="16" /> Add office</button>
      </template>
    </PageHeader>

    <div v-if="!grouped.length" class="card">
      <EmptyState icon="grid" title="No offices yet" description="Add the offices documents pass through — for example Records, HR, Budget and the Mayor's office.">
        <button class="btn btn-primary btn-sm" @click="openForm()">Add your first office</button>
      </EmptyState>
    </div>

    <section v-for="[dept, list] in grouped" :key="dept" class="mb-6">
      <h2 class="eyebrow mb-3">{{ dept }}</h2>
      <div class="grid grid-cols-1 gap-3 sm:grid-cols-2 xl:grid-cols-3">
        <article v-for="o in list" :key="o.id" class="card p-5" :class="!o.is_active && 'opacity-60'">
          <div class="flex items-start justify-between gap-2">
            <span class="mono rounded-md bg-ink/[0.05] px-2 py-1 text-ink-body">{{ o.code }}</span>
            <div class="flex flex-wrap justify-end gap-1.5">
              <ToneBadge v-if="o.is_final_checkpoint" tone="success" icon="award">Final checkpoint</ToneBadge>
              <ToneBadge v-if="!o.is_active" tone="neutral">Inactive</ToneBadge>
            </div>
          </div>
          <p class="mt-3 font-display text-[15px] font-semibold leading-snug">{{ o.name }}</p>
          <p class="mt-1 flex items-center gap-1.5 text-xs text-ink-2"><FIcon name="map-pin" :size="12" /> {{ o.location || 'No location set' }}</p>
          <div class="mt-4 flex items-center justify-between border-t border-line/60 pt-3">
            <span class="text-xs text-ink-2">{{ o.member_count ?? 0 }} member{{ Number(o.member_count) === 1 ? '' : 's' }}</span>
            <span class="flex gap-1">
              <button class="btn btn-sm btn-ghost border-0" @click="openForm(o)"><FIcon name="edit-2" :size="14" /> Edit</button>
              <button class="btn btn-sm btn-ghost border-0" :disabled="busy === `toggle-${o.id}`" @click="toggleActive(o)">
                {{ o.is_active ? 'Deactivate' : 'Reactivate' }}
              </button>
            </span>
          </div>
        </article>
      </div>
    </section>

    <AppModal :open="modalOpen" :title="editingId ? 'Edit office' : 'Add office'" @close="modalOpen = false">
      <form id="office-form" class="grid grid-cols-1 gap-4 sm:grid-cols-2" @submit.prevent="save">
        <div class="sm:col-span-2">
          <label class="field-label" for="o-name">Office name</label>
          <input id="o-name" v-model="form.name" class="input" required placeholder="Human Resource Management Services Office" />
        </div>
        <div class="sm:col-span-2">
          <label class="field-label" for="o-code">Office code</label>
          <input
            id="o-code"
            v-model="form.code"
            class="input font-mono uppercase"
            required
            maxlength="50"
            pattern="[A-Za-z0-9]+(-[A-Za-z0-9]+)*"
            placeholder="BAG-HR-HRMSO"
          />
          <p class="field-hint">Printed on QR labels as ORG-DEPARTMENT-OFFICE, e.g. BAG-HR-HRMSO. Must be unique.</p>
        </div>
        <div>
          <label class="field-label" for="o-dept">Department</label>
          <input id="o-dept" v-model="form.department" class="input" required maxlength="100" list="departments" placeholder="Administrative Services" />
          <datalist id="departments"><option v-for="d in departments" :key="d" :value="d" /></datalist>
          <p class="field-hint">Liaisons pick up from every office in their department.</p>
        </div>
        <div>
          <label class="field-label" for="o-loc">Address</label>
          <input id="o-loc" v-model="form.location" class="input" placeholder="City Hall, 2nd floor" />
        </div>
      </form>
      <template #footer>
        <button class="btn btn-ghost" @click="modalOpen = false">Cancel</button>
        <button class="btn btn-primary" form="office-form" :disabled="busy === 'save'">Save office</button>
      </template>
    </AppModal>
  </div>
</template>
