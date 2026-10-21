// Copies attachment files that exist only in the local uploads/ folder into file_blobs, so a
// document created locally can be downloaded on Vercel. Only keys that have no blob rows yet are
// added; nothing existing is changed. Dry run by default.
//   node scripts/push-local-uploads.ts            (list what would be copied)
//   node scripts/push-local-uploads.ts --apply    (copy it)
// The target is whatever DB_* in .env points at, so check that before using --apply.
import fs from 'node:fs/promises'
import path from 'node:path'
import { QueryTypes } from 'sequelize'

try {
  process.loadEnvFile('.env')
} catch {
  /* no .env — rely on the environment */
}
process.env.FILE_STORAGE = 'db'
const { env } = await import('../server/lib/env.ts')
const { sequelize } = await import('../server/lib/db.ts')
const { putFile } = await import('../server/lib/file-store.ts')

const apply = process.argv.includes('--apply')
const root = path.resolve(process.cwd(), process.env.UPLOAD_DIR || 'uploads')
const UUID_RE = /^[0-9a-f-]{36}$/

console.log(`[push-uploads] target db ${env.db.host}:${env.db.port}/${env.db.name} — ${apply ? 'APPLY' : 'dry run'}`)

try {
  for (const dir of await fs.readdir(root)) {
    if (!UUID_RE.test(dir)) continue // skips knowledge/ and org/
    for (const name of await fs.readdir(path.join(root, dir))) {
      const key = `${dir}/${name}`
      const [row] = await sequelize.query<{ n: number }>('SELECT COUNT(*) AS n FROM file_blobs WHERE file_url = ?', { replacements: [key], type: QueryTypes.SELECT })
      if (Number(row?.n)) {
        console.log(`  have   ${key}`)
        continue
      }
      const data = await fs.readFile(path.join(root, dir, name))
      if (apply) await putFile(key, data)
      console.log(`  ${apply ? 'copied' : 'would copy'} ${key} (${data.length} bytes)`)
    }
  }
} finally {
  await sequelize.close()
}
