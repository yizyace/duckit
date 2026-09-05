import { open, rename, rm, mkdir } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { randomUUID } from 'node:crypto'
/** Returns false if the new file is visible but directory durability could not be confirmed.
 * Once rename succeeds, callers must treat the new value as active even if fsync fails. */
export async function atomicWrite(file: string, contents: Uint8Array | string): Promise<boolean> {
  await mkdir(dirname(file), { recursive: true, mode: 0o700 })
  const temporary = join(dirname(file), `.${randomUUID()}.pending`)
  let committed = false
  try {
    const handle = await open(temporary, 'wx', 0o600)
    try {
      await handle.writeFile(contents)
      await handle.sync()
    } finally {
      await handle.close()
    }
    await rename(temporary, file)
    committed = true
    try {
      const directory = await open(dirname(file), 'r')
      try {
        await directory.sync()
      } finally {
        await directory.close()
      }
      return true
    } catch {
      return false
    }
  } finally {
    if (!committed) await rm(temporary, { force: true }).catch(() => {})
  }
}
