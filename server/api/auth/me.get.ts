import { serializeActor } from '~~/server/lib/auth.ts'

export default defineApiHandler(async (event) => {
  return { user: await serializeActor(await requireUser(event)) }
})
