import { sequelize } from '~~/server/lib/models.ts'

export default defineEventHandler(async (event) => {
  try {
    await sequelize.authenticate()
    return { status: 'ok', database: 'up' }
  } catch {
    setResponseStatus(event, 503)
    return { status: 'degraded', database: 'down' }
  }
})
