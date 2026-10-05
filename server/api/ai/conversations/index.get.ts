import { AiConversation } from '~~/server/lib/models.ts'
import { ASSISTANT_ROLES } from '~~/server/lib/ai-tools.ts'
import { MAX_CONVERSATIONS, serializeConversation } from '~~/server/lib/ai-history.ts'

/** GET /api/ai/conversations — the signed-in user's own AI conversations, most recent first. */
export default defineApiHandler(async (event) => {
  const actor = await requireUser(event, ...ASSISTANT_ROLES)
  const rows = await AiConversation.findAll({
    where: { user_id: actor.id },
    order: [['updated_at', 'DESC']],
    limit: MAX_CONVERSATIONS,
  })
  return { data: rows.map(serializeConversation) }
})
