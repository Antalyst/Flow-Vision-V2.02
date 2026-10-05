import { Document, User } from './models.ts'

const userAttrs = ['id', 'first_name', 'last_name', 'full_name', 'email', 'account_type']

/** Issues have no org column; they're scoped through their (required) document. */
export const issueIncludes = (orgId: string) => [
  { model: Document, as: 'document', attributes: ['id', 'title', 'status'], where: { org_id: orgId }, required: true },
  { model: User, as: 'reporter', attributes: userAttrs },
  { model: User, as: 'assignee', attributes: userAttrs },
]
