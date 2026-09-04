import { chmod, mkdir, readFile, realpath, writeFile } from 'node:fs/promises'
import { isAbsolute, relative, resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { reconstructYnab } from '../src/main/imports/ynab'

async function main(): Promise<void> {
  const [source, destination, currency = 'USD'] = process.argv.slice(2)
  if (!source || !destination)
    throw new Error(
      'Usage: npx tsx scripts/ynab-migration.ts SOURCE.zip PRIVATE_DESTINATION [CURRENCY]',
    )
  const root = await realpath(resolve(dirname(fileURLToPath(import.meta.url)), '..'))
  const target = resolve(destination)
  const relativePath = relative(root, target)
  const outside = (path: string): boolean =>
    path === '..' || path.startsWith('../') || isAbsolute(path)
  if (!outside(relativePath))
    throw new Error('Migration evidence must live outside the source repository')
  await mkdir(target, { recursive: true, mode: 0o700 })
  const actual = await realpath(target)
  const actualRelative = relative(root, actual)
  if (!outside(actualRelative))
    throw new Error('Migration evidence cannot resolve into the source repository')
  await chmod(actual, 0o700)
  try {
    const result = reconstructYnab(await readFile(source), currency)
    for (const [name, value] of [
      ['reconstructed.json', result.reconstructed],
      ['candidate.json', result.budget],
      ['report.json', result.report],
    ] as const) {
      await writeFile(resolve(actual, name), JSON.stringify(value, null, 2), {
        mode: 0o600,
        flag: 'wx',
      })
      await chmod(resolve(actual, name), 0o600)
    }
    console.log(
      JSON.stringify({
        accounts: result.report.accounts,
        transactions: result.report.transactions,
        months: result.report.months,
        replayedFiles: result.report.replayedFiles,
        uncategorized: result.report.uncategorized,
        errors: result.report.errors.length,
      }),
    )
    if (result.report.errors.length) process.exitCode = 1
  } catch (error) {
    await writeFile(
      resolve(actual, 'failure.txt'),
      String(error instanceof Error ? error.stack : error),
      { mode: 0o600, flag: 'wx' },
    )
    console.error('Migration failed; private diagnostic evidence was saved.')
    process.exitCode = 1
  }
}
void main().catch(() => {
  console.error('Migration setup failed; check source and private destination paths.')
  process.exitCode = 1
})
