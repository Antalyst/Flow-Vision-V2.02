import { ASSISTANT_ROLES } from '~~/server/lib/ai-tools.ts'
import { resolveAiContext, scopeDescription } from '~~/server/lib/ai-context.ts'
import { knowledgeCatalog } from '~~/server/lib/ai-knowledge.ts'

/**
 * GET /api/ai/context — what the assistant's knowledge searches cover for the signed-in user,
 * as the server resolves it (the chat page shows it). Only files this user may read are counted.
 */
export default defineApiHandler(async (event) => {
  const actor = await requireUser(event, ...ASSISTANT_ROLES)
  const ctx = resolveAiContext(actor)
  const files = await knowledgeCatalog(ctx)
  return {
    office: ctx.office ? { name: ctx.office.name, code: ctx.office.code } : null,
    office_issue: ctx.officeIssue === 'NONE' ? null : ctx.officeIssue,
    all_offices: ctx.allOffices,
    scope: scopeDescription(ctx),
    knowledge_files: files.length,
    charter_files: files.filter((f) => f.charter).length,
  }
})
