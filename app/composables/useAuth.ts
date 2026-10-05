import { storeToRefs } from 'pinia'
import type { AccountType } from '~/types'

/** Convenience wrapper around the auth store for components. */
export function useAuth() {
  const store = useAuthStore()
  const { user, role, isAuthenticated, homePath } = storeToRefs(store)

  const is = (...roles: AccountType[]) => computed(() => (role.value ? roles.includes(role.value) : false))
  const hasApprovalAuthority = computed(() => Boolean(user.value?.has_approval_authority))

  return {
    user,
    role,
    isAuthenticated,
    homePath,
    hasApprovalAuthority,
    is,
    login: store.login,
    register: store.register,
    signOut: store.signOut,
    refreshUser: store.fetchMe,
  }
}

/** Run an async action with a busy flag and toast on failure. */
export function useAction() {
  const busy = ref<string | null>(null)
  const ui = useUiStore()

  async function run<T>(key: string, fn: () => Promise<T>, successMessage?: string): Promise<T | undefined> {
    if (busy.value) return undefined
    busy.value = key
    try {
      const result = await fn()
      if (successMessage) ui.success(successMessage)
      return result
    } catch (err) {
      ui.error('Action failed', apiErrorMessage(err))
      return undefined
    } finally {
      busy.value = null
    }
  }

  return { busy, run }
}
