import fs from 'node:fs'
import fsp from 'node:fs/promises'
import path from 'node:path'
import { BackupError } from './config.ts'

/**
 * The recovery kit (scripts/recovery-kit): a dependency-free Node script and its instructions, kept in
 * RECOVERY-KIT\ on every backup destination, so a new computer can decrypt, check and unpack a backup with
 * only the drive, the passphrase, Node.js and the MariaDB tools — not this application.
 * These two files are the only ones the tool ever replaces on a destination (with a newer kit).
 */

export const KIT_DIR = 'RECOVERY-KIT'
const KIT_FILES = ['flowvision-recover.mjs', 'README.md']

function kitSource() {
  const candidates = [path.join(process.cwd(), 'scripts', 'recovery-kit'), path.resolve(import.meta.dirname ?? '.', '..', '..', '..', 'scripts', 'recovery-kit')]
  return candidates.find((dir) => KIT_FILES.every((f) => fs.existsSync(path.join(dir, f)))) ?? null
}

export async function installRecoveryKit(destination: string) {
  const source = kitSource()
  if (!source) throw new BackupError('KIT_MISSING', 'The recovery kit (scripts/recovery-kit) was not found next to the application; run the backup from the FlowVision folder')
  const dir = path.join(destination, KIT_DIR)
  await fsp.mkdir(dir, { recursive: true })
  let written = 0
  for (const f of KIT_FILES) {
    const data = await fsp.readFile(path.join(source, f))
    const target = path.join(dir, f)
    const current = await fsp.readFile(target).catch(() => null)
    if (current?.equals(data)) continue
    const partial = `${target}.partial`
    await fsp.writeFile(partial, data)
    await fsp.rename(partial, target)
    written++
  }
  return { dir, written }
}
