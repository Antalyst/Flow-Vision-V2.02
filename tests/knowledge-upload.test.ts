/**
 * Knowledge-file upload parsing, without a database or an AI model.
 *
 *   npm run test:knowledge-upload
 *
 * Regression for "RangeError: Invalid array length" in h3's readMultipartFormData: it copies a file
 * into a plain JS array, which V8 can't grow past ~112 million elements, so files of ~108 MiB and
 * up failed. server/lib/multipart.ts reads uploads with the web-standard parser instead.
 *
 * The parser tests send real multipart requests over HTTP to a tiny h3 server (so the bytes travel
 * exactly as from the browser). The save/permission tests mock the database models.
 * Route-level checks (login required, ADMIN only, office scope) need the running app:
 * tests/knowledge-upload-api.test.ts.
 */
import { after, afterEach, before, describe, it, mock } from 'node:test'
import assert from 'node:assert/strict'
import { createServer, type Server } from 'node:http'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createApp, defineEventHandler, createError, toNodeListener, readMultipartFormData, type H3Event } from 'h3'

// Files are written to a throwaway folder; set before the app modules read the environment.
const UPLOADS = fs.mkdtempSync(path.join(os.tmpdir(), 'fv-knowledge-test-'))
process.env.UPLOAD_DIR = UPLOADS

const { readUploadParts } = await import('../server/lib/multipart.ts')
const { KnowledgeFile, Office } = await import('../server/lib/models.ts')
const { resolveKnowledgeOffice, readKnowledgeKind, saveKnowledgeFile } = await import('../server/lib/knowledge.ts')
const { canReadKnowledge, knowledgeWhere, resolveAiContext } = await import('../server/lib/ai-context.ts')

const MiB = 1024 * 1024
let server: Server
let base = ''
const seen: { reads: number } = { reads: 0 }

before(async () => {
  const app = createApp()
  // Parse and answer with a summary of the parts. ?max=<bytes> sets the size limit.
  app.use(
    '/parse',
    defineEventHandler(async (event: H3Event) => {
      const max = Number(new URL(event.node.req.url!, 'http://x').searchParams.get('max') || 5 * MiB)
      const parts = await readUploadParts(event, { maxBytes: max })
      if (!parts) return { parts: null }
      return { parts: parts.map((p) => ({ name: p.name, filename: p.filename, type: p.type, size: p.data.length, head: p.data.subarray(0, 16).toString('hex') })) }
    }),
  )
  // The same event parsed twice: the second call must reuse the first (a body can only be read once).
  app.use(
    '/twice',
    defineEventHandler(async (event: H3Event) => {
      seen.reads++
      const a = await readUploadParts(event, { maxBytes: 5 * MiB })
      const b = await readUploadParts(event, { maxBytes: 5 * MiB })
      return { same: a === b, count: a?.length ?? 0 }
    }),
  )
  app.use(
    '/h3-original',
    defineEventHandler(async (event: H3Event) => {
      try {
        await readMultipartFormData(event)
        return { ok: true }
      } catch (e) {
        return { ok: false, error: `${(e as Error).name}: ${(e as Error).message}` }
      }
    }),
  )
  app.use('/boom', defineEventHandler(() => { throw createError({ statusCode: 500 }) }))
  server = createServer(toNodeListener(app))
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r))
  base = `http://127.0.0.1:${(server.address() as { port: number }).port}`
})
after(async () => {
  server.close()
  fs.rmSync(UPLOADS, { recursive: true, force: true })
})
afterEach(() => mock.restoreAll())

const post = (url: string, body: BodyInit, headers: Record<string, string> = {}) => fetch(`${base}${url}`, { method: 'POST', body, headers })
const form = (file?: { name: string; type: string; data: Uint8Array | Buffer }, fields: Record<string, string> = {}) => {
  const f = new FormData()
  for (const [k, v] of Object.entries(fields)) f.append(k, v)
  if (file) f.append('file', new Blob([file.data as BlobPart], { type: file.type }), file.name)
  return f
}

describe('reading an upload', () => {
  it('a small TXT file with text fields', async () => {
    const res = await post('/parse', form({ name: 'charter.txt', type: 'text/plain', data: Buffer.from('Citizen’s Charter\nFees: PHP 500') }, { title: 'Charter 2026', office_id: '' }))
    const { parts } = await res.json()
    assert.equal(res.status, 200)
    assert.deepEqual(
      parts.map((p: any) => [p.name, p.filename, p.size]),
      [['title', undefined, 12], ['office_id', undefined, 0], ['file', 'charter.txt', Buffer.byteLength('Citizen’s Charter\nFees: PHP 500')]],
    )
    assert.equal(parts.at(-1).type, 'text/plain')
  })

  it('a PDF keeps every byte, including binary and boundary-like sequences', async () => {
    const data = Buffer.concat([Buffer.from('%PDF-1.7\r\n'), Buffer.from([0, 255, 13, 10, 45, 45, 0x80, 0xfe]), Buffer.from('\r\n--not-the-boundary\r\n'), Buffer.alloc(300_000, 0xab), Buffer.from('\r\n%%EOF')])
    const res = await post('/parse', form({ name: 'Citizen’s Charter 2026 — final.pdf', type: 'application/pdf', data }))
    const { parts } = await res.json()
    assert.equal(parts[0].size, data.length)
    assert.equal(parts[0].head, data.subarray(0, 16).toString('hex'))
    assert.equal(parts[0].filename, 'Citizen’s Charter 2026 — final.pdf')
    assert.equal(parts[0].type, 'application/pdf')
  })

  it('a file of 110 MiB (the size h3’s own parser failed on) is read', async () => {
    const res = await post('/parse', form({ name: 'big.pdf', type: 'application/pdf', data: Buffer.alloc(110 * MiB, 7) }), {})
    // the server's limit must allow it for this check
    assert.equal(res.status, 413) // 5 MiB default limit in this test route
    const ok = await post('/parse?max=' + 200 * MiB, form({ name: 'big.pdf', type: 'application/pdf', data: Buffer.alloc(110 * MiB, 7) }))
    const { parts } = await ok.json()
    assert.equal(ok.status, 200)
    assert.equal(parts[0].size, 110 * MiB)
  })

  it('the original parser really does fail on that size (documents why the helper exists)', async () => {
    const res = await post('/h3-original', form({ name: 'big.pdf', type: 'application/pdf', data: Buffer.alloc(110 * MiB, 7) }))
    assert.deepEqual(await res.json(), { ok: false, error: 'RangeError: Invalid array length' })
  })

  it('no file part: only the text fields come back', async () => {
    const { parts } = await (await post('/parse', form(undefined, { title: 'No file here' }))).json()
    assert.deepEqual(parts.map((p: any) => p.name), ['title'])
  })

  it('a request that is not multipart gives undefined (the route then asks for a file)', async () => {
    const json = await (await post('/parse', JSON.stringify({ a: 1 }), { 'content-type': 'application/json' })).json()
    assert.equal(json.parts, null)
    const none = await fetch(`${base}/parse`, { method: 'POST' })
    assert.equal((await none.json()).parts, null)
  })

  it('malformed multipart answers 400, not a server error', async () => {
    const garbage = await post('/parse', 'this is not a multipart body at all', { 'content-type': 'multipart/form-data; boundary=XYZ' })
    assert.equal(garbage.status, 400)
    const noBoundary = await post('/parse', 'x', { 'content-type': 'multipart/form-data' })
    assert.equal(noBoundary.status, 400)
    const truncated = await post('/parse', '--XYZ\r\nContent-Disposition: form-data; name="file"; filename="a.pdf"\r\n\r\nabc', { 'content-type': 'multipart/form-data; boundary=XYZ' })
    assert.equal(truncated.status, 400)
  })

  it('an oversized upload answers 413 from its declared size', async () => {
    const res = await post('/parse?max=' + 1 * MiB, form({ name: 'a.pdf', type: 'application/pdf', data: Buffer.alloc(3 * MiB, 1) }))
    assert.equal(res.status, 413)
    assert.equal((await res.json()).data?.code, 'PAYLOAD_TOO_LARGE')
  })

  it('the body is parsed once: asking twice returns the same parts', async () => {
    const res = await post('/twice', form({ name: 'a.txt', type: 'text/plain', data: Buffer.from('hello') }, { title: 't' }))
    assert.deepEqual(await res.json(), { same: true, count: 2 })
    assert.equal(seen.reads, 1)
  })
})

describe('saving a knowledge file (models mocked)', () => {
  const txt = (content: string) => ({ filename: 'charter.txt', type: 'text/plain', data: Buffer.from(content) })
  const input = { orgId: 'org-1', userId: 'admin-1', title: 'Charter', description: null }
  const capture = () => {
    const created: Record<string, any>[] = []
    mock.method(KnowledgeFile, 'create', async (row: Record<string, any>) => (created.push(row), row) as any)
    return created
  }

  it('stores office scope, charter kind, the text and the layout marker', async () => {
    const created = capture()
    await saveKnowledgeFile(txt('SERVICE ONE\nFees: PHP 100\nProcessing time: 1 day'), { ...input, officeId: 'office-a', kind: 'CITIZENS_CHARTER' })
    assert.equal(created[0]!.office_id, 'office-a')
    assert.equal(created[0]!.kind, 'CITIZENS_CHARTER')
    assert.equal(created[0]!.status, 'READY')
    assert.equal(created[0]!.index_version, 1)
    assert.match(created[0]!.content, /Fees: PHP 100/)
    assert.equal(created[0]!.org_id, 'org-1')
  })

  it('without a scope the file is organization-wide and GENERAL', async () => {
    const created = capture()
    await saveKnowledgeFile(txt('General policy text for everyone in the organization.'), input)
    assert.equal(created[0]!.office_id, null)
    assert.equal(created[0]!.kind, 'GENERAL')
  })

  it('a file with no readable text is saved as NO_TEXT (nothing for the AI to use)', async () => {
    const created = capture()
    await saveKnowledgeFile({ filename: 'scan.pdf', type: 'application/pdf', data: Buffer.from('%PDF-1.4 not a real readable pdf') }, input)
    assert.notEqual(created[0]!.status, 'READY')
    assert.equal(created[0]!.content, null)
  })

  it('rejects an unsupported type with 400 and an oversized file with 413', async () => {
    await assert.rejects(() => saveKnowledgeFile({ filename: 'x.exe', type: 'application/octet-stream', data: Buffer.from('MZ') }, input), (e: any) => e.statusCode === 400)
    const { env } = await import('../server/lib/env.ts')
    const original = env.maxKnowledgeBytes
    ;(env as any).maxKnowledgeBytes = 10
    try {
      await assert.rejects(() => saveKnowledgeFile(txt('this is longer than ten bytes'), input), (e: any) => e.statusCode === 413)
    } finally {
      ;(env as any).maxKnowledgeBytes = original
    }
  })
})

describe('who a knowledge upload may be scoped to, and who can then read it', () => {
  it('only an active office of the same organization can be chosen', async () => {
    const find = mock.method(Office, 'findOne', async () => null)
    await assert.rejects(() => resolveKnowledgeOffice('org-1', 'office-of-another-org'), (e: any) => e.statusCode === 400)
    const where = (find.mock.calls[0]!.arguments[0] as any).where
    assert.deepEqual([where.org_id, where.status], ['org-1', 'active'])
  })

  it('an empty office means organization-wide; an invalid kind is a 400', async () => {
    assert.equal(await resolveKnowledgeOffice('org-1', ''), null)
    assert.equal(await resolveKnowledgeOffice('org-1', undefined), null)
    assert.throws(() => readKnowledgeKind('SECRET'), (e: any) => e.statusCode === 400)
    assert.equal(readKnowledgeKind('citizens_charter'), 'CITIZENS_CHARTER')
  })

  it('office-scoped knowledge reaches its office and admins; organization-wide reaches everyone in the org; nothing crosses organizations', () => {
    const office = (id: string) => ({ id, org_id: 'org-1', name: id, code: id, status: 'active' })
    const user = (account_type: string, o: ReturnType<typeof office> | null, org = 'org-1') => resolveAiContext({ id: 'u', org_id: org, office_id: o?.id ?? null, office: o, account_type } as any)
    const officeFile = { org_id: 'org-1', office_id: 'records' }
    const orgFile = { org_id: 'org-1', office_id: null }
    assert.equal(canReadKnowledge(officeFile as any, user('STAFF', office('records'))), true)
    assert.equal(canReadKnowledge(officeFile as any, user('STAFF', office('hr'))), false)
    assert.equal(canReadKnowledge(officeFile as any, user('ADMIN', null)), true)
    assert.equal(canReadKnowledge(orgFile as any, user('STAFF', office('hr'))), true)
    assert.equal(canReadKnowledge(orgFile as any, user('ADMIN', null, 'org-2')), false)
    assert.deepEqual((knowledgeWhere(user('STAFF', null)) as any).office_id, null)
  })
})
