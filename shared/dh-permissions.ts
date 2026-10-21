// Department Head permissions: what a *delegated* Department Head may do. Shared by the server (which
// enforces them) and the team page (which shows them).
//
//   Managing Department Head   created by the ADMIN for a main office (users.assigned_by NULL). Has every
//                              permission, always. Runs the office, its umbrella offices and its delegates.
//   Delegated Department Head  assigned by a Department Head (users.assigned_by set), to the main office or
//                              one of its umbrella offices. Has only the permissions in users.permissions,
//                              each granted explicitly. None by default.
// Permissions only narrow what the role already allows: every action still checks the organization, the
// office or umbrella the account belongs to, and the document's state.

export const DH_PERMISSIONS = [
  'RECEIVE_DOCUMENTS',
  'PASS_DOCUMENTS',
  'UMBRELLA_HANDOFF',
  'RELEASE_DOCUMENTS',
  'SEND_BACK_DOCUMENTS',
  'DECIDE_APPROVALS',
  'UPLOAD_DOCUMENTS',
  'MANAGE_TEAM',
  'MANAGE_UMBRELLAS',
  'MANAGE_INTERNAL_ROUTES',
  'ASSIGN_HEADS',
] as const
export type DhPermission = (typeof DH_PERMISSIONS)[number]

export const DH_PERMISSION_META: Record<DhPermission, { label: string; description: string; group: 'Documents' | 'Management' }> = {
  RECEIVE_DOCUMENTS: { label: 'Receive documents', description: 'Scan a document’s QR to receive it; replace a lost QR label', group: 'Documents' },
  PASS_DOCUMENTS: { label: 'Pass desk to desk', description: 'Pass a received document to the next staff of the office, or take it back', group: 'Documents' },
  UMBRELLA_HANDOFF: { label: 'Hand to umbrella offices', description: 'Hand a received document to one of the office’s umbrella units, or return it from the unit to its office', group: 'Documents' },
  RELEASE_DOCUMENTS: { label: 'Release to a messenger', description: 'Assign, change or cancel the messenger who carries a document onward', group: 'Documents' },
  SEND_BACK_DOCUMENTS: { label: 'Flag and send back', description: 'Send a document back to the previous office with a flagged issue', group: 'Documents' },
  DECIDE_APPROVALS: { label: 'Approve or return', description: 'Decide on documents waiting at the last office on a route (only where the office is one)', group: 'Documents' },
  UPLOAD_DOCUMENTS: { label: 'Upload documents', description: 'Upload and submit new documents', group: 'Documents' },
  MANAGE_TEAM: { label: 'Manage staff and messengers', description: 'Add, edit, suspend and reset staff and messenger accounts', group: 'Management' },
  MANAGE_UMBRELLAS: { label: 'Manage umbrella offices', description: 'Add, rename and deactivate umbrella offices (main office only)', group: 'Management' },
  MANAGE_INTERNAL_ROUTES: { label: 'Manage internal routes', description: 'Create, edit and deactivate the office’s internal routes through its umbrella offices (main office only)', group: 'Management' },
  ASSIGN_HEADS: { label: 'Assign Department Heads', description: 'Assign delegated Department Heads and grant them permissions they have themselves', group: 'Management' },
}

/** Granted to nobody by default; offered pre-ticked on the team page as a starting point. */
export const SUGGESTED_DELEGATE_PERMISSIONS: DhPermission[] = ['RECEIVE_DOCUMENTS', 'PASS_DOCUMENTS', 'RELEASE_DOCUMENTS', 'SEND_BACK_DOCUMENTS', 'UPLOAD_DOCUMENTS']

/** Only a main office has umbrella offices (and so internal routes): never granted to an umbrella's head. */
export const MAIN_OFFICE_ONLY: DhPermission[] = ['MANAGE_UMBRELLAS', 'MANAGE_INTERNAL_ROUTES']

/** Parse the stored column (JSON text) into a clean list; anything unknown is dropped. */
export function parsePermissions(value: unknown): DhPermission[] {
  if (value == null || value === '') return []
  try {
    const list = typeof value === 'string' ? JSON.parse(value) : value
    return Array.isArray(list) ? DH_PERMISSIONS.filter((p) => list.includes(p)) : []
  } catch {
    return []
  }
}
