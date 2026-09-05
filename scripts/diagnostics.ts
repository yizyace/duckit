import { execFile } from 'node:child_process'
import { mkdtemp, readFile, realpath, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { isAbsolute, join, resolve } from 'node:path'
import { promisify } from 'node:util'
import { z } from 'zod'
import { environment, prepareRuntime, runDolt } from '../src/main/storage/runtime'
import { tables } from '../src/main/storage/schema'

const usage =
  'Usage: npm run diagnostics -- --root=/absolute/application-data [--runtime=/absolute/runtime] [--table=accounts]'
const allowed = new Set([
  ...tables.map((table) => table.name),
  'command_receipts',
  'undo_history',
  'write_guard',
])

async function main() {
  const options = new Map<string, string>()
  for (const argument of process.argv.slice(2)) {
    if (argument === '--help') return console.log(usage)
    const match = /^--(root|runtime|table)=(.+)$/.exec(argument)
    if (!match || options.has(match[1]!)) throw new Error(usage)
    options.set(match[1]!, match[2]!)
  }
  const requestedRoot = options.get('root')
  if (!requestedRoot || !isAbsolute(requestedRoot)) throw new Error(usage)
  const root = await realpath(requestedRoot)
  const directory = options.get('runtime') ?? resolve('resources/runtime', process.arch)
  if (!isAbsolute(directory)) throw new Error('The runtime directory must be absolute')
  const table = options.get('table')
  if (table && !allowed.has(table))
    throw new Error(`Unknown table. Choose: ${[...allowed].join(', ')}`)
  const stateRoot = await mkdtemp(join(tmpdir(), 'duckit-diagnostics-'))
  const runtime = { directory, stateRoot }
  try {
    // Only this disposable runtime configuration is written. No budget setup, migration,
    // checkpoint, arbitrary SQL, financial row dump, or network operation is performed.
    await prepareRuntime(runtime)
    const exec = promisify(execFile)
    const env = { ...environment(runtime), HOME: stateRoot, CFFIXED_USER_HOME: stateRoot }
    const versions = {
      dolt: (await runDolt(runtime, stateRoot, ['version'])).trim(),
      git: (
        await exec(join(directory, 'git/bin/git'), ['--version'], { env, timeout: 10000 })
      ).stdout.trim(),
      gcm: (
        await exec(join(directory, 'git/libexec/git-core/git-credential-manager'), ['--version'], {
          env,
          timeout: 10000,
        })
      ).stdout.trim(),
    }
    let pointer: { database: string }
    try {
      pointer = z
        .object({ database: z.string().uuid() })
        .parse(JSON.parse(await readFile(join(root, 'active.json'), 'utf8')))
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        console.log(JSON.stringify({ root, versions, activeBudget: false }, null, 2))
        return
      }
      throw error
    }
    const budgets = await realpath(join(root, 'budgets'))
    const database = await realpath(join(budgets, pointer.database))
    if (database !== join(budgets, pointer.database))
      throw new Error('Active pointer escapes its budget directory')
    const query = async (sql: string) =>
      JSON.parse(
        await runDolt(runtime, database, [
          'sql',
          '--disable-auto-gc',
          '--result-format',
          'json',
          '--query',
          sql,
        ]),
      ).rows as Record<string, unknown>[]
    const meta = await query('SELECT schemaVersion, revision, currency FROM budget_meta;')
    const existing = (await query('SHOW TABLES;')).map((row) => String(Object.values(row)[0]))
    const selected = table ? [table] : [...allowed].filter((name) => existing.includes(name))
    if (table && !existing.includes(table))
      throw new Error('The selected table is absent in this database version')
    const counts = await query(
      selected
        .map(
          (name) =>
            `SELECT '${name}' AS table_name, CAST(COUNT(*) AS CHAR) AS row_count FROM \`${name}\``,
        )
        .join(' UNION ALL ') + ';',
    )
    const columns = table ? await query(`SHOW COLUMNS FROM \`${table}\`;`) : undefined
    console.log(
      JSON.stringify(
        {
          root,
          versions,
          activeBudget: true,
          metadata: meta,
          tables: counts,
          ...(columns ? { columns } : {}),
        },
        null,
        2,
      ),
    )
  } finally {
    await rm(stateRoot, { recursive: true, force: true, maxRetries: 3 })
  }
}
main().catch((error: unknown) => {
  // Never emit child-process objects: their output could contain private SQL values.
  console.error(error instanceof Error ? error.message : 'Diagnostics failed')
  process.exitCode = 1
})
