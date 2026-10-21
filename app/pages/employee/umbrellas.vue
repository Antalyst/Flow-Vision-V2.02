<script setup lang="ts">
import type { Office, UserSummary } from '~/types'
import { DH_PERMISSIONS, DH_PERMISSION_META, MAIN_OFFICE_ONLY, SUGGESTED_DELEGATE_PERMISSIONS, type DhPermission } from '#shared/dh-permissions'
import { pickCode } from '#shared/office-code'

useHead({ title: 'Umbrella offices · FlowVision' })

interface UmbrellaRow extends Office {
  head: UserSummary | null
  heads: Array<UserSummary & { delegated: boolean }>
}
interface UmbrellaData {
  office: Office
  can_assign_heads: boolean
  codes_in_use: string[]
  eligible_heads: Array<UserSummary & { email: string }>
  data: UmbrellaRow[]
}

const api = useApi()
const auth = useAuthStore()
const { busy, run } = useAction()
const parent = computed(() => auth.user?.office ?? null)
const prefix = computed(() => (parent.value ? `${parent.value.code}-` : ''))

const { data, refresh, error, status } = await useAsyncData('umbrella-offices', () => api.get<UmbrellaData>('/offices/umbrellas'), { lazy: true })
const umbrellas = computed(() => data.value?.data ?? [])

// Add / edit. The code is generated from the name: the office's code + a 2–4 character suffix.
type HeadMode = 'none' | 'existing' | 'new'
const modalOpen = ref(false)
const editing = ref<UmbrellaRow | null>(null)
const form = reactive({
  name: '',
  regenerate: false,
  head_mode: 'none' as HeadMode,
  head_user_id: '',
  head: { first_name: '', last_name: '', email: '', phone: '' },
  permissions: [] as DhPermission[],
})

const myPermissions = computed(() => auth.user?.permissions ?? [])
/** An umbrella's head never gets what only a main office's head may do. */
const grantable = computed(() => DH_PERMISSIONS.filter((p) => myPermissions.value.includes(p) && !MAIN_OFFICE_ONLY.includes(p)))
function togglePermission(p: DhPermission) {
  form.permissions = form.permissions.includes(p) ? form.permissions.filter((x) => x !== p) : DH_PERMISSIONS.filter((x) => x === p || form.permissions.includes(x))
}
const candidates = computed(() => (data.value?.eligible_heads ?? []).filter((u) => u.office?.id !== editing.value?.id))

function openForm(u?: UmbrellaRow) {
  editing.value = u ?? null
  Object.assign(form, {
    name: u?.name ?? '',
    regenerate: false,
    head_mode: 'none',
    head_user_id: '',
    head: { first_name: '', last_name: '', email: '', phone: '' },
    permissions: SUGGESTED_DELEGATE_PERMISSIONS.filter((p) => grantable.value.includes(p)),
  })
  modalOpen.value = true
}

/**
 * The code the server will most likely give: the first free suffix for the name, skipping the codes
 * of this office's umbrella offices. Only a preview — the server picks the final code itself.
 */
const previewCode = computed(() => {
  if (editing.value && !form.regenerate) return editing.value.code
  const taken = (data.value?.codes_in_use ?? []).filter((c) => c !== editing.value?.code).map((c) => c.slice(prefix.value.length))
  const suffix = pickCode(form.name, taken)
  return suffix ? `${prefix.value}${suffix}` : null
})

const credentials = ref<{ email: string; password: string } | null>(null)

async function save() {
  const body: Record<string, unknown> = { name: form.name }
  if (editing.value && form.regenerate) body.regenerate_code = true
  if (form.head_mode === 'existing') body.head = { mode: 'existing', user_id: form.head_user_id }
  if (form.head_mode === 'new') body.head = { mode: 'new', ...form.head, permissions: form.permissions }
  const res = await run(
    'save',
    () => (editing.value ? api.patch<{ temporary_password?: string; office: Office }>(`/offices/umbrellas/${editing.value.id}`, body) : api.post<{ temporary_password?: string; office: Office }>('/offices/umbrellas', body)),
    editing.value ? 'Umbrella office updated' : 'Umbrella office added',
  )
  if (!res) return
  modalOpen.value = false
  if (res.temporary_password) credentials.value = { email: form.head.email, password: res.temporary_password }
  refresh()
}

async function toggleActive(u: UmbrellaRow) {
  const ok = await run(`toggle-${u.id}`, () => api.patch(`/offices/umbrellas/${u.id}`, { is_active: !u.is_active }), u.is_active ? 'Umbrella office deactivated' : 'Umbrella office reactivated')
  if (ok) refresh()
}

async function copyCredentials() {
  if (!credentials.value) return
  await navigator.clipboard.writeText(`FlowVision sign-in\nEmail: ${credentials.value.email}\nTemporary password: ${credentials.value.password}`).catch(() => {})
  useUiStore().success('Copied to clipboard')
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
        <button class="btn btn-primary" :disabled="Boolean(error) || !data" @click="openForm()"><FIcon name="plus" :size="16" /> Add umbrella office</button>
      </template>
    </PageHeader>

    <PageSkeleton v-if="status === 'pending' && !data" variant="cards" :rows="3" :messages="['Loading umbrella offices…']" />

    <div v-else-if="error" class="card card-pad flex flex-wrap items-center justify-between gap-3 text-sm text-danger-ink" role="alert">
      {{ apiErrorMessage(error, 'Could not load umbrella offices') }}
      <button class="btn btn-sm btn-ghost" @click="refresh()"><FIcon name="refresh-cw" :size="14" /> Try again</button>
    </div>

    <div v-else-if="!umbrellas.length" class="card">
      <EmptyState icon="git-branch" title="No umbrella offices yet" :description="`Add the divisions or units of ${parent?.name ?? 'your office'} that process documents, e.g. a Sanitation Unit (code ${prefix}SU).`">
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
        <p class="mt-3 text-[13px]">
          <template v-if="u.heads?.length"><span class="text-ink-2">Department Head{{ u.heads.length === 1 ? '' : 's' }}:</span> {{ u.heads.map((h) => fullName(h)).join(', ') }}</template>
          <button v-else-if="data?.can_assign_heads" class="text-left text-terracotta-ink hover:underline" @click="openForm(u)">No Department Head yet — assign one</button>
          <span v-else class="text-ink-2">No Department Head yet</span>
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
          <input id="u-name" v-model="form.name" class="input" required maxlength="255" placeholder="Sanitation Unit" />
        </div>

        <div>
          <p class="field-label">Code</p>
          <p class="flex flex-wrap items-center gap-2">
            <span class="mono rounded-md bg-ink/[0.05] px-2 py-1 text-ink-body" aria-live="polite">{{ previewCode ?? '—' }}</span>
            <span class="text-xs text-ink-2">{{ editing && !form.regenerate ? 'Stays the same when you rename the office.' : 'Made from the name. The final code is confirmed when you save.' }}</span>
          </p>
          <label v-if="editing" class="mt-2 flex items-center gap-2 text-sm">
            <input v-model="form.regenerate" type="checkbox" class="size-4" /> Make a new code from the name
          </label>
          <p v-if="editing && form.regenerate" class="field-hint">QR labels already printed with the old code keep working.</p>
          <p v-if="!previewCode && form.name.trim()" class="field-hint text-amber-ink">Use letters or digits in the name so a code can be made.</p>
        </div>

        <fieldset v-if="data?.can_assign_heads" class="space-y-3">
          <legend class="field-label">Department Head</legend>
          <div class="flex flex-wrap gap-2" role="radiogroup" aria-label="Department Head">
            <label v-for="o in [{ v: 'none', l: editing ? 'Keep as is' : 'Assign later' }, { v: 'existing', l: 'Choose an existing one' }, { v: 'new', l: 'Create a new account' }]" :key="o.v" class="flex items-center gap-2 rounded-full border border-line px-3 py-1.5 text-sm" :class="form.head_mode === o.v && 'border-ink bg-ink/[0.04]'">
              <input v-model="form.head_mode" type="radio" name="head-mode" :value="o.v" class="size-4" /> {{ o.l }}
            </label>
          </div>

          <div v-if="form.head_mode === 'existing'">
            <label class="field-label" for="u-head">Delegated Department Head</label>
            <select id="u-head" v-model="form.head_user_id" class="input" required>
              <option value="" disabled>Choose…</option>
              <option v-for="h in candidates" :key="h.id" :value="h.id">{{ fullName(h) }} — now at {{ h.office?.name ?? 'no office' }}</option>
            </select>
            <p class="field-hint">{{ candidates.length ? 'They move to this umbrella office. Permissions that only apply to the main office are removed.' : 'No delegated Department Head can be moved here. Create a new account instead.' }}</p>
          </div>

          <div v-if="form.head_mode === 'new'" class="space-y-4">
            <div class="grid grid-cols-1 gap-4 sm:grid-cols-2">
              <div>
                <label class="field-label" for="u-hf">First name</label>
                <input id="u-hf" v-model="form.head.first_name" class="input" required maxlength="100" />
              </div>
              <div>
                <label class="field-label" for="u-hl">Last name</label>
                <input id="u-hl" v-model="form.head.last_name" class="input" required maxlength="100" />
              </div>
            </div>
            <div class="grid grid-cols-1 gap-4 sm:grid-cols-2">
              <div>
                <label class="field-label" for="u-he">Email</label>
                <input id="u-he" v-model="form.head.email" type="email" class="input" required maxlength="191" />
              </div>
              <div>
                <label class="field-label" for="u-hp">Phone</label>
                <input id="u-hp" v-model="form.head.phone" class="input" maxlength="20" placeholder="Optional" />
              </div>
            </div>
            <div>
              <p class="field-label">Permissions</p>
              <div class="space-y-1.5">
                <label v-for="p in grantable" :key="p" class="flex items-start gap-2 rounded-lg px-2 py-1.5 text-sm hover:bg-ink/[0.03]">
                  <input type="checkbox" class="mt-0.5 size-4" :checked="form.permissions.includes(p)" @change="togglePermission(p)" />
                  <span>
                    <span class="font-medium">{{ DH_PERMISSION_META[p].label }}</span>
                    <span class="block text-xs text-ink-2">{{ DH_PERMISSION_META[p].description }}</span>
                  </span>
                </label>
              </div>
              <p class="field-hint">They sign in with a temporary password, shown once after saving.</p>
            </div>
          </div>
        </fieldset>
        <p v-else class="text-xs text-ink-2">Your account can’t assign Department Heads; the umbrella office is created without one.</p>
      </form>
      <template #footer>
        <button class="btn btn-ghost" @click="modalOpen = false">Cancel</button>
        <button class="btn btn-primary" form="umbrella-form" :disabled="busy === 'save' || (!editing && !previewCode)" :aria-busy="busy === 'save'">Save</button>
      </template>
    </AppModal>

    <AppModal :open="Boolean(credentials)" title="Share these sign-in details" description="This temporary password is shown once. Send it privately." width="sm" @close="credentials = null">
      <dl v-if="credentials" class="space-y-3 rounded-2xl bg-ink/[0.04] p-4">
        <div>
          <dt class="eyebrow">Email</dt>
          <dd class="mt-1 text-sm font-medium">{{ credentials.email }}</dd>
        </div>
        <div>
          <dt class="eyebrow">Temporary password</dt>
          <dd class="mt-1 font-mono text-lg tracking-wide">{{ credentials.password }}</dd>
        </div>
      </dl>
      <template #footer>
        <button class="btn btn-ghost" @click="copyCredentials"><FIcon name="copy" :size="15" /> Copy</button>
        <button class="btn btn-primary" @click="credentials = null">Done</button>
      </template>
    </AppModal>
  </div>
</template>
