import path from 'node:path'

// Read straight from process.env so the same code works inside Nitro and in the
// plain-Node scripts (scripts/*.ts). `nuxt dev` loads .env automatically; in
// production pass the variables in, e.g. `node --env-file=.env .output/server/index.mjs`.
const isProduction = process.env.NODE_ENV === 'production'

export const env = {
  isProduction,
  uploadDir: path.resolve(process.cwd(), process.env.UPLOAD_DIR || 'uploads'),
  maxUploadBytes: Number(process.env.MAX_UPLOAD_MB || 20) * 1024 * 1024,
  // AI knowledge files (Organization Settings) can be much larger than document attachments.
  maxKnowledgeBytes: Number(process.env.KNOWLEDGE_MAX_MB || 200) * 1024 * 1024,
  sessionDays: Number(process.env.SESSION_DAYS || 14),
  db: {
    host: process.env.DB_HOST || 'localhost',
    port: Number(process.env.DB_PORT || 3306),
    user: process.env.DB_USER || 'root',
    password: process.env.DB_PASS || '',
    name: process.env.DB_NAME || 'flowvision',
    logging: process.env.DB_LOGGING === 'true',
  },
}
