import { defineStore } from 'pinia'
import type { CurrentUser } from '~/types'

/**
 * Who is signed in. The session itself is an httpOnly cookie set by the server,
 * so nothing secret lives here. The state is filled during SSR and hydrated on
 * the client through the Pinia payload.
 */
export const useAuthStore = defineStore('auth', () => {
  const user = ref<CurrentUser | null>(null)
  const ready = ref(false)

  const isAuthenticated = computed(() => Boolean(user.value))
  const role = computed(() => user.value?.account_type ?? null)
  const homePath = computed(() => (role.value ? ROLE_META[role.value].home : '/login'))

  function clear() {
    user.value = null
    useNotificationsStore().reset()
    disconnectRealtime()
  }

  async function login(email: string, password: string) {
    const res = await useApi().post<{ user: CurrentUser }>('/auth/login', { email, password })
    user.value = res.user
    ready.value = true
  }

  async function register(payload: Record<string, string>) {
    const res = await useApi().post<{ user: CurrentUser }>('/auth/register', payload)
    user.value = res.user
    ready.value = true
  }

  async function fetchMe() {
    const res = await useApi().get<{ user: CurrentUser }>('/auth/me')
    user.value = res.user
    return res.user
  }

  /** Resolve the session once per page load (on the server during SSR). */
  async function init() {
    if (ready.value) return
    try {
      await fetchMe()
    } catch {
      user.value = null
    }
    ready.value = true
  }

  async function signOut({ redirect = true } = {}) {
    await useApi().post('/auth/logout').catch(() => {})
    clear()
    if (redirect) await navigateTo('/login')
  }

  return { user, ready, isAuthenticated, role, homePath, clear, login, register, fetchMe, init, signOut }
})
