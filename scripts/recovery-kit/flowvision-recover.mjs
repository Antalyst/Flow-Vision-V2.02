#!/usr/bin/env node
// FlowVision recovery kit — opens a FlowVision backup WITHOUT the FlowVision application.
// Needs only Node.js 18 or newer (https://nodejs.org); no npm install, no internet, no .env.
// It is copied next to the backups on the external drive. See README.md in this folder.
//
//   node flowvision-recover.mjs prepare <backup .zip.fvenc | .zip | folder> <empty output folder> [--passphrase-file <file>]
//       decrypt (asks for the passphrase when no file is given) → unzip → check every SHA-256 → unpack the
//       database dump to database/flowvision.sql, ready for the MariaDB client
//   node flowvision-recover.mjs decrypt <backup.zip.fvenc> <output.zip> [--passphrase-file <file>]
//   node flowvision-recover.mjs verify <unpacked folder>
//
// The package format ("flowvision-backup" v1) and the encryption format ("FVBKENC1") are described in README.md.
// Exit code 0 = done, 1 = failed (nothing is ever reported as good unless every check passed).
import crypto from 'node:crypto'
import fs from 'node:fs'
import fsp from 'node:fs/promises'
import path from 'node:path'
import readline from 'node:readline'
import zlib from 'node:zlib'
import { Transform } from 'node:stream'
import { pipeline } from 'node:stream/promises'

const fail = (msg) => {
  const e = new Error(msg)
  e.kit = true
  return e
}

// ---------------------------------------------------------------------------
// Decryption ("FVBKENC1", the same as server/lib/backup/crypto.ts)
//   header  "FVBKENC1" | version 1 | kdf 1 (scrypt) | log2 N | r | p | salt (16) | nonce prefix (8) | chunk size (u32 BE)
//   chunk   last-flag (u8) | length (u32 BE) | AES-256-GCM ciphertext | tag (16)
//           nonce = prefix | chunk counter (u32 BE); additional data = header | last-flag | counter (u32 BE)
//   key     scrypt(passphrase NFC, salt, 32 bytes, N = 2^log2N, r, p)
// ---------------------------------------------------------------------------
const MAGIC = Buffer.from('FVBKENC1')
const HEADER_BYTES = MAGIC.length + 5 + 16 + 8 + 4

function decryptStream(passphrase) {
  let buf = Buffer.alloc(0)
  let header = null
  let key = null
  let prefix = null
  let counter = 0
  let finished = false
  const nonce = (n) => {
    const b = Buffer.alloc(12)
    prefix.copy(b, 0)
    b.writeUInt32BE(n, 8)
    return b
  }
  const aad = (last, n) => {
    const t = Buffer.alloc(5)
    t.writeUInt8(last ? 1 : 0, 0)
    t.writeUInt32BE(n, 1)
    return Buffer.concat([header, t])
  }
  return new Transform({
    transform(chunk, _e, done) {
      try {
        buf = buf.length ? Buffer.concat([buf, chunk]) : chunk
        if (!header) {
          if (buf.length < HEADER_BYTES) return done()
          header = Buffer.from(buf.subarray(0, HEADER_BYTES))
          if (!header.subarray(0, 8).equals(MAGIC) || header[8] !== 1 || header[9] !== 1) throw fail('Not a FlowVision encrypted backup, or an unsupported version')
          const [log2N, r, p] = [header[10], header[11], header[12]]
          if (log2N > 20 || r > 16 || p > 4) throw fail('Unsupported encryption parameters')
          key = crypto.scryptSync(passphrase.normalize('NFC'), header.subarray(13, 29), 32, { N: 2 ** log2N, r, p, maxmem: 256 * 1024 * 1024 })
          prefix = header.subarray(29, 37)
          buf = buf.subarray(HEADER_BYTES)
        }
        while (buf.length >= 5) {
          if (finished) throw fail('Data after the end of the encrypted backup')
          const last = buf[0] === 1
          const len = buf.readUInt32BE(1)
          if (len > header.readUInt32BE(37)) throw fail('Corrupted encrypted backup (chunk too large)')
          if (buf.length < 5 + len + 16) break
          const d = crypto.createDecipheriv('aes-256-gcm', key, nonce(counter))
          d.setAAD(aad(last, counter))
          d.setAuthTag(buf.subarray(5 + len, 5 + len + 16))
          let plain
          try {
            plain = Buffer.concat([d.update(buf.subarray(5, 5 + len)), d.final()])
          } catch {
            throw fail('Decryption failed: wrong passphrase, or the backup is corrupted')
          }
          this.push(plain)
          buf = buf.subarray(5 + len + 16)
          counter++
          if (last) finished = true
        }
        done()
      } catch (err) {
        done(err)
      }
    },
    flush(done) {
      if (!finished || buf.length) return done(fail('The encrypted backup is truncated or has trailing data'))
      done()
    },
  })
}

async function isEncrypted(file) {
  const fd = await fsp.open(file, 'r')
  try {
    const head = Buffer.alloc(8)
    await fd.read(head, 0, 8, 0)
    return head.equals(MAGIC)
  } finally {
    await fd.close()
  }
}

async function decryptFile(src, dst, passphrase) {
  const partial = `${dst}.partial`
  try {
    await pipeline(fs.createReadStream(src), decryptStream(passphrase), fs.createWriteStream(partial))
    await fsp.rename(partial, dst)
  } catch (err) {
    await fsp.rm(partial, { force: true })
    throw err
  }
}

// ---------------------------------------------------------------------------
// Unzipping (stored or deflated entries, ZIP64), from the central directory
// ---------------------------------------------------------------------------
function safeRel(p) {
  if (!p || p.includes('\\') || p.startsWith('/') || /^[a-zA-Z]:/.test(p)) return false
  return !p.split('/').some((s) => s === '..' || s === '.' || s === '')
}

async function readAt(fd, pos, len) {
  const b = Buffer.alloc(len)
  const { bytesRead } = await fd.read(b, 0, len, pos)
  return b.subarray(0, bytesRead)
}

async function zipEntries(file) {
  const fd = await fsp.open(file, 'r')
  try {
    const size = (await fd.stat()).size
    const tailLen = Math.min(size, 65_557)
    const tail = await readAt(fd, size - tailLen, tailLen)
    let eocd = -1
    for (let i = tail.length - 22; i >= 0; i--) if (tail.readUInt32LE(i) === 0x06054b50) { eocd = i; break }
    if (eocd < 0) throw fail('Not a zip file, or it is truncated (no end-of-archive record)')
    let count = tail.readUInt16LE(eocd + 10)
    let cdSize = tail.readUInt32LE(eocd + 12)
    let cdOffset = tail.readUInt32LE(eocd + 16)
    if (count === 0xffff || cdSize === 0xffffffff || cdOffset === 0xffffffff) {
      const loc = eocd - 20
      if (loc < 0 || tail.readUInt32LE(loc) !== 0x07064b50) throw fail('Damaged ZIP64 archive (no locator)')
      const z64 = await readAt(fd, Number(tail.readBigUInt64LE(loc + 8)), 56)
      if (z64.readUInt32LE(0) !== 0x06064b50) throw fail('Damaged ZIP64 archive')
      count = Number(z64.readBigUInt64LE(32))
      cdSize = Number(z64.readBigUInt64LE(40))
      cdOffset = Number(z64.readBigUInt64LE(48))
    }
    const cd = await readAt(fd, cdOffset, cdSize)
    const out = []
    let p = 0
    for (let n = 0; n < count; n++) {
      if (cd.readUInt32LE(p) !== 0x02014b50) throw fail('Damaged zip central directory')
      const flags = cd.readUInt16LE(p + 8)
      const method = cd.readUInt16LE(p + 10)
      let comp = cd.readUInt32LE(p + 20)
      let uncomp = cd.readUInt32LE(p + 24)
      const nameLen = cd.readUInt16LE(p + 28)
      const extraLen = cd.readUInt16LE(p + 30)
      const commentLen = cd.readUInt16LE(p + 32)
      let local = cd.readUInt32LE(p + 42)
      const name = cd.subarray(p + 46, p + 46 + nameLen).toString(flags & 0x800 ? 'utf8' : 'latin1')
      const extra = cd.subarray(p + 46 + nameLen, p + 46 + nameLen + extraLen)
      for (let e = 0; e + 4 <= extra.length; ) {
        const id = extra.readUInt16LE(e)
        const len = extra.readUInt16LE(e + 2)
        if (id === 0x0001) {
          let q = e + 4
          if (uncomp === 0xffffffff) (uncomp = Number(extra.readBigUInt64LE(q)), (q += 8))
          if (comp === 0xffffffff) (comp = Number(extra.readBigUInt64LE(q)), (q += 8))
          if (local === 0xffffffff) local = Number(extra.readBigUInt64LE(q))
        }
        e += 4 + len
      }
      p += 46 + nameLen + extraLen + commentLen
      if (name.endsWith('/')) continue
      if (!safeRel(name)) throw fail(`Unsafe path inside the zip: ${name.slice(0, 120)}`)
      if (method !== 0 && method !== 8) throw fail(`Unsupported zip compression (method ${method}) for ${name}`)
      const lh = await readAt(fd, local, 30)
      if (lh.readUInt32LE(0) !== 0x04034b50) throw fail(`Damaged zip entry ${name}`)
      out.push({ name, method, comp, uncomp, data: local + 30 + lh.readUInt16LE(26) + lh.readUInt16LE(28) })
    }
    return out
  } finally {
    await fd.close()
  }
}

async function unzip(file, dir) {
  for (const e of await zipEntries(file)) {
    const dst = path.join(dir, ...e.name.split('/'))
    await fsp.mkdir(path.dirname(dst), { recursive: true })
    if (!e.comp) await fsp.writeFile(dst, '')
    else await pipeline(fs.createReadStream(file, { start: e.data, end: e.data + e.comp - 1 }), ...(e.method === 8 ? [zlib.createInflateRaw()] : []), fs.createWriteStream(dst))
    if ((await fsp.stat(dst)).size !== e.uncomp) throw fail(`${e.name} did not unpack completely`)
  }
}

// ---------------------------------------------------------------------------
// Verification (CHECKSUMS.sha256, manifest.json)
// ---------------------------------------------------------------------------
async function walk(root, rel = '') {
  const out = []
  for (const d of await fsp.readdir(path.join(root, rel), { withFileTypes: true })) {
    const r = rel ? `${rel}/${d.name}` : d.name
    if (d.isDirectory()) out.push(...(await walk(root, r)))
    else out.push(r)
  }
  return out
}

const sha256 = async (file) => {
  const h = crypto.createHash('sha256')
  await pipeline(fs.createReadStream(file), h)
  return h.digest('hex')
}

async function verify(dir, { ignore = [] } = {}) {
  const errors = []
  const sumsFile = path.join(dir, 'CHECKSUMS.sha256')
  if (!fs.existsSync(sumsFile) || !fs.existsSync(path.join(dir, 'manifest.json'))) throw fail('Not an unpacked FlowVision backup (CHECKSUMS.sha256 or manifest.json missing)')
  const sums = new Map()
  for (const line of (await fsp.readFile(sumsFile, 'utf8')).split(/\r?\n/)) {
    if (!line.trim()) continue
    const m = /^([0-9a-f]{64}) [ *](.+)$/.exec(line)
    if (!m) throw fail('CHECKSUMS.sha256 has a malformed line')
    sums.set(m[2], m[1])
  }
  const present = new Set((await walk(dir)).filter((p) => !ignore.includes(p)))
  for (const [rel, want] of sums) {
    if (!safeRel(rel)) errors.push(`Unsafe path in the checksums: ${rel.slice(0, 120)}`)
    else if (!present.has(rel)) errors.push(`Missing: ${rel}`)
    else if ((await sha256(path.join(dir, ...rel.split('/')))) !== want) errors.push(`Checksum mismatch: ${rel}`)
  }
  for (const rel of present) if (rel !== 'CHECKSUMS.sha256' && !sums.has(rel)) errors.push(`Not covered by the checksums: ${rel}`)
  const manifest = JSON.parse(await fsp.readFile(path.join(dir, 'manifest.json'), 'utf8'))
  if (manifest.format !== 'flowvision-backup' || manifest.format_version !== 1) errors.push('manifest.json is not a FlowVision backup v1')
  return { errors, manifest, files: sums.size }
}

// ---------------------------------------------------------------------------
// Commands
// ---------------------------------------------------------------------------
function askHidden(question) {
  if (!process.stdin.isTTY) throw fail('No passphrase: give --passphrase-file <file>, or run this in a terminal to type it')
  return new Promise((resolve) => {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout, terminal: true })
    rl._writeToOutput = (s) => (s.startsWith(question) ? process.stdout.write(s) : undefined)
    rl.question(question, (answer) => {
      rl.close()
      process.stdout.write('\n')
      resolve(answer)
    })
  })
}

async function passphrase(args) {
  const i = args.indexOf('--passphrase-file')
  if (i >= 0) {
    if (!args[i + 1]) throw fail('--passphrase-file needs a file')
    // Read like the backup tool: the file's text without one final line break.
    return (await fsp.readFile(args[i + 1], 'utf8')).replace(/\r?\n$/, '')
  }
  return askHidden('Backup passphrase: ')
}

const positional = (args) => args.filter((a, i) => !a.startsWith('--') && args[i - 1] !== '--passphrase-file')

async function emptyDir(dir) {
  const existing = await fsp.readdir(dir).catch(() => null)
  if (existing?.length) throw fail(`${dir} is not empty; give an empty (or new) folder`)
  await fsp.mkdir(dir, { recursive: true })
}

async function prepare(args) {
  const [src, out] = positional(args)
  if (!src || !out) throw fail('Usage: prepare <backup file or folder> <empty output folder> [--passphrase-file <file>]')
  const srcPath = path.resolve(src)
  const outDir = path.resolve(out)
  const stat = await fsp.stat(srcPath).catch(() => null)
  if (!stat) throw fail(`Not found: ${srcPath}`)
  await emptyDir(outDir)
  if (stat.isDirectory()) {
    console.log('Copying the unpacked backup (e.g. a Restic snapshot)…')
    await fsp.cp(srcPath, outDir, { recursive: true })
  } else {
    let zip = srcPath
    if (await isEncrypted(srcPath)) {
      const pass = await passphrase(args)
      zip = path.join(outDir, '.decrypted.zip')
      console.log('Decrypting (this checks every chunk against tampering)…')
      await decryptFile(srcPath, zip, pass)
    }
    console.log('Unzipping…')
    await unzip(zip, outDir)
    if (zip !== srcPath) await fsp.rm(zip, { force: true })
  }
  console.log('Checking every SHA-256…')
  const v = await verify(outDir)
  if (v.errors.length) {
    for (const e of v.errors.slice(0, 20)) console.error(`  error: ${e}`)
    throw fail('VERIFICATION FAILED: do not restore from this copy; try another backup')
  }
  const m = v.manifest
  let sql = path.join(outDir, ...m.database.dump_file.split('/'))
  if (m.database.compression === 'gzip') {
    const plain = sql.replace(/\.gz$/, '')
    console.log('Unpacking the database dump…')
    await pipeline(fs.createReadStream(sql), zlib.createGunzip(), fs.createWriteStream(plain))
    sql = plain
  }
  const fd = await fsp.open(sql, 'r')
  const end = await fd
    .stat()
    .then((s) => readAt(fd, Math.max(0, s.size - 300), 300))
    .finally(() => fd.close())
  if (!/-- Dump completed/.test(end.toString('latin1'))) throw fail('The database dump is incomplete (no "Dump completed" line)')
  console.log(`\nOK: ${m.name} (${m.created_at}) — ${m.database.engine} ${m.database.server_version}, ${m.database.tables.length} tables, ${v.files} checked entries.`)
  console.log(`Missing when the backup was made: ${m.files.missing.length} file(s)${m.files.missing.length ? ' (listed in manifest.json, files.missing)' : ''}.`)
  console.log('\nNext (see README.md):')
  console.log(`  1. Create an EMPTY database (utf8mb4) on a new MariaDB ${m.database.server_version.split('.').slice(0, 2).join('.')} or newer server.`)
  console.log(`  2. mariadb.exe --default-character-set=utf8mb4 -u <user> -p <database> < "${sql}"`)
  console.log(`  3. Uploaded files: ${m.files.in_package.length} in "${path.join(outDir, 'files')}" (UPLOAD_DIR), ${m.files.in_database.length} inside the database (file_blobs).`)
}

async function main() {
  const [command, ...args] = process.argv.slice(2)
  if (command === 'prepare') return prepare(args)
  if (command === 'decrypt') {
    const [src, dst] = positional(args)
    if (!src || !dst) throw fail('Usage: decrypt <backup.zip.fvenc> <output.zip> [--passphrase-file <file>]')
    if (fs.existsSync(dst)) throw fail(`${dst} already exists`)
    if (!(await isEncrypted(src))) throw fail(`${src} is not encrypted (it is a plain zip already)`)
    await decryptFile(path.resolve(src), path.resolve(dst), await passphrase(args))
    console.log(`Decrypted to ${dst}; every chunk passed its authentication check.`)
    return
  }
  if (command === 'verify') {
    const [dir] = positional(args)
    if (!dir) throw fail('Usage: verify <unpacked folder>')
    // After `prepare`, database/flowvision.sql is the unpacked copy of the checksummed .sql.gz.
    const unpackedDump = fs.existsSync(path.join(dir, 'database', 'flowvision.sql.gz')) ? ['database/flowvision.sql'] : []
    const v = await verify(path.resolve(dir), { ignore: unpackedDump })
    for (const e of v.errors.slice(0, 20)) console.error(`  error: ${e}`)
    if (v.errors.length) throw fail('VERIFICATION FAILED')
    console.log(`OK: every one of ${v.files} checksums matches (${v.manifest.name}).`)
    return
  }
  console.log('Usage:\n  node flowvision-recover.mjs prepare <backup> <empty folder> [--passphrase-file <file>]\n  node flowvision-recover.mjs decrypt <backup.zip.fvenc> <output.zip> [--passphrase-file <file>]\n  node flowvision-recover.mjs verify <unpacked folder>')
  if (command && command !== 'help') process.exitCode = 1
}

try {
  await main()
} catch (err) {
  console.error(err.kit ? `FAILED: ${err.message}` : `FAILED: ${err.message ?? err}`)
  process.exitCode = 1
}
