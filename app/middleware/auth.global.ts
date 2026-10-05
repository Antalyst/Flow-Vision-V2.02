import type { AccountType } from '~/types'

// "/" is the public landing page; signed-in users skip it and land in their portal.
const PUBLIC_PATHS = ['/', '/login', '/register']

// Each portal is reserved for one account type; shared pages (documents, messages, issues…) are open to all.
const PORTALS: Record<string, AccountType> = {
  '/client': 'CLIENT',
  '/employee': 'EMPLOYEE',
  '/staff': 'STAFF',
  '/liaison': 'LIAISON',
}

export default defineNuxtRouteMiddleware(async (to) => {
  const auth = useAuthStore()
  await auth.init()

  if (PUBLIC_PATHS.includes(to.path)) {
    return auth.isAuthenticated ? navigateTo(auth.homePath) : undefined
  }

  if (!auth.isAuthenticated) {
    return navigateTo({ path: '/login', query: { redirect: to.fullPath } })
  }

  // Before anything renders, so the server-rendered unread badge matches the client.
  await useNotificationsStore().ensureLoaded()

  const portal = Object.keys(PORTALS).find((prefix) => to.path === prefix || to.path.startsWith(`${prefix}/`))
  if (portal && PORTALS[portal] !== auth.role) return navigateTo(auth.homePath)

  // Conditional UI: the approval page exists only for STAFF at the final checkpoint.
  if (to.path.startsWith('/staff/approval') && !auth.user?.has_approval_authority) {
    return navigateTo('/staff/view')
  }

  // Scanning moves paper: messengers pick up, office staff receive. The CLIENT administrator only follows along.
  if (to.path === '/scan' && auth.role === 'CLIENT') return navigateTo(auth.homePath)

  // Liaisons carry documents but don't upload them.
  if ((to.path === '/documents' || to.path === '/documents/new') && auth.role === 'LIAISON') {
    return navigateTo(auth.homePath)
  }
})
