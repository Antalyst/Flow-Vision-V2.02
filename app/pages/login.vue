<script setup lang="ts">
definePageMeta({ layout: 'auth' })
useHead({ title: 'Sign in · FlowVision' })

const auth = useAuthStore()
const route = useRoute()
const config = useRuntimeConfig()

// The page is server-rendered, so people (and password managers) can fill the
// fields before Vue hydrates. The inputs are therefore uncontrolled and read on
// submit instead of bound with v-model, which would wipe pre-hydration input.
const form = ref<HTMLFormElement | null>(null)
const error = ref('')
const submitting = ref(false)
const showPassword = ref(false)

// Seeded by scripts/db-seed.ts — handy for demos, hidden when showDemoAccounts is off.
const demoAccounts = [
  { email: 'client@bago.gov.ph', role: 'CLIENT', note: 'Org admin · submits' },
  { email: 'records@bago.gov.ph', role: 'EMPLOYEE', note: 'Records Section' },
  { email: 'hr@bago.gov.ph', role: 'EMPLOYEE', note: 'HRMSO' },
  { email: 'mayor.staff@bago.gov.ph', role: 'STAFF', note: 'Final checkpoint' },
  { email: 'hr.staff@bago.gov.ph', role: 'STAFF', note: 'View-only' },
  { email: 'liaison.adm@bago.gov.ph', role: 'LIAISON', note: 'Admin dept' },
  { email: 'liaison.fin@bago.gov.ph', role: 'LIAISON', note: 'Finance dept' },
] as const

async function submit() {
  const data = new FormData(form.value!)
  const email = String(data.get('email') ?? '').trim()
  const password = String(data.get('password') ?? '')
  error.value = ''
  if (!email || !password) {
    error.value = 'Enter your email and password.'
    return
  }
  submitting.value = true
  try {
    await auth.login(email, password)
    const redirect = typeof route.query.redirect === 'string' && route.query.redirect.startsWith('/') ? route.query.redirect : auth.homePath
    await navigateTo(redirect)
  } catch (err) {
    error.value = apiErrorMessage(err, 'Could not sign in')
  } finally {
    submitting.value = false
  }
}

function useDemo(addr: string) {
  const el = form.value!.elements
  ;(el.namedItem('email') as HTMLInputElement).value = addr
  ;(el.namedItem('password') as HTMLInputElement).value = 'Demo@1234'
  submit()
}
</script>

<template>
  <div class="fv-rise">
    <h1 class="text-[34px] leading-tight font-semibold tracking-[-0.04em]">Sign in</h1>
    <p class="mt-2 text-[15px] text-ink-body">Welcome back. Use the account your organization gave you.</p>

    <!-- method="post" so a submit before hydration can never put the password in a URL -->
    <form ref="form" method="post" class="mt-8 space-y-4" novalidate @submit.prevent="submit">
      <div>
        <label class="field-label" for="email">Email</label>
        <input id="email" name="email" type="email" class="input" autocomplete="username" required placeholder="you@bago.gov.ph" />
      </div>
      <div>
        <label class="field-label" for="password">Password</label>
        <div class="relative">
          <input
            id="password"
            name="password"
            :type="showPassword ? 'text' : 'password'"
            class="input pr-12"
            autocomplete="current-password"
            required
          />
          <button
            type="button"
            class="absolute top-1/2 right-2 grid size-9 -translate-y-1/2 place-items-center rounded-lg text-ink-2 hover:text-ink"
            :aria-label="showPassword ? 'Hide password' : 'Show password'"
            @click="showPassword = !showPassword"
          >
            <FIcon :name="showPassword ? 'eye-off' : 'eye'" :size="18" />
          </button>
        </div>
      </div>
      <p v-if="error" class="flex items-center gap-2 rounded-xl bg-danger/10 px-3.5 py-2.5 text-sm text-danger-ink" role="alert">
        <FIcon name="alert-circle" :size="16" /> {{ error }}
      </p>
      <button class="btn btn-primary w-full min-h-12 text-[15px]" :disabled="submitting">
        {{ submitting ? 'Signing in…' : 'Sign in' }}
      </button>
    </form>

    <p class="mt-6 text-center text-sm text-ink-body">
      Setting up a new organization?
      <NuxtLink to="/register" class="font-medium text-terracotta-ink hover:underline">Create an account</NuxtLink>
    </p>

    
  </div>
</template>
