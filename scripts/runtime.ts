import { createHash } from 'node:crypto'
import { execFile } from 'node:child_process'
import { readFile, readdir, realpath, lstat, open, mkdir, cp } from 'node:fs/promises'
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
  platforms: Record<Architecture, { dolt: Asset; git: Asset; gcm: Asset; gitLfs: Asset }>
  notices: (Asset & { name: string })[]
}

export async function readManifest(root = process.cwd()): Promise<RuntimeManifest> {
  const manifest = JSON.parse(
    await readFile(path.join(root, 'resources/runtime-manifest.json'), 'utf8'),
  ) as RuntimeManifest
  if (manifest.schemaVersion !== 1) throw new Error('Unsupported runtime manifest version')
  for (const asset of [
    ...Object.values(manifest.platforms).flatMap((p) => [p.dolt, p.git, p.gcm, p.gitLfs]),
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

/** macOS bsdtar detects both gzip tarballs and ZIP archives. */
export async function extractRuntimeArchive(
  archive: string,
  target: string,
  stripComponents = 0,
): Promise<void> {
  if (!Number.isSafeInteger(stripComponents) || stripComponents < 0)
    throw new Error('Invalid runtime archive strip count')
  const { stdout } = await run('/usr/bin/tar', ['-tf', archive], {
    maxBuffer: 16 * 1024 * 1024,
  })
  validateArchivePaths(stdout)
  await mkdir(target)
  await run('/usr/bin/tar', ['-xf', archive, '-C', target, `--strip-components=${stripComponents}`])
  await verifyTreeLinks(target)
}

function isGcmPath(relative: string): boolean {
  return (
    /^(?:[^/]+\.dll|lib[^/]+\.dylib|createdump|NOTICE|uninstall\.sh|git-credential-manager(?:\.(?:deps\.json|runtimeconfig\.json))?)$/.test(
      relative,
    ) || /^[a-z]{2}(?:-[A-Za-z]+)?\/System\.CommandLine\.resources\.dll$/.test(relative)
  )
}

async function regularFiles(directory: string, root = directory): Promise<string[]> {
  const files: string[] = []
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const file = path.join(directory, entry.name)
    if (entry.isDirectory()) files.push(...(await regularFiles(file, root)))
    else if (entry.isFile()) files.push(path.relative(root, file))
    else throw new Error('Runtime overlay must contain only regular files and directories')
  }
  return files.sort()
}

/** Replace the complete reviewed GCM payload, never Git's neighboring tools. */
export async function overlayGcm(source: string, gitCore: string): Promise<void> {
  const incoming = await regularFiles(source)
  if (incoming.some((file) => !isGcmPath(file)))
    throw new Error('Unexpected GCM payload path; review the upstream layout before updating')
  for (const required of [
    'git-credential-manager',
    'git-credential-manager.dll',
    'git-credential-manager.deps.json',
    'git-credential-manager.runtimeconfig.json',
    'gcmcore.dll',
    'libhostfxr.dylib',
    'libhostpolicy.dylib',
    'libcoreclr.dylib',
    'NOTICE',
  ]) {
    if (!incoming.includes(required)) throw new Error(`Incomplete GCM payload: ${required}`)
  }
  // These pinned GCM releases have identical file inventories. Reject a changed
  // layout instead of retaining old runtime DLLs or deleting neighboring Git files.
  const existing: string[] = []
  async function inspect(directory: string): Promise<void> {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const file = path.join(directory, entry.name)
      const relative = path.relative(gitCore, file)
      if (isGcmPath(relative)) {
        if (!entry.isFile()) throw new Error('GCM destination must be a regular file')
        existing.push(relative)
      } else if (entry.isDirectory()) await inspect(file)
    }
  }
  await inspect(gitCore)
  if (JSON.stringify(existing.sort()) !== JSON.stringify(incoming))
    throw new Error('GCM payload inventory changed; review replacement scope before updating')
  for (const file of incoming) await cp(path.join(source, file), path.join(gitCore, file))
}

export async function overlayGitLfs(source: string, gitCore: string): Promise<void> {
  const binary = path.join(source, 'git-lfs')
  const destination = path.join(gitCore, 'git-lfs')
  if (!(await lstat(binary)).isFile() || !(await lstat(destination)).isFile())
    throw new Error('Git LFS overlay requires regular source and destination files')
  await cp(binary, destination)
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

export type NativeCodeFile = { file: string; architectures: string[] }

/** Read CPU declarations without executing the binary or requiring Xcode tools. */
export function machOArchitectures(bytes: Uint8Array): string[] | null {
  if (bytes.byteLength < 4) return null
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  const magic = view.getUint32(0)
  const thin = [0xfeedface, 0xcefaedfe, 0xfeedfacf, 0xcffaedfe].includes(magic)
  const fat = [0xcafebabe, 0xbebafeca, 0xcafebabf, 0xbfbafeca].includes(magic)
  if (!thin && !fat) return null
  const littleEndian = [0xcefaedfe, 0xcffaedfe, 0xbebafeca, 0xbfbafeca].includes(magic)
  const cpu = (offset: number) => {
    const type = view.getUint32(offset, littleEndian)
    return type === 0x0100000c
      ? 'arm64'
      : type === 0x01000007
        ? 'x64'
        : `cpu-0x${type.toString(16)}`
  }
  if (thin) {
    const size = [0xfeedfacf, 0xcffaedfe].includes(magic) ? 32 : 28
    if (bytes.byteLength < size) throw new Error('Truncated Mach-O header')
    return [cpu(4)]
  }
  // Apple's fat_header / fat_arch layouts: cctools/include/mach-o/fat.h.
  if (bytes.byteLength < 8) throw new Error('Truncated universal Mach-O header')
  const count = view.getUint32(4, littleEndian)
  const stride = [0xcafebabf, 0xbfbafeca].includes(magic) ? 32 : 20
  if (count < 1 || count > 64 || bytes.byteLength < 8 + count * stride)
    throw new Error('Invalid universal Mach-O architecture table')
  return [...new Set(Array.from({ length: count }, (_, index) => cpu(8 + index * stride)))].sort()
}

export async function binaryArchitectures(file: string): Promise<string[] | null> {
  const handle = await open(file, 'r')
  try {
    const buffer = Buffer.alloc(4096)
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0)
    return machOArchitectures(buffer.subarray(0, bytesRead))
  } finally {
    await handle.close()
  }
}

/** Include every nested executable/library; symlink targets must stay in the tree. */
export async function verifyNativeTree(
  directory: string,
  architecture: Architecture,
  requiredBinaries: string[] = [],
): Promise<NativeCodeFile[]> {
  await verifyTreeLinks(directory)
  const files: NativeCodeFile[] = []
  async function visit(current: string): Promise<void> {
    for (const entry of await readdir(current, { withFileTypes: true })) {
      const file = path.join(current, entry.name)
      // Canonical targets are visited at their real locations; avoid framework cycles.
      if (entry.isSymbolicLink()) continue
      if (entry.isDirectory()) await visit(file)
      else if (entry.isFile()) {
        const architectures = await binaryArchitectures(file)
        if (!architectures) continue
        const relative = path.relative(directory, file)
        if (!architectures.includes(architecture))
          throw new Error(
            `Native ${architecture} code missing from ${relative}: ${architectures.join(', ')}`,
          )
        files.push({ file: relative, architectures })
      }
    }
  }
  await visit(directory)
  if (!files.length) throw new Error('No Mach-O code found in native bundle')
  for (const relative of requiredBinaries) {
    const resolved = path.resolve(directory, relative)
    const scoped = path.relative(path.resolve(directory), resolved)
    if (scoped === '..' || scoped.startsWith(`..${path.sep}`) || path.isAbsolute(scoped))
      throw new Error('Required binary must be inside native bundle')
    if (!(await binaryArchitectures(resolved))?.includes(architecture))
      throw new Error(`Required native ${architecture} binary missing: ${relative}`)
  }
  return files.sort((a, b) => a.file.localeCompare(b.file))
}

export function hostArchitecture(arm64Flag: string, nodeArchitecture: string): Architecture {
  if (arm64Flag.trim() === '1') return 'arm64'
  // -i ignores unknown sysctl OIDs, which are absent on some genuine Intel Macs.
  if (['', '0'].includes(arm64Flag.trim()) && nodeArchitecture === 'x64') return 'x64'
  throw new Error('Could not determine native macOS host architecture')
}

export async function macHostArchitecture(): Promise<Architecture> {
  const { stdout } = await run('/usr/sbin/sysctl', ['-in', 'hw.optional.arm64'])
  return hostArchitecture(stdout, process.arch)
}

export const runtimeBinaries = [
  'dolt/bin/dolt',
  'git/bin/git',
  'git/libexec/git-core/git-credential-manager',
  'git/libexec/git-core/git-lfs',
]

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
