import { Document, User } from './models.ts'
import { badRequest } from './errors.ts'
import * as v from './validate.ts'
import { DESCRIPTION_REQUIRED, ISSUE_CATEGORIES, ISSUE_DESCRIPTION_MAX, priorityOf } from '../../shared/issue-categories.ts'

const userAttrs = ['id', 'first_name', 'last_name', 'full_name', 'email', 'account_type']

/** Issues have no org column; they're scoped through their (required) document. */
export const issueIncludes = (orgId: string) => [
  { model: Document, as: 'document', attributes: ['id', 'title', 'status'], where: { org_id: orgId }, required: true },
  { model: User, as: 'reporter', attributes: userAttrs },
  { model: User, as: 'assignee', attributes: userAttrs },
]

/**
 * A new issue from a request body: title, category (required, one of ISSUE_CATEGORIES) and description —
 * required for "Other" (what is wrong with the document). The priority comes from the category
 * (shared/issue-categories.ts); a `severity` or `priority` sent by the browser is ignored.
 */
export function readIssueInput(body: Record<string, unknown>) {
  const title = v.reqStr(body, 'title', { label: 'Title' })
  const category = v.oneOf(body, 'category', ISSUE_CATEGORIES, { required: true })!
  const description = v.str(body, 'description', { max: ISSUE_DESCRIPTION_MAX, label: 'Description' })
  if (DESCRIPTION_REQUIRED.includes(category) && !description) {
    throw badRequest('Describe what’s wrong with the document', { field: 'description' })
  }
  return { title, category, description, priority: priorityOf(category) }
}
