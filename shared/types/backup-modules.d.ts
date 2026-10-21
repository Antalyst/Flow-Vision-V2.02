// Minimal types for the two archive libraries the backup tool uses (no @types packages installed).

declare module 'archiver' {
  import type { Writable } from 'node:stream'
  interface Archiver {
    pipe(dest: Writable): Writable
    file(path: string, data: { name: string }): Archiver
    finalize(): Promise<void>
    on(event: 'error' | 'warning', listener: (err: Error) => void): Archiver
  }
  function archiver(format: 'zip', options?: { store?: boolean; zlib?: { level?: number } }): Archiver
  export default archiver
}

declare module 'unzipper' {
  import type { Readable } from 'node:stream'
  interface Entry {
    path: string
    type: 'File' | 'Directory'
    uncompressedSize: number
    stream(): Readable
  }
  const unzipper: { Open: { file(path: string): Promise<{ files: Entry[] }> } }
  export default unzipper
}
