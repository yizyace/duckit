import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { run } from './runtime.ts'

// CI uses fresh, synthetic workspaces. Application data is never an input.
const [architecture, ...extra] = process.argv.slice(2)
assert(
  extra.length === 0 && (architecture === 'arm64' || architecture === 'x64'),
  'Usage: node scripts/ci-package.ts arm64|x64',
)
assert.equal(process.platform, 'darwin')
assert.equal(process.arch, architecture, 'Package on a matching native runner')
const root = process.cwd()
const { version } = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'))
assert(typeof version === 'string' && /^\d+\.\d+\.\d+(?:-[\w.-]+)?$/.test(version))
const source =
  process.env.GITHUB_SHA ?? (await run('git', ['rev-parse', 'HEAD'], { cwd: root })).stdout.trim()
assert(/^[a-f0-9]{40}$/.test(source), 'A source commit is required for build provenance')
const release = join(root, 'release')
await mkdir(join(release, 'qa'), { recursive: true })

async function execute(file: string, args: string[], timeout = 180_000) {
  const result = await run(file, args, {
    cwd: root,
    env: { ...process.env, CSC_IDENTITY_AUTO_DISCOVERY: 'false' },
    timeout,
    maxBuffer: 32 * 1024 * 1024,
  })
  process.stdout.write(result.stdout)
  process.stderr.write(result.stderr)
}

await execute(
  join(root, 'node_modules/.bin/electron-builder'),
  ['--mac', `--${architecture}`, '--publish', 'never'],
  1_200_000,
)
const app = join(release, architecture === 'arm64' ? 'mac-arm64' : 'mac', 'Duckit.app')
const smokePath = join(release, 'qa', `package-smoke-${architecture}.json`)
await execute(
  join(root, 'node_modules/.bin/tsx'),
  ['scripts/package-smoke.ts', `--app=${app}`, `--report=${smokePath}`],
  300_000,
)
const smoke = JSON.parse(await readFile(smokePath, 'utf8'))
assert.equal(smoke.result, 'passed')
assert.equal(smoke.architecture, architecture)
assert.equal(smoke.hostArchitecture, architecture)
assert.equal(smoke.execution, 'native architecture')

const names = ['dmg', 'zip'].map((extension) => `Duckit-${version}-${architecture}.${extension}`)
await execute('/usr/bin/hdiutil', ['verify', join(release, names[0]!)])
await execute('/usr/bin/unzip', ['-tq', join(release, names[1]!)])
const artifacts = []
for (const name of names) {
  const bytes = await readFile(join(release, name))
  assert(bytes.length > 0)
  artifacts.push({
    name,
    bytes: bytes.length,
    sha256: createHash('sha256').update(bytes).digest('hex'),
  })
}
await writeFile(
  join(release, `SHA256SUMS-${architecture}`),
  artifacts.map(({ name, sha256 }) => `${sha256}  ${name}\n`).join(''),
)
await writeFile(
  join(release, `build-${architecture}.json`),
  `${JSON.stringify(
    {
      version,
      source,
      architecture,
      signing: 'unsigned',
      notarized: false,
      builtAt: new Date().toISOString(),
      runtimeManifestSha256: createHash('sha256')
        .update(await readFile(join(root, 'resources/runtime-manifest.json')))
        .digest('hex'),
      artifacts,
    },
    null,
    2,
  )}\n`,
)
console.log(`Verified ${architecture} installers and recorded source ${source}.`)
