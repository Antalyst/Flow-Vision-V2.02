import { fullNameOf, loadActor, serializeActor } from '~~/server/lib/auth.ts'
import * as v from '~~/server/lib/validate.ts'

export default defineApiHandler(async (event) => {
  const user = await requireUser(event)
  const body = await readJson(event)
  const updates: Record<string, unknown> = {}
  if ('first_name' in body) updates.first_name = v.reqStr(body, 'first_name', { max: 100, label: 'First name' })
  if ('last_name' in body) updates.last_name = v.reqStr(body, 'last_name', { max: 100, label: 'Last name' })
  if ('phone' in body) updates.phone = v.str(body, 'phone', { max: 20 })
  // full_name feeds the database views; keep it in step with the parts.
  updates.full_name = fullNameOf((updates.first_name as string) ?? user.first_name, (updates.last_name as string) ?? user.last_name)
  await user.update(updates)
  return { user: await serializeActor((await loadActor(user.id))!) }
})
