import { cp, mkdir, mkdtemp, readFile, rename, rm, writeFile } from 'node:fs/promises'
import path from 'node:path'
import {
  readManifest,
  verifyDigest,
  verifyNativeTree,
  runtimeBinaries,
  extractRuntimeArchive,
  overlayGcm,
  overlayGitLfs,
} from './runtime.ts'
import type { Architecture, Asset } from './runtime.ts'

const root = process.cwd()
const manifest = await readManifest(root)
const requested = process.argv.slice(2)
if (requested.some((arg) => !['arm64', 'x64'].includes(arg)))
  throw new Error('Usage: node scripts/runtime-fetch.ts [arm64] [x64]')
const architectures = (requested.length ? requested : ['arm64', 'x64']) as Architecture[]
const runtimeRoot = path.join(root, 'resources/runtime')
const cache = path.join(runtimeRoot, '.downloads')
await mkdir(cache, { recursive: true })

async function download(asset: Asset): Promise<string> {
  const destination = path.join(cache, asset.sha256)
  let bytes: Buffer
  try {
    bytes = await readFile(destination)
    verifyDigest(bytes, asset.sha256)
    return destination
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
  }
  const response = await fetch(asset.url, { signal: AbortSignal.timeout(180_000) })
  if (!response.ok)
    throw new Error(`Runtime download failed: HTTP ${response.status} (${asset.url})`)
  bytes = Buffer.from(await response.arrayBuffer())
  verifyDigest(bytes, asset.sha256)
  const temporary = `${destination}.${process.pid}.tmp`
  await writeFile(temporary, bytes, { flag: 'wx' })
  await rename(temporary, destination)
  return destination
}

for (const arch of architectures) {
  const candidate = await mkdtemp(path.join(runtimeRoot, `.candidate-${arch}-`))
  const destination = path.join(runtimeRoot, arch)
  const previous = `${destination}.previous-${process.pid}`
  let previousMoved = false
  try {
    for (const component of ['dolt', 'git'] as const) {
      const asset = manifest.platforms[arch][component]
      console.log(`Verifying ${component} for macOS ${arch}`)
      const archive = await download(asset)
      await extractRuntimeArchive(archive, path.join(candidate, component), asset.stripComponents)
    }
    const gitCore = path.join(candidate, 'git/libexec/git-core')
    for (const component of ['gcm', 'gitLfs'] as const) {
      console.log(`Verifying ${component} overlay for macOS ${arch}`)
      const asset = manifest.platforms[arch][component]
      const archive = await download(asset)
      const source = path.join(candidate, `.${component}`)
      await extractRuntimeArchive(archive, source, asset.stripComponents)
      if (component === 'gcm') await overlayGcm(source, gitCore)
      else await overlayGitLfs(source, gitCore)
      await rm(source, { recursive: true })
    }
    const licenses = path.join(candidate, 'licenses')
    await mkdir(licenses)
    for (const notice of manifest.notices)
      await cp(await download(notice), path.join(licenses, notice.name))
    await cp(path.join(candidate, 'dolt/LICENSES'), path.join(licenses, 'Dolt-LICENSES'))
    await cp(path.join(candidate, 'git/libexec/git-core/NOTICE'), path.join(licenses, 'GCM-NOTICE'))
    await writeFile(path.join(candidate, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`)
    const nativeCode = await verifyNativeTree(candidate, arch, runtimeBinaries)
    console.log(`Verified ${nativeCode.length} Mach-O files support native ${arch}.`)
    try {
      await rename(destination, previous)
      previousMoved = true
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
    }
    try {
      await rename(candidate, destination)
    } catch (error) {
      if (previousMoved) await rename(previous, destination)
      throw error
    }
    if (previousMoved) await rm(previous, { recursive: true })
    console.log(
      `Prepared resources/runtime/${arch} with notices and corresponding Git build source.`,
    )
  } finally {
    await rm(candidate, { recursive: true, force: true })
  }
}
