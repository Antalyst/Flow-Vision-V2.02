import { modelStatus } from '~~/server/lib/ai-groq.ts'
import { ASSISTANT_ROLES } from '~~/server/lib/ai-tools.ts'

/** GET /api/ai/models — the automatic failover list: which free models are ready, which are resting. */
export default defineApiHandler(async (event) => {
  await requireUser(event, ...ASSISTANT_ROLES)
  return modelStatus()
})
