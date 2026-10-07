<script setup lang="ts">
import type { AccountType, LiaisonProfile, Office } from '~/types'

useHead({ title: 'Team accounts · FlowVision' })

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
}

const api = useApi()
const routesApi = useRoutes()
const auth = useAuthStore()
const { busy, run } = useAction()

const [{ data, refresh }, { data: officeData }] = await Promise.all([
  useAsyncData('team', () => api.get<{ data: TeamMember[] }>('/users')),
  useAsyncData('team-offices', () => routesApi.offices()),
])
const offices = computed(() => officeData.value?.data ?? [])

const filter = ref<AccountType | ''>('')
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

// A client whose own pages are limited can't manage a client with every page (the owner).
const canManage = (m: TeamMember) => !(auth.user?.page_access && m.account_type === 'CLIENT' && !m.page_access && m.id !== auth.user.id)

// Invite / edit
const formOpen = ref(false)
const editing = ref<TeamMember | null>(null)
const form = reactive({ account_type: 'EMPLOYEE' as AccountType, first_name: '', last_name: '', email: '', phone: '', office_id: '', status: 'ACTIVE', page_access: null as string[] | null })
const needsOffice = computed(() => form.account_type !== 'CLIENT')

function openForm(member?: TeamMember) {
  editing.value = member ?? null
  Object.assign(form, {
    account_type: member?.account_type ?? 'EMPLOYEE',
    first_name: member?.first_name ?? '',
    last_name: member?.last_name ?? '',
    email: member?.email ?? '',
    phone: member?.phone ?? '',
    office_id: member?.office_id ?? '',
    status: member?.status ?? 'ACTIVE',
    page_access: member?.page_access ? [...member.page_access] : null,
  })
  formOpen.value = true
}

const credentials = ref<{ email: string; password: string } | null>(null)

async function save() {
  const body: Record<string, unknown> = { ...form, office_id: needsOffice.value ? form.office_id || null : null }
  // Nobody sets their own pages.
  if (editing.value?.id === auth.user?.id) delete body.page_access
  if (editing.value) {
    const ok = await run('save', () => api.patch(`/users/${editing.value!.id}`, body), 'Account updated')
    if (ok) {
      formOpen.value = false
      refresh()
    }
    return
  }
  const res = await run('save', () => api.post<{ temporary_password: string }>('/users', body))
  if (res) {
    formOpen.value = false
    credentials.value = { email: form.email, password: res.temporary_password }
    refresh()
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
    <PageHeader eyebrow="A4 · Team" title="Team accounts" description="Invite people and give each one a role. Employees, staff and liaisons work from a specific office.">
      <template #actions>
        <button class="btn btn-primary" @click="openForm()"><FIcon name="user-plus" :size="16" /> Invite member</button>
      </template>
    </PageHeader>

    <div class="mb-5 flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
      <div class="flex gap-1 overflow-x-auto rounded-xl bg-ink/[0.04] p-1" role="tablist">
        <button class="tab shrink-0" :class="!filter && 'tab-active'" role="tab" :aria-selected="!filter" @click="filter = ''">All {{ data?.data.length ?? 0 }}</button>
        <button
          v-for="(meta, role) in ROLE_META"
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
      <EmptyState v-if="!members.length" icon="users" title="No one matches" />
      <ul v-else class="divide-y divide-line/60">
        <li v-for="m in members" :key="m.id" class="flex flex-col gap-3 px-5 py-4 sm:flex-row sm:items-center">
          <div class="flex min-w-0 flex-1 items-center gap-3">
            <UserAvatar :user="m" />
            <div class="min-w-0">
              <p class="flex flex-wrap items-center gap-2 text-sm font-semibold">
                {{ fullName(m) }}
                <span v-if="m.id === auth.user?.id" class="text-xs font-normal text-ink-2">(you)</span>
                <ToneBadge v-if="m.status === 'SUSPENDED'" tone="danger">Suspended</ToneBadge>
                <ToneBadge v-else-if="m.must_change_password" tone="warning">Temp password</ToneBadge>
                <ToneBadge v-if="m.page_access" tone="neutral" icon="lock">{{ m.page_access.length }} pages</ToneBadge>
              </p>
              <p class="truncate text-xs text-ink-2">{{ m.email }}</p>
            </div>
          </div>
          <div class="flex flex-wrap items-center gap-2 sm:w-[340px] sm:justify-end">
            <ToneBadge :tone="ROLE_META[m.account_type].tone" dot>{{ ROLE_META[m.account_type].label }}</ToneBadge>
            <span v-if="m.office" class="truncate text-xs text-ink-body">{{ m.office.code }}</span>
            <ToneBadge v-if="m.account_type === 'STAFF' && m.office?.is_final_checkpoint" tone="success" icon="shield">Approver</ToneBadge>
            <span v-if="m.liaisonProfile" class="text-xs text-ink-2">{{ m.liaisonProfile.success_rate }}% success</span>
          </div>
          <div v-if="canManage(m)" class="flex gap-1">
            <button class="btn btn-sm btn-ghost border-0" @click="openForm(m)"><FIcon name="edit-2" :size="14" /> Edit</button>
            <button v-if="m.id !== auth.user?.id" class="btn btn-sm btn-ghost border-0" :disabled="busy === `reset-${m.id}`" :aria-busy="busy === `reset-${m.id}`" @click="resetPassword(m)">
              <FIcon name="key" :size="14" /> Reset
            </button>
          </div>
        </li>
      </ul>
    </section>

    <AppModal :open="formOpen" :title="editing ? `Edit ${fullName(editing)}` : 'Invite a team member'" description="They'll sign in with a temporary password and be asked to set their own." @close="formOpen = false">
      <form id="member-form" class="space-y-4" @submit.prevent="save">
        <fieldset>
          <legend class="field-label">Role</legend>
          <div class="grid grid-cols-2 gap-2">
            <label
              v-for="(meta, role) in ROLE_META"
              :key="role"
              class="flex cursor-pointer flex-col rounded-xl border p-3 transition-colors"
              :class="form.account_type === role ? 'border-terracotta bg-terracotta/[0.06]' : 'border-line hover:bg-card'"
            >
              <input v-model="form.account_type" type="radio" :value="role" class="sr-only" :disabled="editing?.id === auth.user?.id" @change="form.page_access = null" />
              <span class="flex items-center gap-2 text-sm font-semibold"><span class="size-2 rounded-full" :class="TONE_DOT[meta.tone]" />{{ meta.label }}</span>
              <span class="mt-1 text-xs text-ink-body">{{ meta.description }}</span>
            </label>
          </div>
        </fieldset>
        <div class="grid grid-cols-1 gap-4 sm:grid-cols-2">
          <div>
            <label class="field-label" for="m-first">First name</label>
            <input id="m-first" v-model="form.first_name" class="input" required />
          </div>
          <div>
            <label class="field-label" for="m-last">Last name</label>
            <input id="m-last" v-model="form.last_name" class="input" required />
          </div>
        </div>
        <div v-if="!editing">
          <label class="field-label" for="m-email">Email</label>
          <input id="m-email" v-model="form.email" type="email" class="input" required />
        </div>
        <div v-if="needsOffice">
          <label class="field-label" for="m-office">Office</label>
          <select id="m-office" v-model="form.office_id" class="input" required>
            <option value="" disabled>Select an office</option>
            <option v-for="o in offices" :key="o.id" :value="o.id">{{ o.name }} ({{ o.code }}){{ o.is_final_checkpoint ? ' · final checkpoint' : '' }}</option>
          </select>
          <p v-if="form.account_type === 'STAFF'" class="field-hint">Staff only have approval authority at the final checkpoint office.</p>
          <p v-if="form.account_type === 'LIAISON'" class="field-hint">Liaisons can pick up from every office in this office's department.</p>
        </div>
        <div v-if="editing && editing.id !== auth.user?.id">
          <label class="field-label" for="m-status">Status</label>
          <select id="m-status" v-model="form.status" class="input">
            <option value="ACTIVE">Active</option>
            <option value="SUSPENDED">Suspended — cannot sign in</option>
          </select>
        </div>
        <PageAccessPicker v-if="editing?.id !== auth.user?.id" v-model="form.page_access" :role="form.account_type" />
      </form>
      <template #footer>
        <button class="btn btn-ghost" @click="formOpen = false">Cancel</button>
        <button class="btn btn-primary" form="member-form" :disabled="busy === 'save'" :aria-busy="busy === 'save'">{{ editing ? 'Save changes' : 'Send invite' }}</button>
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
