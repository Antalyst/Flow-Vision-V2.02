import fs from 'node:fs'
import fsp from 'node:fs/promises'
import path from 'node:path'
import { Readable } from 'node:stream'
import { QueryTypes } from 'sequelize'
import { sequelize } from './db.ts'
import { env } from './env.ts'

/**
 * Where attachment and knowledge-file bytes live, keyed by their file_url ("<uuid>/<name>" or
 * "knowledge/<uuid>/<name>"). Locally that's UPLOAD_DIR on disk. Serverless hosts (Vercel) have a
 * read-only, throwaway disk, so there the bytes go into the `file_blobs` table instead.
 * Reads look in both places, so a local server also opens files uploaded on the live site.
 * Callers validate the key (uploadKey / knowledgeKey) before it gets here.
 *
 * In file_blobs a file is a run of parts of at most PART_BYTES, so no query moves a whole file and
 * a download streams out part by part. Vercel takes at most 4.5 MB per request, so large uploads
 * also arrive in parts: they're "staged" (complete = 0, owned by the uploader) until attached.
 */

export const PART_BYTES = 3 * 1024 * 1024

const diskPath = (key: string) => path.join(env.uploadDir, ...key.split('/'))

/**
 * Reads retry once: the hosted MySQL now and then drops a connection mid-transfer (ECONNRESET),
 * and a part is a few MB, so a dropped read is worth one more try on a fresh connection.
 */
async function select<T extends object>(sql: string, replacements: unknown[]): Promise<T[]> {
  const run = () => sequelize.query<T>(sql, { replacements, type: QueryTypes.SELECT })
  try {
    return await run()
  } catch (err) {
    const code = (err as { parent?: { code?: string } }).parent?.code
    if (!code || !['ECONNRESET', 'PROTOCOL_CONNECTION_LOST', 'ETIMEDOUT', 'EPIPE'].includes(code)) throw err
    return run()
  }
}

async function insertPart(key: string, part: number, data: Buffer, { owner = null as string | null, complete = true } = {}) {
  await sequelize.query('INSERT INTO file_blobs (file_url, part, data, size, uploaded_by, complete) VALUES (?, ?, ?, ?, ?, ?)', {
    replacements: [key, part, data, data.length, owner, complete ? 1 : 0],
  })
}

export async function putFile(key: string, data: Buffer) {
  if (env.fileStorage === 'db') {
    for (let part = 0; part === 0 || part * PART_BYTES < data.length; part++) {
      await insertPart(key, part, data.subarray(part * PART_BYTES, (part + 1) * PART_BYTES))
    }
    return
  }
  await fsp.mkdir(path.dirname(diskPath(key)), { recursive: true })
  await fsp.writeFile(diskPath(key), data)
}

async function dbParts(key: string, complete = true) {
  return select<{ part: number; size: number }>('SELECT part, size FROM file_blobs WHERE file_url = ? AND complete = ? ORDER BY part', [key, complete ? 1 : 0])
}

async function openFromDb(key: string, complete = true) {
  const parts = await dbParts(key, complete)
  if (!parts.length) return null
  async function* read() {
    for (const { part } of parts) {
      const [row] = await select<{ data: Buffer }>('SELECT data FROM file_blobs WHERE file_url = ? AND part = ?', [key, part])
      if (row) yield row.data
    }
  }
  return { size: parts.reduce((n, p) => n + Number(p.size), 0), stream: Readable.from(read()) }
}

async function openFromDisk(key: string) {
  const stat = await fsp.stat(diskPath(key)).catch(() => null)
  return stat?.isFile() ? { size: stat.size, stream: fs.createReadStream(diskPath(key)) as Readable } : null
}

/** The file as a stream (sent part by part from the database), with its size; null if it's stored nowhere. */
export async function openFile(key: string): Promise<{ size: number; stream: Readable } | null> {
  if (env.fileStorage === 'db') return (await openFromDb(key)) ?? (await openFromDisk(key))
  return (await openFromDisk(key)) ?? (await openFromDb(key).catch(() => null))
}

const collect = async (file: { stream: Readable } | null) => (file ? Buffer.concat(await file.stream.toArray()) : null)

/** The whole file in memory (for reading its text), or null. */
export const getFile = async (key: string) => collect(await openFile(key))

export async function deleteFile(key: string) {
  await Promise.all([
    sequelize.query('DELETE FROM file_blobs WHERE file_url = ?', { replacements: [key] }).catch(() => {}),
    env.fileStorage === 'disk' ? fsp.rm(path.dirname(diskPath(key)), { recursive: true, force: true }).catch(() => {}) : null,
  ])
}

// ---------------------------------------------------------------------------
// Staged uploads: a large file arriving in parts, before it is attached to a document
// ---------------------------------------------------------------------------

/** How much of a staged upload has arrived, and whose it is. Null when nothing is staged under the key. */
export async function stagedInfo(key: string) {
  const [row] = await select<{ parts: number; bytes: number | null; owner: string | null }>(
    'SELECT COUNT(*) AS parts, SUM(size) AS bytes, MAX(uploaded_by) AS owner FROM file_blobs WHERE file_url = ? AND complete = 0',
    [key],
  )
  return row && Number(row.parts) ? { parts: Number(row.parts), bytes: Number(row.bytes ?? 0), owner: row.owner } : null
}

/** Add the next part of a staged upload. A part sent twice fails on the primary key. */
export const stagePart = (key: string, part: number, data: Buffer, owner: string) => insertPart(key, part, data, { owner, complete: false })

/** The staged upload's bytes (e.g. for the AI to read before the document is saved). */
export const readStaged = async (key: string) => collect(await openFromDb(key, false))

/** Attach a staged upload: it becomes an ordinary stored file (written to disk in disk mode). */
export async function commitStaged(key: string) {
  if (env.fileStorage === 'db') {
    await sequelize.query('UPDATE file_blobs SET complete = 1 WHERE file_url = ? AND complete = 0', { replacements: [key] })
    return
  }
  const data = await readStaged(key)
  if (data) await putFile(key, data)
  await sequelize.query('DELETE FROM file_blobs WHERE file_url = ?', { replacements: [key] })
}

/** Uploads started but never attached (the form was abandoned) are dropped after a day. */
export async function dropAbandonedStaged() {
  await sequelize.query('DELETE FROM file_blobs WHERE complete = 0 AND created_at < NOW() - INTERVAL 1 DAY').catch(() => {})
}
