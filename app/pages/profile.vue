<script setup lang="ts">
useHead({ title: 'Profile · FlowVision' })

const auth = useAuthStore()
const api = useApi()
const { busy, run } = useAction()

const profile = reactive({
  first_name: auth.user?.first_name ?? '',
  last_name: auth.user?.last_name ?? '',
  phone: auth.user?.phone ?? '',
})
const pw = reactive({ current_password: '', new_password: '', confirm: '' })
const pwError = ref('')

async function saveProfile() {
  const ok = await run('profile', () => api.patch('/auth/me', profile), 'Profile updated')
  if (ok) auth.fetchMe()
}

async function changePassword() {
  pwError.value = ''
  if (pw.new_password.length < 8) return (pwError.value = 'Use at least 8 characters.')
  if (pw.new_password !== pw.confirm) return (pwError.value = "The new passwords don't match.")
  const ok = await run(
    'password',
    () => api.post('/auth/change-password', { current_password: pw.current_password, new_password: pw.new_password }),
    'Password changed — other devices were signed out',
  )
  if (ok) {
    Object.assign(pw, { current_password: '', new_password: '', confirm: '' })
    auth.fetchMe()
  }
}
</script>

<template>
  <div class="fv-rise mx-auto max-w-2xl">
    <PageHeader eyebrow="Account" title="Your profile" />

    <section class="card card-pad mb-6 flex items-center gap-4">
      <UserAvatar :user="auth.user" size="lg" />
      <div class="min-w-0">
        <p class="font-display text-lg font-semibold">{{ fullName(auth.user) }}</p>
        <p class="truncate text-sm text-ink-body">{{ auth.user?.email }}</p>
        <div class="mt-2 flex flex-wrap gap-2">
          <ToneBadge v-if="auth.role" :tone="ROLE_META[auth.role].tone" dot>{{ ROLE_META[auth.role].label }}</ToneBadge>
          <ToneBadge v-if="auth.user?.office">{{ auth.user.office.name }}</ToneBadge>
          <ToneBadge v-if="auth.user?.has_approval_authority" tone="success" icon="shield">Approval authority</ToneBadge>
        </div>
      </div>
    </section>

    <section class="card card-pad mb-6">
      <h2 class="mb-4 text-lg">Details</h2>
      <form class="grid grid-cols-1 gap-4 sm:grid-cols-2" @submit.prevent="saveProfile">
        <div>
          <label class="field-label" for="p-first">First name</label>
          <input id="p-first" v-model="profile.first_name" class="input" required />
        </div>
        <div>
          <label class="field-label" for="p-last">Last name</label>
          <input id="p-last" v-model="profile.last_name" class="input" required />
        </div>
        <div class="sm:col-span-2">
          <label class="field-label" for="p-phone">Mobile number</label>
          <input id="p-phone" v-model="profile.phone" class="input" type="tel" placeholder="09XX XXX XXXX" />
        </div>
        <div class="sm:col-span-2 flex justify-end">
          <button class="btn btn-primary" :disabled="busy === 'profile'" :aria-busy="busy === 'profile'">Save details</button>
        </div>
      </form>
    </section>

    <section id="password" class="card card-pad" :class="auth.user?.must_change_password && 'ring-2 ring-amber/50'">
      <h2 class="text-lg">Password</h2>
      <p v-if="auth.user?.must_change_password" class="mt-1 text-sm text-amber-ink">You're signed in with a temporary password. Choose your own to continue safely.</p>
      <form class="mt-4 space-y-4" @submit.prevent="changePassword">
        <div>
          <label class="field-label" for="pw-current">Current password</label>
          <input id="pw-current" v-model="pw.current_password" type="password" class="input" autocomplete="current-password" required />
        </div>
        <div class="grid grid-cols-1 gap-4 sm:grid-cols-2">
          <div>
            <label class="field-label" for="pw-new">New password</label>
            <input id="pw-new" v-model="pw.new_password" type="password" class="input" autocomplete="new-password" required minlength="8" />
          </div>
          <div>
            <label class="field-label" for="pw-confirm">Confirm new password</label>
            <input id="pw-confirm" v-model="pw.confirm" type="password" class="input" autocomplete="new-password" required />
          </div>
        </div>
        <p v-if="pwError" class="text-sm text-danger-ink" role="alert">{{ pwError }}</p>
        <div class="flex justify-end">
          <button class="btn btn-primary" :disabled="busy === 'password'" :aria-busy="busy === 'password'">Change password</button>
        </div>
      </form>
    </section>
  </div>
</template>
