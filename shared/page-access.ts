// Which pages an account may open. Used by the sidebar, the route middleware and the server.
// users.page_access holds the granted paths; NULL means every page of the account's role.
// Each role's dashboard, notifications and profile are always open, so nobody is locked out.

export type PageRole = 'CLIENT' | 'EMPLOYEE' | 'STAFF' | 'LIAISON'

export interface GrantablePage {
  path: string
  label: string
  group: string
}

const COLLABORATE: GrantablePage[] = [
  { path: '/messages', label: 'Messages', group: 'Collaborate' },
  { path: '/issues', label: 'Issues', group: 'Collaborate' },
  { path: '/logs', label: 'Activity log', group: 'Collaborate' },
]

export const GRANTABLE_PAGES: Record<PageRole, GrantablePage[]> = {
  CLIENT: [
    { path: '/ai/chat', label: 'AI Assistant', group: 'Overview' },
    { path: '/documents', label: 'All documents', group: 'Documents' },
    { path: '/documents/new', label: 'Upload document', group: 'Documents' },
    { path: '/client/routes', label: 'Document Routes', group: 'Organization' },
    { path: '/client/offices', label: 'Offices', group: 'Organization' },
    { path: '/client/accounts', label: 'Team accounts', group: 'Organization' },
    { path: '/client/settings', label: 'Organization settings', group: 'Organization' },
    ...COLLABORATE,
  ],
  EMPLOYEE: [
    { path: '/ai/chat', label: 'AI Assistant', group: 'Overview' },
    { path: '/employee/queue', label: 'Office queue', group: 'Office work' },
    { path: '/scan', label: 'Scan to receive', group: 'Office work' },
    { path: '/employee/liaison', label: 'Release to messenger', group: 'Office work' },
    { path: '/documents', label: 'Office documents', group: 'Documents' },
    { path: '/documents/new', label: 'Upload document', group: 'Documents' },
    { path: '/employee/team', label: 'Staff & messengers', group: 'Team' },
    ...COLLABORATE,
  ],
  STAFF: [
    { path: '/ai/chat', label: 'AI Assistant', group: 'Overview' },
    { path: '/staff/approval', label: 'Approvals', group: 'Review' },
    { path: '/staff/view', label: 'Document view', group: 'Review' },
    { path: '/scan', label: 'Scan to receive', group: 'Review' },
    { path: '/documents', label: 'My uploads', group: 'Documents' },
    { path: '/documents/new', label: 'Upload document', group: 'Documents' },
    { path: '/staff/team', label: 'Messengers', group: 'Team' },
    ...COLLABORATE,
  ],
  LIAISON: [
    { path: '/scan', label: 'Scan QR', group: 'Deliveries' },
    { path: '/liaison/tracking', label: 'My deliveries', group: 'Deliveries' },
    ...COLLABORATE,
  ],
}

/** Every grantable path of a role. */
export const allPagesOf = (role: PageRole) => GRANTABLE_PAGES[role].map((p) => p.path)

/** The grantable page a path falls under (the most specific match), or null if the path is always open. */
export function pageFor(role: PageRole, path: string) {
  return (
    GRANTABLE_PAGES[role]
      .filter((p) => path === p.path || path.startsWith(`${p.path}/`))
      .sort((a, b) => b.path.length - a.path.length)[0] ?? null
  )
}

/**
 * May an account open this path? `access` null = unrestricted.
 * /documents/new is its own grant; other /documents/… pages (a document's detail) follow /documents.
 */
export function canOpenPage(role: PageRole, access: readonly string[] | null | undefined, path: string) {
  if (!access) return true
  const page = pageFor(role, path)
  return !page || access.includes(page.path)
}

/** Parse the stored column (JSON text) into a list, or null for unrestricted. */
export function parsePageAccess(value: unknown): string[] | null {
  if (value == null || value === '') return null
  try {
    const list = typeof value === 'string' ? JSON.parse(value) : value
    return Array.isArray(list) ? list.filter((p): p is string => typeof p === 'string') : null
  } catch {
    return null
  }
}
