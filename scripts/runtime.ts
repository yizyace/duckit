import { createHash } from 'node:crypto'
import { execFile } from 'node:child_process'
import { readFile, readdir, realpath, lstat } from 'node:fs/promises'
import path from 'node:path'
import { promisify } from 'node:util'

export const run = promisify(execFile)
export type Architecture = 'arm64' | 'x64'
export type Asset = { url: string; sha256: string; stripComponents?: number; name?: string }
export type RuntimeManifest = {
  schemaVersion: number
  doltVersion: string
  gitVersion: string
  gcmVersion: string
  gitLfsVersion: string
  platforms: Record<Architecture, { dolt: Asset; git: Asset }>
  notices: (Asset & { name: string })[]
}

export async function readManifest(root = process.cwd()): Promise<RuntimeManifest> {
  const manifest = JSON.parse(
    await readFile(path.join(root, 'resources/runtime-manifest.json'), 'utf8'),
  ) as RuntimeManifest
  if (manifest.schemaVersion !== 1) throw new Error('Unsupported runtime manifest version')
  for (const asset of [
    ...Object.values(manifest.platforms).flatMap((p) => [p.dolt, p.git]),
    ...manifest.notices,
  ]) {
    if (!/^[a-f0-9]{64}$/.test(asset.sha256) || new URL(asset.url).protocol !== 'https:') {
      throw new Error('Runtime assets require a pinned SHA-256 and HTTPS URL')
    }
  }
  return manifest
}

export function verifyDigest(bytes: Uint8Array, expected: string): void {
  if (
    !/^[a-f0-9]{64}$/.test(expected) ||
    createHash('sha256').update(bytes).digest('hex') !== expected
  ) {
    throw new Error('Runtime asset checksum mismatch')
  }
}

export function validateArchivePaths(listing: string): void {
  for (const entry of listing.split('\n').filter(Boolean)) {
    if (path.posix.isAbsolute(entry) || entry.split('/').includes('..') || entry.includes('\\')) {
      throw new Error('Unsafe runtime archive path')
    }
  }
}

export async function verifyTreeLinks(directory: string, root = directory): Promise<void> {
  const canonicalRoot = await realpath(root)
  for (const name of await readdir(directory)) {
    const entry = path.join(directory, name)
    const stat = await lstat(entry)
    if (stat.isSymbolicLink()) {
      const relative = path.relative(canonicalRoot, await realpath(entry))
      if (relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
        throw new Error('Runtime symlink escapes bundle')
      }
    } else if (stat.isDirectory()) await verifyTreeLinks(entry, canonicalRoot)
  }
}

export function runtimePaths(root: string, arch: Architecture) {
  const directory = path.resolve(root, 'resources/runtime', arch)
  return {
    directory,
    dolt: path.join(directory, 'dolt/bin/dolt'),
    git: path.join(directory, 'git/bin/git'),
    gcm: path.join(directory, 'git/libexec/git-core/git-credential-manager'),
    gitExecPath: path.join(directory, 'git/libexec/git-core'),
  }
}

// Only OS utilities remain available; no Homebrew, developer Git, Node or Dolt.
export function runtimeEnvironment(
  root: string,
  arch: Architecture,
  doltRoot: string,
): NodeJS.ProcessEnv {
  const paths = runtimePaths(root, arch)
  // Preserve the SSH agent, but discard caller repository/configuration routing.
  const inherited = Object.fromEntries(
    Object.entries(process.env).filter(([key]) => !/^(GIT_|DOLT_|DYLD_|LD_|SSH_ASKPASS)/.test(key)),
  )
  return {
    ...inherited,
    PATH: [
      path.dirname(paths.git),
      paths.gitExecPath,
      path.dirname(paths.dolt),
      '/usr/bin',
      '/bin',
    ].join(path.delimiter),
    GIT_EXEC_PATH: paths.gitExecPath,
    GIT_TEMPLATE_DIR: path.join(paths.directory, 'git/share/git-core/templates'),
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_CONFIG_GLOBAL: '/dev/null',
    GIT_TERMINAL_PROMPT: '0',
    GIT_SSH_COMMAND: '/usr/bin/ssh -oBatchMode=yes',
    DOLT_ROOT_PATH: doltRoot,
    DOLT_DISABLE_EVENT_FLUSH: '1',
  }
}
