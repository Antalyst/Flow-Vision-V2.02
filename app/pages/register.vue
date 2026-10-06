<script setup lang="ts">
definePageMeta({ layout: 'auth' })
useHead({ title: 'Create organization · FlowVision' })

const auth = useAuthStore()
const form = reactive({
  organization_name: '',
  first_name: '',
  last_name: '',
  email: '',
  password: '',
})
const error = ref('')
const submitting = ref(false)

async function submit() {
  error.value = ''
  submitting.value = true
  try {
    await auth.register({ ...form })
    await navigateTo('/client/dashboard')
  } catch (err) {
    error.value = apiErrorMessage(err, 'Could not create your account')
  } finally {
    submitting.value = false
  }
}
</script>

<template>
  <div class="fv-rise">
    <h1 class="text-[34px] leading-tight font-semibold tracking-[-0.04em]">Create your organization</h1>
    <p class="mt-2 text-[15px] text-ink-body">You'll be the Client administrator: you set the Document Route and invite your team.</p>

    <form method="post" class="mt-8 space-y-4" @submit.prevent="submit">
      <div>
        <label class="field-label" for="org">Organization name</label>
        <input id="org" v-model="form.organization_name" class="input" required maxlength="255" placeholder="Bago City Local Government Unit" />
      </div>
      <div class="grid grid-cols-1 gap-4 sm:grid-cols-2">
        <div>
          <label class="field-label" for="first">First name</label>
          <input id="first" v-model="form.first_name" class="input" required autocomplete="given-name" />
        </div>
        <div>
          <label class="field-label" for="last">Last name</label>
          <input id="last" v-model="form.last_name" class="input" required autocomplete="family-name" />
        </div>
      </div>
      <div>
        <label class="field-label" for="email">Work email</label>
        <input id="email" v-model="form.email" type="email" class="input" required autocomplete="email" />
      </div>
      <div>
        <label class="field-label" for="password">Password</label>
        <input id="password" v-model="form.password" type="password" class="input" required minlength="8" autocomplete="new-password" />
        <p class="field-hint">At least 8 characters.</p>
      </div>
      <p v-if="error" class="flex items-center gap-2 rounded-xl bg-danger/10 px-3.5 py-2.5 text-sm text-danger-ink" role="alert">
        <FIcon name="alert-circle" :size="16" /> {{ error }}
      </p>
      <button class="btn btn-primary w-full min-h-12 text-[15px]" :disabled="submitting" :aria-busy="submitting">
        {{ submitting ? 'Creating…' : 'Create organization' }}
      </button>
    </form>
    <p class="mt-6 text-center text-sm text-ink-body">
      Already have an account? <NuxtLink to="/login" class="font-medium text-terracotta-ink hover:underline">Sign in</NuxtLink>
    </p>
  </div>
</template>
