import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { readManifest, run, runtimeEnvironment, runtimePaths } from './runtime.ts'
import type { Architecture } from './runtime.ts'

// Synthetic release feasibility test. It never opens application budgets.
const root = process.cwd()
const args = process.argv.slice(2)
const arch = (args.find((arg) => arg.startsWith('--arch='))?.slice(7) ??
  process.arch) as Architecture
const github = args.find((arg) => arg.startsWith('--github='))?.slice(9)
assert(['arm64', 'x64'].includes(arch), 'Only macOS arm64 and x64 runtimes are supported')
assert(process.platform === 'darwin', 'This proof executes the bundled macOS runtime')
assert(
  args.every((arg) => /^(--arch=(arm64|x64)|--github=[\w.-]+\/[\w.-]+)$/.test(arg)),
  'Unsupported proof option',
)
const directory = await mkdtemp(path.join(tmpdir(), 'duckit-transport-'))
const runtime = runtimePaths(root, arch)
const environment = {
  ...runtimeEnvironment(root, arch, path.join(directory, 'dolt-state')),
  GIT_AUTHOR_NAME: 'Duckit QA',
  GIT_AUTHOR_EMAIL: 'qa@duckit.invalid',
  GIT_COMMITTER_NAME: 'Duckit QA',
  GIT_COMMITTER_EMAIL: 'qa@duckit.invalid',
}
const manifest = await readManifest(root)
const report: Record<string, unknown> = { architecture: arch, synthetic: true }
const options = (cwd: string) => ({
  cwd,
  env: environment,
  timeout: 90_000,
  maxBuffer: 8 * 1024 * 1024,
})
const git = async (cwd: string, ...gitArgs: string[]) =>
  (await run(runtime.git, gitArgs, options(cwd))).stdout.trim()
const dolt = async (cwd: string, ...doltArgs: string[]) =>
  (await run(runtime.dolt, doltArgs, options(cwd))).stdout.trim()
type Row = Record<string, string | number | null>
const sql = async (cwd: string, query: string): Promise<Row[]> => {
  const output = await dolt(cwd, 'sql', '-r', 'json', '-q', query)
  return output ? ((JSON.parse(output) as { rows?: Row[] }).rows ?? []) : []
}
const checkpoint = async (cwd: string, message: string) => {
  await dolt(cwd, 'add', '.')
  await dolt(cwd, 'commit', '--author', 'Duckit QA <qa@duckit.invalid>', '-m', message)
  const rows = await sql(cwd, "SELECT DOLT_HASHOF('HEAD') AS hash")
  assert(typeof rows[0]?.hash === 'string')
  return rows[0].hash
}
const identifier = (value: string) => `\`${value.replaceAll('`', '``')}\``
const tables = async (cwd: string, revision?: string) =>
  (await sql(cwd, `SHOW TABLES${revision ? ` AS OF '${revision}'` : ''}`))
    .map((row) => String(Object.values(row)[0]))
    .sort()
const snapshot = async (cwd: string) => {
  const state: Record<string, Row[]> = {}
  for (const table of await tables(cwd))
    state[table] = (await sql(cwd, `SELECT * FROM ${identifier(table)}`)).sort((a, b) =>
      JSON.stringify(a).localeCompare(JSON.stringify(b)),
    )
  return state
}
let remoteUrl: string | undefined
let remoteRef: string | undefined
let remoteCreated = false
let failure: unknown

try {
  await dolt(directory, 'config', '--global', '--add', 'metrics.disabled', 'true')
  await dolt(directory, 'config', '--global', '--add', 'versioncheck.disabled', 'true')
  const versions = {
    dolt: await dolt(directory, 'version'),
    git: await git(directory, '--version'),
    gcm: (await run(runtime.gcm, ['--version'], options(directory))).stdout.trim(),
  }
  assert(versions.dolt.includes(manifest.doltVersion))
  assert(versions.git.includes(manifest.gitVersion))
  assert(versions.gcm.includes(manifest.gcmVersion))
  report.versions = versions

  const seed = path.join(directory, 'seed')
  const remote = path.join(directory, 'remote.git')
  const local = path.join(directory, 'local')
  for (const folder of [seed, local]) await mkdir(folder)
  await git(seed, 'init', '--initial-branch=main')
  await writeFile(path.join(seed, 'README.md'), '# Synthetic Duckit transport fixture\n')
  await git(seed, 'add', 'README.md')
  await git(seed, 'commit', '-m', 'Initialize synthetic Git transport')
  await git(directory, 'clone', '--bare', seed, remote)
  await dolt(local, 'init', '--name', 'Duckit QA', '--email', 'qa@duckit.invalid')
  await sql(
    local,
    `CREATE TABLE accounts(id VARCHAR(40) PRIMARY KEY, amount BIGINT); CREATE TABLE categories(id VARCHAR(40) PRIMARY KEY, label TEXT); CREATE TABLE transactions(id VARCHAR(40) PRIMARY KEY, amount BIGINT); CREATE TABLE retired(id INT PRIMARY KEY); INSERT INTO accounts VALUES ('cash',10000); INSERT INTO categories VALUES ('food','base'); INSERT INTO transactions VALUES ('base',-100); INSERT INTO retired VALUES (1);`,
  )
  await checkpoint(local, 'Base synthetic state')
  await dolt(local, 'remote', 'add', 'origin', remote)
  await dolt(local, 'push', '--set-upstream', 'origin', 'main')
  assert(
    (await git(directory, '--git-dir', remote, 'show-ref', 'refs/dolt/data')).endsWith(
      'refs/dolt/data',
    ),
  )
  const clone = path.join(directory, 'clone')
  await dolt(directory, 'clone', remote, clone)
  assert.deepEqual(await snapshot(clone), await snapshot(local))
  report.localGitRemoteClone = 'passed'

  await dolt(local, 'checkout', '-b', 'ours')
  await sql(
    local,
    "UPDATE accounts SET amount=11000; UPDATE categories SET label='ours'; DELETE FROM transactions WHERE id='base'; CREATE TABLE ours_only(id INT PRIMARY KEY); INSERT INTO ours_only VALUES (1);",
  )
  const ours = await checkpoint(local, 'Local complete snapshot')
  const oursState = await snapshot(local)
  await dolt(local, 'checkout', '-b', 'theirs', 'main')
  await sql(
    local,
    "UPDATE accounts SET amount=12000; INSERT INTO transactions VALUES ('remote',-500); DROP TABLE retired; CREATE TABLE theirs_only(id INT PRIMARY KEY); INSERT INTO theirs_only VALUES (2);",
  )
  const theirs = await checkpoint(local, 'Remote complete snapshot')
  const theirsState = await snapshot(local)

  for (const [choice, selected, expected] of [
    ['ours', ours, oursState],
    ['theirs', theirs, theirsState],
  ] as const) {
    await dolt(local, 'checkout', '-b', `resolved-${choice}`, 'ours')
    // A normal, uncommitted merge records both parents before replacing the domain.
    try {
      await dolt(local, 'merge', '--no-ff', '--no-commit', 'theirs')
    } catch (error) {
      if (!(await sql(local, 'SELECT * FROM dolt_conflicts')).length) throw error
    }
    await dolt(local, 'conflicts', 'resolve', '--ours', '.')
    const selectedTables = await tables(local, selected)
    // Explicit deletion is essential: resolving conflicting rows alone retains
    // independently inserted rows/tables from the unwanted snapshot.
    for (const table of await tables(local)) {
      if (!selectedTables.includes(table)) await sql(local, `DROP TABLE ${identifier(table)}`)
    }
    await dolt(local, 'checkout', selected, '--', ...selectedTables)
    assert.deepEqual(
      await snapshot(local),
      expected,
      'The entire selected domain must match before commit',
    )
    const merged = await checkpoint(local, `Choose complete ${choice} snapshot`)
    const parents = (
      await sql(
        local,
        `SELECT parent_hash FROM dolt_commit_ancestors WHERE commit_hash='${merged}'`,
      )
    )
      .map((row) => row.parent_hash)
      .sort()
    assert.deepEqual(parents, [ours, theirs].sort(), 'Resolution must preserve both parents')
    assert.deepEqual(await snapshot(local), expected)
    await dolt(local, 'push', 'origin', `resolved-${choice}`)
    const recovered = path.join(directory, `recovered-${choice}`)
    await dolt(directory, 'clone', '--branch', `resolved-${choice}`, remote, recovered)
    assert.deepEqual(await snapshot(recovered), expected)
    report[`completeSnapshot${choice === 'ours' ? 'Ours' : 'Theirs'}`] = {
      passed: true,
      parents: 2,
      freshClone: true,
    }
  }

  if (github) {
    // gh is a developer prerequisite only for the explicit network QA mode.
    // It validates privacy/identity; Git/Dolt transport still uses bundled Git.
    const inspect = async () => {
      const response = await run('gh', ['api', `repos/${github}`], { timeout: 30_000 })
      const repository = JSON.parse(response.stdout) as {
        id: number
        private: boolean
        full_name: string
        default_branch: string
      }
      assert(
        repository.private && repository.full_name.toLowerCase() === github.toLowerCase(),
        'Remote must be the explicitly selected private repository',
      )
      return repository
    }
    const identity = await inspect()
    remoteUrl = `git@github.com:${github}.git`
    remoteRef = `refs/dolt/duckit-proof-${randomUUID()}`
    assert.equal(
      await git(directory, 'ls-remote', remoteUrl, remoteRef),
      '',
      'Test ref must not already exist',
    )
    assert(
      await git(directory, 'ls-remote', remoteUrl, `refs/heads/${identity.default_branch}`),
      'Git repository must have a seed branch',
    )
    await dolt(local, 'remote', 'add', '--ref', remoteRef, 'github-proof', remoteUrl)
    assert.equal((await inspect()).id, identity.id, 'Repository identity changed before upload')
    // Mark cleanup necessary before the push: an interrupted command may have uploaded.
    remoteCreated = true
    await dolt(local, 'push', 'github-proof', 'resolved-theirs')
    const githubClone = path.join(directory, 'github-clone')
    await dolt(
      directory,
      'clone',
      '--ref',
      remoteRef,
      '--branch',
      'resolved-theirs',
      remoteUrl,
      githubClone,
    )
    assert.deepEqual(await snapshot(githubClone), theirsState)
    report.privateGitHubClone = {
      passed: true,
      isolatedRef: true,
      transport: 'bundled Git with existing SSH credentials',
    }
  }
} catch (error) {
  failure = error
} finally {
  try {
    if (remoteCreated && remoteUrl && remoteRef) {
      if (await git(directory, 'ls-remote', remoteUrl, remoteRef)) {
        await git(path.join(directory, 'seed'), 'push', remoteUrl, '--delete', remoteRef)
      }
      assert.equal(
        await git(directory, 'ls-remote', remoteUrl, remoteRef),
        '',
        'Temporary GitHub test ref was not removed',
      )
    }
  } catch (cleanupError) {
    failure = new AggregateError(
      [failure, cleanupError].filter(Boolean),
      `Proof failed to remove temporary ref ${remoteRef}; remove this exact ref before retrying`,
    )
  }
  try {
    await rm(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 })
  } catch (cleanupError) {
    failure = new AggregateError(
      [failure, cleanupError].filter(Boolean),
      'Temporary proof cleanup failed',
    )
  }
}
if (failure) throw failure
console.log(JSON.stringify(report, null, 2))
