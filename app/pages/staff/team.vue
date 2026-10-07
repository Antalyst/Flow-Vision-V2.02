<script setup lang="ts">
import type { LiaisonProfile, Office } from '~/types'

useHead({ title: 'Messengers · FlowVision' })

interface TeamMember {
  id: string
  email: string
  first_name: string
  last_name: string
  phone: string | null
  account_type: 'LIAISON'
  status: 'ACTIVE' | 'SUSPENDED'
  office_id: string | null
  office: Office | null
  last_login_at: string | null
  must_change_password: boolean
  liaisonProfile: LiaisonProfile | null
  page_access: string[] | null
}

// A staff member creates and manages the messenger (LIAISON) accounts of their own office.
const api = useApi()
const auth = useAuthStore()
const { busy, run } = useAction()
const officeName = computed(() => auth.user?.office?.name ?? 'your office')

const { data, refresh } = await useAsyncData('staff-team', () => api.get<{ data: TeamMember[] }>('/users', { managed: 1 }))

const q = ref('')
const members = computed(() =>
  (data.value?.data ?? []).filter((m) => !q.value || `${m.first_name} ${m.last_name} ${m.email}`.toLowerCase().includes(q.value.toLowerCase())),
)

const formOpen = ref(false)
const editing = ref<TeamMember | null>(null)
const form = reactive({ account_type: 'LIAISON' as const, first_name: '', last_name: '', email: '', phone: '', status: 'ACTIVE', page_access: null as string[] | null })

function openForm(member?: TeamMember) {
  editing.value = member ?? null
  Object.assign(form, {
    first_name: member?.first_name ?? '',
    last_name: member?.last_name ?? '',
    email: member?.email ?? '',
    phone: member?.phone ?? '',
    status: member?.status ?? 'ACTIVE',
    page_access: member?.page_access ? [...member.page_access] : null,
  })
  formOpen.value = true
}

const credentials = ref<{ email: string; password: string } | null>(null)

async function save() {
  // The server places the account in this staff member's office.
  const body = { ...form }
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
    <PageHeader eyebrow="C4 · Team" title="Messengers" :description="`Create messenger accounts for ${officeName} and choose which pages each one can open.`">
      <template #actions>
        <button class="btn btn-primary" :disabled="!auth.user?.office" @click="openForm()"><FIcon name="user-plus" :size="16" /> New messenger</button>
      </template>
    </PageHeader>

    <div class="mb-5 flex justify-end">
      <div class="relative w-full sm:w-64">
        <FIcon name="search" :size="16" class="absolute top-1/2 left-3.5 -translate-y-1/2 text-ink-2" />
        <input v-model="q" class="input pl-10" placeholder="Search messengers" aria-label="Search messengers" />
      </div>
    </div>

    <section class="card overflow-hidden">
      <EmptyState
        v-if="!members.length"
        icon="users"
        :title="data?.data.length ? 'No one matches' : 'No messengers yet'"
        :description="data?.data.length ? undefined : 'Create messenger accounts for your office.'"
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
              <p class="truncate text-xs text-ink-2">{{ m.email }}</p>
            </div>
          </div>
          <div class="flex flex-wrap items-center gap-2 sm:w-[200px] sm:justify-end">
            <span v-if="m.liaisonProfile" class="text-xs text-ink-2">{{ m.liaisonProfile.success_rate }}% success</span>
          </div>
          <div class="flex gap-1">
            <button class="btn btn-sm btn-ghost border-0" @click="openForm(m)"><FIcon name="edit-2" :size="14" /> Edit</button>
            <button class="btn btn-sm btn-ghost border-0" :disabled="busy === `reset-${m.id}`" :aria-busy="busy === `reset-${m.id}`" @click="resetPassword(m)"><FIcon name="key" :size="14" /> Reset</button>
          </div>
        </li>
      </ul>
    </section>

    <AppModal
      :open="formOpen"
      :title="editing ? `Edit ${fullName(editing)}` : 'New messenger account'"
      :description="`The account belongs to ${officeName}. They'll sign in with a temporary password and be asked to set their own.`"
      @close="formOpen = false"
    >
      <form id="staff-team-form" class="space-y-4" @submit.prevent="save">
        <div class="grid grid-cols-1 gap-4 sm:grid-cols-2">
          <div>
            <label class="field-label" for="s-first">First name</label>
            <input id="s-first" v-model="form.first_name" class="input" required />
          </div>
          <div>
            <label class="field-label" for="s-last">Last name</label>
            <input id="s-last" v-model="form.last_name" class="input" required />
          </div>
        </div>
        <div v-if="!editing">
          <label class="field-label" for="s-email">Email</label>
          <input id="s-email" v-model="form.email" type="email" class="input" required />
        </div>
        <div>
          <label class="field-label" for="s-phone">Phone</label>
          <input id="s-phone" v-model="form.phone" class="input" maxlength="20" placeholder="Optional" />
        </div>
        <div v-if="editing">
          <label class="field-label" for="s-status">Status</label>
          <select id="s-status" v-model="form.status" class="input">
            <option value="ACTIVE">Active</option>
            <option value="SUSPENDED">Suspended — cannot sign in</option>
          </select>
        </div>
        <PageAccessPicker v-model="form.page_access" role="LIAISON" />
      </form>
      <template #footer>
        <button class="btn btn-ghost" @click="formOpen = false">Cancel</button>
        <button class="btn btn-primary" form="staff-team-form" :disabled="busy === 'save'" :aria-busy="busy === 'save'">{{ editing ? 'Save changes' : 'Create account' }}</button>
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
