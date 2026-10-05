import { ASSISTANT_ROLES } from '~~/server/lib/ai-tools.ts'
import { ownConversation } from '~~/server/lib/ai-history.ts'

/** DELETE /api/ai/conversations/:id — removes the conversation and its messages (cascade). */
export default defineApiHandler(async (event) => {
  const actor = await requireUser(event, ...ASSISTANT_ROLES)
  const convo = await ownConversation(actor, routeParam(event, 'id'))
  await convo.destroy()
  return { ok: true }
})
