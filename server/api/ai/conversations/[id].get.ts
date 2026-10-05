import { AiMessage } from '~~/server/lib/models.ts'
import { ASSISTANT_ROLES } from '~~/server/lib/ai-tools.ts'
import { ownConversation, serializeConversation, serializeMessage } from '~~/server/lib/ai-history.ts'

/** GET /api/ai/conversations/:id — one of the user's conversations with every message, oldest first. */
export default defineApiHandler(async (event) => {
  const actor = await requireUser(event, ...ASSISTANT_ROLES)
  const convo = await ownConversation(actor, routeParam(event, 'id'))
  const messages = await AiMessage.findAll({ where: { conversation_id: convo.id }, order: [['created_at', 'ASC']] })
  return { ...serializeConversation(convo), messages: messages.map(serializeMessage) }
})
