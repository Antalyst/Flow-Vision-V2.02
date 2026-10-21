import crypto from 'node:crypto'
import { Transform, type TransformCallback } from 'node:stream'

/**
 * Optional encryption of a backup package: AES-256-GCM in authenticated chunks, the key derived
 * from a passphrase with scrypt. Any change, reordering or truncation of the file makes decryption
 * fail; it never returns partial plaintext as if it were complete.
 *
 *   header  "FVBKENC1" | version 1 | kdf 1 (scrypt) | log2 N | r | p | salt (16) | nonce prefix (8) | chunk size (u32)
 *   chunk   last-flag (u8) | length (u32) | ciphertext | GCM tag (16)
 *           nonce = prefix | chunk counter (u32); additional data = header | last-flag | counter
 *
 * The passphrase is the only key: keep a copy of it somewhere other than the backup drive
 * (see docs/BACKUP_AND_RECOVERY.md). Without it an encrypted backup cannot be restored.
 */

const MAGIC = Buffer.from('FVBKENC1')
const HEADER_BYTES = MAGIC.length + 5 + 16 + 8 + 4
const CHUNK = 1024 * 1024
const TAG = 16
const SCRYPT = { log2N: 17, r: 8, p: 1 }

const deriveKey = (passphrase: string, salt: Buffer, log2N: number, r: number, p: number) =>
  crypto.scryptSync(passphrase.normalize('NFC'), salt, 32, { N: 2 ** log2N, r, p, maxmem: 256 * 1024 * 1024 })

const nonceOf = (prefix: Buffer, counter: number) => {
  const nonce = Buffer.alloc(12)
  prefix.copy(nonce, 0)
  nonce.writeUInt32BE(counter, 8)
  return nonce
}
const aadOf = (header: Buffer, last: boolean, counter: number) => {
  const tail = Buffer.alloc(5)
  tail.writeUInt8(last ? 1 : 0, 0)
  tail.writeUInt32BE(counter, 1)
  return Buffer.concat([header, tail])
}

export function checkPassphrase(passphrase: string | null | undefined) {
  if (!passphrase || passphrase.trim().length < 16) throw new Error('The backup passphrase must be at least 16 characters')
}

export function encryptStream(passphrase: string): Transform {
  checkPassphrase(passphrase)
  const salt = crypto.randomBytes(16)
  const prefix = crypto.randomBytes(8)
  const header = Buffer.alloc(HEADER_BYTES)
  MAGIC.copy(header, 0)
  header.writeUInt8(1, 8)
  header.writeUInt8(1, 9)
  header.writeUInt8(SCRYPT.log2N, 10)
  header.writeUInt8(SCRYPT.r, 11)
  header.writeUInt8(SCRYPT.p, 12)
  salt.copy(header, 13)
  prefix.copy(header, 29)
  header.writeUInt32BE(CHUNK, 37)
  const key = deriveKey(passphrase, salt, SCRYPT.log2N, SCRYPT.r, SCRYPT.p)
  let counter = 0
  let pending: Buffer = Buffer.alloc(0)
  let started = false

  const seal = (plain: Buffer, last: boolean) => {
    if (counter >= 0xffffffff) throw new Error('Backup too large to encrypt')
    const cipher = crypto.createCipheriv('aes-256-gcm', key, nonceOf(prefix, counter))
    cipher.setAAD(aadOf(header, last, counter))
    const body = Buffer.concat([cipher.update(plain), cipher.final()])
    const frame = Buffer.alloc(5)
    frame.writeUInt8(last ? 1 : 0, 0)
    frame.writeUInt32BE(body.length, 1)
    counter++
    return Buffer.concat([frame, body, cipher.getAuthTag()])
  }

  return new Transform({
    transform(chunk: Buffer, _enc, done: TransformCallback) {
      try {
        if (!started) {
          this.push(header)
          started = true
        }
        pending = pending.length ? Buffer.concat([pending, chunk]) : chunk
        // Keep at least one byte back: the final chunk must be the one marked last.
        while (pending.length > CHUNK) {
          this.push(seal(pending.subarray(0, CHUNK), false))
          pending = pending.subarray(CHUNK)
        }
        done()
      } catch (err) {
        done(err as Error)
      }
    },
    flush(done: TransformCallback) {
      try {
        if (!started) this.push(header)
        this.push(seal(pending, true))
        done()
      } catch (err) {
        done(err as Error)
      }
    },
  })
}

export const isEncryptedHeader = (start: Buffer) => start.length >= MAGIC.length && start.subarray(0, MAGIC.length).equals(MAGIC)

export function decryptStream(passphrase: string): Transform {
  let buf: Buffer = Buffer.alloc(0)
  let header: Buffer | null = null
  let key: Buffer | null = null
  let prefix: Buffer | null = null
  let counter = 0
  let finished = false

  return new Transform({
    transform(chunk: Buffer, _enc, done: TransformCallback) {
      try {
        buf = buf.length ? Buffer.concat([buf, chunk]) : chunk
        if (!header) {
          if (buf.length < HEADER_BYTES) return done()
          header = Buffer.from(buf.subarray(0, HEADER_BYTES))
          if (!isEncryptedHeader(header) || header.readUInt8(8) !== 1 || header.readUInt8(9) !== 1) throw new Error('Not a FlowVision encrypted backup, or an unsupported version')
          const [log2N, r, p] = [header.readUInt8(10), header.readUInt8(11), header.readUInt8(12)]
          if (log2N > 20 || r > 16 || p > 4) throw new Error('Unsupported encryption parameters')
          key = deriveKey(passphrase, header.subarray(13, 29), log2N, r, p)
          prefix = header.subarray(29, 37)
          buf = buf.subarray(HEADER_BYTES)
        }
        while (buf.length >= 5) {
          if (finished) throw new Error('Data after the end of the encrypted backup')
          const last = buf.readUInt8(0) === 1
          const len = buf.readUInt32BE(1)
          if (len > header!.readUInt32BE(37)) throw new Error('Corrupted encrypted backup (chunk too large)')
          if (buf.length < 5 + len + TAG) break
          const decipher = crypto.createDecipheriv('aes-256-gcm', key!, nonceOf(prefix!, counter))
          decipher.setAAD(aadOf(header!, last, counter))
          decipher.setAuthTag(buf.subarray(5 + len, 5 + len + TAG))
          let plain: Buffer
          try {
            plain = Buffer.concat([decipher.update(buf.subarray(5, 5 + len)), decipher.final()])
          } catch {
            throw new Error('Decryption failed: wrong passphrase, or the backup is corrupted')
          }
          this.push(plain)
          buf = buf.subarray(5 + len + TAG)
          counter++
          if (last) finished = true
        }
        done()
      } catch (err) {
        done(err as Error)
      }
    },
    flush(done: TransformCallback) {
      if (!finished || buf.length) return done(new Error('The encrypted backup is truncated or has trailing data'))
      done()
    },
  })
}
