<script setup lang="ts">
import type { AccountType, LiaisonProfile, Office, UserSummary } from '~/types'
import { DH_PERMISSIONS, DH_PERMISSION_META, MAIN_OFFICE_ONLY, SUGGESTED_DELEGATE_PERMISSIONS, type DhPermission } from '#shared/dh-permissions'

useHead({ title: 'Staff & messengers · FlowVision' })

interface TeamMember {
  id: string
  email: string
  first_name: string
  last_name: string
  phone: string | null
  account_type: AccountType
  status: 'ACTIVE' | 'SUSPENDED'
  office_id: string | null
  office: Office | null
  last_login_at: string | null
  must_change_password: boolean
  liaisonProfile: LiaisonProfile | null
  page_access: string[] | null
  delegated: boolean
  assigned_by: string | null
  assigned_at: string | null
  permissions: DhPermission[] | null
}

type ManagedType = 'STAFF' | 'LIAISON' | 'DEPARTMENT_HEAD'

// A department head manages the STAFF and LIAISON (messenger) accounts of their own office and its umbrella
// offices ("Manage staff and messengers"), and assigns delegated Department Heads there ("Assign Department
// Heads") — any number per office or umbrella office, each with only the permissions granted here.
const ROLES: Record<ManagedType, { label: string; description: string }> = {
  STAFF: { label: 'Staff', description: 'Uploads and tracks their own documents; approves at the final checkpoint' },
  LIAISON: { label: 'Messenger', description: 'Picks up and delivers documents between offices' },
  DEPARTMENT_HEAD: { label: 'Department Head (delegated)', description: 'Assigned by you, with only the permissions you grant below' },
}
const myPermissions = computed(() => auth.user?.permissions ?? [])
const allowedRoles = computed(() =>
  (Object.keys(ROLES) as ManagedType[]).filter((r) => myPermissions.value.includes(r === 'DEPARTMENT_HEAD' ? 'ASSIGN_HEADS' : 'MANAGE_TEAM')),
)

const api = useApi()
const auth = useAuthStore()
const { busy, run } = useAction()
const officeName = computed(() => auth.user?.office?.name ?? 'your office')

const { data, refresh } = await useAsyncData('employee-team', () => api.get<{ data: TeamMember[] }>('/users', { managed: 1 }))
// The umbrella offices of this office (none for an umbrella office itself).
const { data: officeData } = await useAsyncData('employee-team-offices', () => api.get<{ data: Office[] }>('/offices'))
const umbrellas = computed(() => (officeData.value?.data ?? []).filter((o) => o.parent_office_id && o.parent_office_id === auth.user?.office?.id))
const refreshUmbrellas = () => {}
const officeChoices = computed(() => [
  ...(auth.user?.office ? [{ id: auth.user.office.id, label: `${auth.user.office.name} (your office)` }] : []),
  ...umbrellas.value.map((u) => ({ id: u.id, label: `↳ ${u.name} · ${u.code}` })),
])

const filter = ref<ManagedType | ''>('')
const q = ref('')
const members = computed(() =>
  (data.value?.data ?? []).filter(
    (m) =>
      (!filter.value || m.account_type === filter.value) &&
      (!q.value || `${m.first_name} ${m.last_name} ${m.email}`.toLowerCase().includes(q.value.toLowerCase())),
  ),
)
const counts = computed(() => {
  const c: Record<string, number> = {}
  for (const m of data.value?.data ?? []) c[m.account_type] = (c[m.account_type] ?? 0) + 1
  return c
})

const formOpen = ref(false)
const editing = ref<TeamMember | null>(null)
const form = reactive({
  account_type: 'STAFF' as ManagedType,
  office_id: '',
  first_name: '',
  last_name: '',
  email: '',
  phone: '',
  status: 'ACTIVE',
  page_access: null as string[] | null,
  permissions: [] as DhPermission[],
})

/** Roles this account may add (its own permissions decide). */
const roleChoices = computed(() => allowedRoles.value)
watch(roleChoices, (choices) => {
  if (!choices.includes(form.account_type)) form.account_type = choices[0] ?? 'STAFF'
})
/** Permissions offered for a delegate: only those this account holds; umbrella management only in the main office. */
const grantable = computed(() => {
  const intoUmbrella = umbrellas.value.some((u) => u.id === form.office_id)
  return DH_PERMISSIONS.filter((p) => myPermissions.value.includes(p) && !(intoUmbrella && MAIN_OFFICE_ONLY.includes(p)))
})
watch(grantable, (list) => (form.permissions = form.permissions.filter((p) => list.includes(p))))
function togglePermission(p: DhPermission) {
  form.permissions = form.permissions.includes(p) ? form.permissions.filter((x) => x !== p) : DH_PERMISSIONS.filter((x) => x === p || form.permissions.includes(x))
}
const officeLabelOf = (id: string | null) => (id === auth.user?.office?.id ? null : umbrellas.value.find((u) => u.id === id)?.name ?? null)

function openForm(member?: TeamMember) {
  editing.value = member ?? null
  Object.assign(form, {
    account_type: (member?.account_type as ManagedType) ?? 'STAFF',
    office_id: member?.office_id ?? auth.user?.office?.id ?? '',
    first_name: member?.first_name ?? '',
    last_name: member?.last_name ?? '',
    email: member?.email ?? '',
    phone: member?.phone ?? '',
    status: member?.status ?? 'ACTIVE',
    page_access: member?.page_access ? [...member.page_access] : null,
    // A new delegate starts with the everyday document permissions ticked; nothing is granted until saved.
    permissions: member?.permissions ? [...member.permissions] : SUGGESTED_DELEGATE_PERMISSIONS.filter((p) => myPermissions.value.includes(p)),
  })
  formOpen.value = true
}

// Assignment history of a delegate: who assigned it, each change, and when.
interface AssignmentRow {
  id: string
  action: 'ASSIGNED' | 'UPDATED' | 'REVOKED' | 'REINSTATED'
  permissions: DhPermission[] | null
  changed_by: UserSummary | null
  note: string | null
  created_at: string
}
const historyOf = ref<TeamMember | null>(null)
const history = ref<AssignmentRow[]>([])
async function openHistory(m: TeamMember) {
  historyOf.value = m
  history.value = []
  const res = await run(`history-${m.id}`, () => api.get<{ data: AssignmentRow[] }>(`/users/${m.id}/assignments`))
  if (res) history.value = res.data
}
const permissionNames = (list: DhPermission[]) => (list.length ? list.map((x) => DH_PERMISSION_META[x].label).join(', ') : 'No permissions')
const ACTION_LABEL: Record<AssignmentRow['action'], string> = { ASSIGNED: 'Assigned', UPDATED: 'Permissions changed', REVOKED: 'Access revoked', REINSTATED: 'Reinstated' }

const credentials = ref<{ email: string; password: string } | null>(null)

async function save() {
  // The server checks the office (own office or one of its umbrella offices) and every permission granted.
  const { permissions, ...rest } = form
  const body: Record<string, unknown> = { ...rest, ...(form.account_type === 'DEPARTMENT_HEAD' && { permissions }) }
  if (editing.value) {
    const ok = await run('save', () => api.patch(`/users/${editing.value!.id}`, body), 'Account updated')
    if (ok) {
      formOpen.value = false
      refresh()
      refreshUmbrellas()
    }
    return
  }
  const res = await run('save', () => api.post<{ temporary_password: string }>('/users', body))
  if (res) {
    formOpen.value = false
    credentials.value = { email: form.email, password: res.temporary_password }
    refresh()
    refreshUmbrellas()
  }
}

async function resetPassword(m: TeamMember) {
  await useUiStore().confirm({
    title: `Reset ${m.first_name}'s password?`,
    body: `${m.first_name} ${m.last_name} will be signed out everywhere and given a temporary password.`,
    confirmLabel: 'Reset password',
    busyLabel: 'Resetting…',
    icon: 'key',
    action: async () => {
      const res = await run(`reset-${m.id}`, () => api.post<{ temporary_password: string }>(`/users/${m.id}/reset-password`))
      if (res) credentials.value = { email: m.email, password: res.temporary_password }
    },
  })
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
      eyebrow="B4 · Team"
      title="Staff & messengers"
      :description="`Create accounts for ${officeName}. Everything your staff upload shows up under Office documents, so you can follow it.`"
    >
      <template #actions>
        <button class="btn btn-primary" :disabled="!auth.user?.office || !allowedRoles.length" :title="allowedRoles.length ? undefined : 'Your account doesn’t have permission to add accounts'" @click="openForm()"><FIcon name="user-plus" :size="16" /> New account</button>
      </template>
    </PageHeader>

    <div class="mb-5 flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
      <div class="flex gap-1 overflow-x-auto rounded-xl bg-ink/[0.04] p-1" role="tablist">
        <button class="tab shrink-0" :class="!filter && 'tab-active'" role="tab" :aria-selected="!filter" @click="filter = ''">All {{ data?.data.length ?? 0 }}</button>
        <button
          v-for="(meta, role) in ROLES"
          :key="role"
          class="tab shrink-0"
          :class="filter === role && 'tab-active'"
          role="tab"
          :aria-selected="filter === role"
          @click="filter = role"
        >
          {{ meta.label }} <span class="text-ink-2">{{ counts[role] ?? 0 }}</span>
        </button>
      </div>
      <div class="relative sm:w-64">
        <FIcon name="search" :size="16" class="absolute top-1/2 left-3.5 -translate-y-1/2 text-ink-2" />
        <input v-model="q" class="input pl-10" placeholder="Search people" aria-label="Search people" />
      </div>
    </div>

    <section class="card overflow-hidden">
      <EmptyState
        v-if="!members.length"
        icon="users"
        :title="data?.data.length ? 'No one matches' : 'No accounts yet'"
        :description="data?.data.length ? undefined : 'Create staff and messenger accounts for your office.'"
      />
      <ul v-else class="divide-y divide-line/60">
        <li v-for="m in members" :key="m.id" class="flex flex-col gap-3 px-5 py-4 sm:flex-row sm:items-center">
          <div class="flex min-w-0 flex-1 items-center gap-3">
            <UserAvatar :user="m" />
            <div class="min-w-0">
              <p class="flex flex-wrap items-center gap-2 text-sm font-semibold">
                {{ fullName(m) }}
                <ToneBadge v-if="m.status === 'SUSPENDED'" tone="danger">Suspended</ToneBadge>
                <ToneBadge v-else-if="m.must_change_password" tone="warning">Temp password</ToneBadge>
                <ToneBadge v-if="m.page_access" tone="neutral" icon="lock">{{ m.page_access.length }} pages</ToneBadge>
              </p>
              <p class="truncate text-xs text-ink-2">{{ m.email }}<template v-if="officeLabelOf(m.office_id)"> · {{ officeLabelOf(m.office_id) }}</template></p>
              <p v-if="m.delegated" class="mt-0.5 text-xs text-ink-2">
                Assigned {{ formatDate(m.assigned_at) }} · {{ m.permissions?.length ?? 0 }} of {{ DH_PERMISSIONS.length }} permissions
              </p>
            </div>
          </div>
          <div class="flex flex-wrap items-center gap-2 sm:w-[260px] sm:justify-end">
            <ToneBadge :tone="roleMeta(m.account_type).tone" dot>{{ ROLES[m.account_type as ManagedType]?.label ?? roleMeta(m.account_type).label }}</ToneBadge>
            <ToneBadge v-if="m.account_type === 'STAFF' && m.office?.is_final_checkpoint" tone="success" icon="shield">Approver</ToneBadge>
            <span v-if="m.liaisonProfile" class="text-xs text-ink-2">{{ m.liaisonProfile.success_rate }}% success</span>
          </div>
          <div class="flex gap-1">
            <button class="btn btn-sm btn-ghost border-0" @click="openForm(m)"><FIcon name="edit-2" :size="14" /> Edit</button>
            <button v-if="m.delegated" class="btn btn-sm btn-ghost border-0" :disabled="busy === `history-${m.id}`" @click="openHistory(m)"><FIcon name="clock" :size="14" /> History</button>
            <button class="btn btn-sm btn-ghost border-0" :disabled="busy === `reset-${m.id}`" :aria-busy="busy === `reset-${m.id}`" @click="resetPassword(m)"><FIcon name="key" :size="14" /> Reset</button>
          </div>
        </li>
      </ul>
    </section>

    <AppModal
      :open="formOpen"
      :title="editing ? `Edit ${fullName(editing)}` : 'New account'"
      description="They'll sign in with a temporary password and be asked to set their own."
      @close="formOpen = false"
    >
      <form id="team-form" class="space-y-4" @submit.prevent="save">
        <div v-if="officeChoices.length > 1">
          <label class="field-label" for="t-office">Office</label>
          <select id="t-office" v-model="form.office_id" class="input">
            <option v-for="o in officeChoices" :key="o.id" :value="o.id">{{ o.label }}</option>
          </select>
          <p class="field-hint">People can work in your office or one of its umbrella offices. Any number of delegated Department Heads can be assigned to each.</p>
        </div>
        <fieldset>
          <legend class="field-label">Role</legend>
          <div class="grid grid-cols-2 gap-2">
            <label
              v-for="role in roleChoices"
              :key="role"
              class="flex cursor-pointer flex-col rounded-xl border p-3 transition-colors"
              :class="form.account_type === role ? 'border-terracotta bg-terracotta/[0.06]' : 'border-line hover:bg-card'"
            >
              <input v-model="form.account_type" type="radio" :value="role" class="sr-only" @change="form.page_access = null" />
              <span class="flex items-center gap-2 text-sm font-semibold"><span class="size-2 rounded-full" :class="TONE_DOT[ROLE_META[role].tone]" />{{ ROLES[role].label }}</span>
              <span class="mt-1 text-xs text-ink-body">{{ ROLES[role].description }}</span>
            </label>
          </div>
        </fieldset>
        <div class="grid grid-cols-1 gap-4 sm:grid-cols-2">
          <div>
            <label class="field-label" for="t-first">First name</label>
            <input id="t-first" v-model="form.first_name" class="input" required />
          </div>
          <div>
            <label class="field-label" for="t-last">Last name</label>
            <input id="t-last" v-model="form.last_name" class="input" required />
          </div>
        </div>
        <div v-if="!editing">
          <label class="field-label" for="t-email">Email</label>
          <input id="t-email" v-model="form.email" type="email" class="input" required />
        </div>
        <div>
          <label class="field-label" for="t-phone">Phone</label>
          <input id="t-phone" v-model="form.phone" class="input" maxlength="20" placeholder="Optional" />
        </div>
        <div v-if="editing">
          <label class="field-label" for="t-status">Status</label>
          <select id="t-status" v-model="form.status" class="input">
            <option value="ACTIVE">Active</option>
            <option value="SUSPENDED">Suspended — cannot sign in</option>
          </select>
        </div>
        <fieldset v-if="form.account_type === 'DEPARTMENT_HEAD'">
          <legend class="field-label">Permissions</legend>
          <p class="field-hint -mt-1 mb-2">Granted explicitly. You can only grant what your own account may do. Change or revoke them any time.</p>
          <div class="space-y-1.5">
            <label v-for="p in grantable" :key="p" class="flex items-start gap-2 rounded-lg px-2 py-1.5 text-sm hover:bg-ink/[0.03]">
              <input type="checkbox" class="mt-0.5 size-4" :checked="form.permissions.includes(p)" @change="togglePermission(p)" />
              <span>
                <span class="font-medium">{{ DH_PERMISSION_META[p].label }}</span>
                <span class="block text-xs text-ink-2">{{ DH_PERMISSION_META[p].description }}</span>
              </span>
            </label>
          </div>
          <p v-if="!form.permissions.length" class="mt-1 text-xs text-amber-ink">With no permissions this Department Head can only view the office’s documents.</p>
        </fieldset>
        <PageAccessPicker v-model="form.page_access" :role="form.account_type" />
      </form>
      <template #footer>
        <button class="btn btn-ghost" @click="formOpen = false">Cancel</button>
        <button class="btn btn-primary" form="team-form" :disabled="busy === 'save'" :aria-busy="busy === 'save'">{{ editing ? 'Save changes' : 'Create account' }}</button>
      </template>
    </AppModal>

    <AppModal :open="Boolean(historyOf)" :title="historyOf ? `Assignment history · ${fullName(historyOf)}` : ''" width="sm" @close="historyOf = null">
      <p v-if="busy === `history-${historyOf?.id}`" class="flex items-center gap-2 text-sm text-ink-2"><span class="spinner" /> Loading…</p>
      <p v-else-if="!history.length" class="text-sm text-ink-2">No history recorded.</p>
      <ol v-else class="space-y-3">
        <li v-for="h in history" :key="h.id" class="text-sm">
          <p class="font-medium">{{ ACTION_LABEL[h.action] }} <span class="font-normal text-ink-2">· {{ formatDateTime(h.created_at) }}<template v-if="h.changed_by"> · by {{ fullName(h.changed_by) }}</template></span></p>
          <p v-if="h.permissions" class="text-xs text-ink-2">{{ permissionNames(h.permissions) }}</p>
          <p v-if="h.note" class="text-xs text-amber-ink">{{ h.note }}</p>
        </li>
      </ol>
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
