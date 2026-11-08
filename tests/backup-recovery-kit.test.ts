/**
 * The recovery kit (scripts/recovery-kit/flowvision-recover.mjs) against the backup tool's own formats, and the
 * key-file rules (server/lib/backup/config.ts keyFileProblem). No database: `npm run test:backup-kit`.
 * The kit runs as a separate process from a folder of its own, with no FlowVision code or modules next to it.
 */
import { after, describe, it } from 'node:test'
import assert from 'node:assert/strict'
import crypto from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import zlib from 'node:zlib'
import { spawnSync } from 'node:child_process'
import { pipeline } from 'node:stream/promises'
import archiver from 'archiver'
import { encryptStream } from '../server/lib/backup/crypto.ts'
import { keyFileProblem } from '../server/lib/backup/config.ts'

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'fv-kit-test-'))
after(() => fs.rmSync(TMP, { recursive: true, force: true }))
// The kit alone, as it sits on the drive.
const KIT = path.join(TMP, 'drive', 'RECOVERY-KIT', 'flowvision-recover.mjs')
fs.mkdirSync(path.dirname(KIT), { recursive: true })
fs.copyFileSync(path.resolve(import.meta.dirname, '..', 'scripts', 'recovery-kit', 'flowvision-recover.mjs'), KIT)
const kit = (args: string[]) => {
  const r = spawnSync(process.execPath, [KIT, ...args], { cwd: TMP, encoding: 'utf8', env: { PATH: process.env.PATH, SystemRoot: process.env.SystemRoot } })
  return { code: r.status, out: `${r.stdout}${r.stderr}` }
}
const PASS = 'Kit-Test-Passphrase-1234'
const passFile = path.join(TMP, 'pass.txt')
fs.writeFileSync(passFile, `${PASS}\n`)
const sha = (b: Buffer) => crypto.createHash('sha256').update(b).digest('hex')

async function encrypt(src: string, dst: string, pass = PASS) {
  await pipeline(fs.createReadStream(src), encryptStream(pass), fs.createWriteStream(dst))
}

describe('decryption matches the backup tool', () => {
  const CHUNK = 1024 * 1024
  for (const size of [0, 1, CHUNK - 1, CHUNK, CHUNK + 1, 3 * CHUNK + 5]) {
    it(`${size} bytes`, async () => {
      const plain = path.join(TMP, `plain-${size}.bin`)
      const data = crypto.randomBytes(size)
      fs.writeFileSync(plain, data)
      const enc = `${plain}.fvenc`
      await encrypt(plain, enc)
      const out = path.join(TMP, `out-${size}.bin`)
      const r = kit(['decrypt', enc, out, '--passphrase-file', passFile])
      assert.equal(r.code, 0, r.out)
      assert.equal(sha(fs.readFileSync(out)), sha(data))
    })
  }

  it('a wrong passphrase, a flipped bit, a truncated or extended file: refused, and nothing is left behind', async () => {
    const plain = path.join(TMP, 'p.bin')
    fs.writeFileSync(plain, crypto.randomBytes(2 * 1024 * 1024 + 10))
    const enc = path.join(TMP, 'p.fvenc')
    await encrypt(plain, enc)
    const good = fs.readFileSync(enc)
    const wrong = path.join(TMP, 'wrong.txt')
    fs.writeFileSync(wrong, 'Kit-Test-Passphrase-1235')
    const cases: Array<[string, Buffer, string]> = [
      ['wrong', good, wrong],
      ['flipped', Buffer.from(good).fill(good[good.length - 100]! ^ 1, good.length - 100, good.length - 99), passFile],
      ['truncated', good.subarray(0, good.length - 1000), passFile],
      ['extended', Buffer.concat([good, Buffer.from('extra bytes')]), passFile],
    ]
    for (const [name, bytes, pf] of cases) {
      const f = path.join(TMP, `${name}.fvenc`)
      fs.writeFileSync(f, bytes)
      const out = path.join(TMP, `${name}.out`)
      const r = kit(['decrypt', f, out, '--passphrase-file', pf])
      assert.equal(r.code, 1, `${name}: ${r.out}`)
      assert.ok(!fs.existsSync(out) && !fs.existsSync(`${out}.partial`), `${name}: no output`)
    }
  })
})

/** A package laid out like the backup tool's: manifest, checksums, gzip dump, files. */
async function makePackage(zipFile: string, opts: { zip64?: boolean; deflate?: boolean; extra?: Array<[string, Buffer]>; dumpTail?: string } = {}) {
  const fileData = { 'files/3f1c2e4a-1111-4a2b-9c3d-000000000001/Ñiño résumé.pdf': Buffer.concat([Buffer.from('%PDF-1.4\n'), crypto.randomBytes(70_000)]), 'files/knowledge/3f1c2e4a-2222-4a2b-9c3d-000000000002/empty.txt': Buffer.alloc(0) }
  const dump = zlib.gzipSync(Buffer.from(`-- MariaDB dump\nCREATE TABLE t (id int);\n${opts.dumpTail ?? '-- Dump completed on 2026-11-08 20:00:01\n'}`))
  const manifest = Buffer.from(JSON.stringify({ format: 'flowvision-backup', format_version: 1, name: 'flowvision_full_2026-11-08_20-00-00', created_at: '2026-11-08T12:00:00.000Z', database: { engine: 'MariaDB', server_version: '11.8.3-MariaDB', dump_file: 'database/flowvision.sql.gz', compression: 'gzip', tables: ['t'] }, files: { in_package: Object.keys(fileData).map((k) => ({ key: k.slice(6) })), in_database: [], missing: [] } }))
  const entries: Array<[string, Buffer]> = [['manifest.json', manifest], ['RESTORE.md', Buffer.from('# Restore')], ['database/flowvision.sql.gz', dump], ...Object.entries(fileData)]
  const sums = Buffer.from(`${entries.map(([n, d]) => `${sha(d)} *${n}`).join('\n')}\n`)
  await new Promise<void>((resolve, reject) => {
    const out = fs.createWriteStream(zipFile)
    const z = archiver('zip', { store: !opts.deflate, forceZip64: Boolean(opts.zip64) })
    out.on('close', () => resolve())
    z.on('error', reject)
    z.pipe(out)
    for (const [n, d] of [...entries, ['CHECKSUMS.sha256', sums] as [string, Buffer], ...(opts.extra ?? [])]) z.append(d, { name: n })
    void z.finalize()
  })
  return fileData
}

describe('prepare: decrypt, unzip, check every checksum, unpack the dump', () => {
  for (const [label, opts] of [
    ['stored entries (as the backup tool writes them)', {}],
    ['ZIP64', { zip64: true }],
    ['deflated entries', { deflate: true }],
  ] as const) {
    it(label, async () => {
      const zip = path.join(TMP, `pkg-${label.length}.zip`)
      const fileData = await makePackage(zip, opts)
      const enc = `${zip}.fvenc`
      await encrypt(zip, enc)
      const out = path.join(TMP, `unpacked-${label.length}`)
      const r = kit(['prepare', enc, out, '--passphrase-file', passFile])
      assert.equal(r.code, 0, r.out)
      assert.match(r.out, /^OK:/m)
      for (const [n, d] of Object.entries(fileData)) assert.ok(fs.readFileSync(path.join(out, ...n.split('/'))).equals(d), n)
      assert.match(fs.readFileSync(path.join(out, 'database', 'flowvision.sql'), 'utf8'), /-- Dump completed/)
      assert.ok(!fs.existsSync(path.join(out, '.decrypted.zip')), 'the decrypted zip is removed')
      assert.equal(kit(['verify', out]).code, 0)
    })
  }

  it('a plain (unencrypted) zip needs no passphrase', async () => {
    const zip = path.join(TMP, 'plain-pkg.zip')
    await makePackage(zip)
    const r = kit(['prepare', zip, path.join(TMP, 'unpacked-plain')])
    assert.equal(r.code, 0, r.out)
  })

  it('refuses an unsafe path, a file not covered by the checksums, a changed file and an incomplete dump', async () => {
    // archiver cleans "../" out of names, so the hostile name is patched into the bytes (same length).
    const evil = path.join(TMP, 'evil.zip')
    await makePackage(evil, { extra: [['xx/outside.txt', Buffer.from('x')]] })
    const bytes = fs.readFileSync(evil)
    for (let i = bytes.indexOf('xx/outside.txt'); i !== -1; i = bytes.indexOf('xx/outside.txt', i + 1)) bytes.write('../', i)
    fs.writeFileSync(evil, bytes)
    const r1 = kit(['prepare', evil, path.join(TMP, 'u-evil')])
    assert.equal(r1.code, 1)
    assert.match(r1.out, /Unsafe path/)
    assert.ok(!fs.existsSync(path.join(TMP, 'outside.txt')))

    const extra = path.join(TMP, 'extra.zip')
    await makePackage(extra, { extra: [['files/3f1c2e4a-3333-4a2b-9c3d-000000000003/sneaky.pdf', Buffer.from('x')]] })
    const r2 = kit(['prepare', extra, path.join(TMP, 'u-extra')])
    assert.equal(r2.code, 1)
    assert.match(r2.out, /Not covered by the checksums/)

    const cut = path.join(TMP, 'cut.zip')
    await makePackage(cut, { dumpTail: '' })
    const r3 = kit(['prepare', cut, path.join(TMP, 'u-cut')])
    assert.equal(r3.code, 1)
    assert.match(r3.out, /dump is incomplete/)

    const ok = path.join(TMP, 'u-ok')
    assert.equal(kit(['prepare', path.join(TMP, 'plain-pkg.zip'), ok]).code, 0)
    const f = path.join(ok, 'RESTORE.md')
    fs.appendFileSync(f, 'changed')
    const r4 = kit(['verify', ok])
    assert.equal(r4.code, 1)
    assert.match(r4.out, /Checksum mismatch: RESTORE.md/)
  })

  it('refuses a non-empty output folder', async () => {
    const out = path.join(TMP, 'busy-out')
    fs.mkdirSync(out)
    fs.writeFileSync(path.join(out, 'keep.txt'), 'mine')
    const r = kit(['prepare', path.join(TMP, 'plain-pkg.zip'), out])
    assert.equal(r.code, 1)
    assert.equal(fs.readFileSync(path.join(out, 'keep.txt'), 'utf8'), 'mine')
  })
})

describe('key files that can be typed again on another computer', () => {
  const p = 'Correct-Horse-Battery-Staple-42'
  it('accepts one line of plain text, with or without a final line break', () => {
    for (const s of [p, `${p}\n`, `${p}\r\n`, 'Ñandú-pässwörd-ünïcode-1234']) assert.equal(keyFileProblem(Buffer.from(s)), null, s)
  })
  it('refuses what PowerShell 5.1 writes, and anything else that would not be retyped the same', () => {
    assert.match(keyFileProblem(Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from(p)]))!, /byte-order mark/)
    assert.match(keyFileProblem(Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(p, 'utf16le')]))!, /UTF-16/)
    assert.match(keyFileProblem(Buffer.from(p, 'utf16le'))!, /UTF-16/)
    assert.match(keyFileProblem(Buffer.from([0xc3, 0x28, 0x41, 0x42]))!, /not UTF-8/)
    assert.match(keyFileProblem(Buffer.from(`${p}\n${p}`))!, /more than one line/)
    assert.match(keyFileProblem(Buffer.from(`${p}\n\n`))!, /more than one line/)
    assert.match(keyFileProblem(Buffer.from(` ${p}`))!, /space/)
    assert.match(keyFileProblem(Buffer.from(`${p}\t`))!, /space|control/)
    assert.match(keyFileProblem(Buffer.from('short'))!, /shorter than 16/)
    assert.equal(keyFileProblem(Buffer.from('x'), 1), null, 'a Restic password may be short')
  })
})
