// Issue categories and the priority each one gets. Shared by the server (which decides the priority — a
// priority sent by the browser is never used) and the issue forms (which show it, read-only).
//
// The mapping was chosen by the product owner on 2026-10-20. Issues reported before it keep the priority
// they were stored with; LOW and CRITICAL stay valid values for those, but no category assigns them now.

export const ISSUE_CATEGORIES = ['MISSING_DOCUMENT', 'DELAY', 'DAMAGE', 'INCORRECT_ROUTING', 'SYSTEM', 'OTHER'] as const
export type IssueCategory = (typeof ISSUE_CATEGORIES)[number]
export type IssuePriority = 'LOW' | 'MEDIUM' | 'HIGH' | 'CRITICAL'

export const ISSUE_CATEGORY_META: Record<IssueCategory, { label: string; priority: IssuePriority }> = {
  MISSING_DOCUMENT: { label: 'Missing document', priority: 'HIGH' },
  DAMAGE: { label: 'Damage', priority: 'HIGH' },
  INCORRECT_ROUTING: { label: 'Incorrect routing', priority: 'MEDIUM' },
  DELAY: { label: 'Delay', priority: 'MEDIUM' },
  SYSTEM: { label: 'System', priority: 'MEDIUM' },
  OTHER: { label: 'Other', priority: 'MEDIUM' },
}

/** The priority a new issue of this category gets. */
export const priorityOf = (category: IssueCategory): IssuePriority => ISSUE_CATEGORY_META[category].priority

/** "Other" needs a description of what is wrong (the other categories say it themselves). */
export const DESCRIPTION_REQUIRED: IssueCategory[] = ['OTHER']
export const ISSUE_DESCRIPTION_MAX = 5000
