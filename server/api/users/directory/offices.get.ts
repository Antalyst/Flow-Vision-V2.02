import { directoryCards } from '~~/server/lib/directory.ts'

/** Office cards of the team pages' users browser: the offices this account may browse, with account counts per role. */
export default defineApiHandler(async (event) => {
  const actor = await requireUser(event, 'ADMIN', 'DEPARTMENT_HEAD')
  return directoryCards(actor)
})
