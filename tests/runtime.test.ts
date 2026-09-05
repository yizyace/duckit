import { createHash } from 'node:crypto'
import { mkdtemp, mkdir, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import {
  readManifest,
  runtimeEnvironment,
  validateArchivePaths,
  verifyDigest,
  verifyTreeLinks,
  machOArchitectures,
  verifyNativeTree,
  hostArchitecture,
} from '../scripts/runtime.ts'

function thinMachO(architecture: 'arm64' | 'x64', littleEndian = true): Buffer {
  const bytes = Buffer.alloc(32)
  const write = littleEndian ? bytes.writeUInt32LE.bind(bytes) : bytes.writeUInt32BE.bind(bytes)
  write(0xfeedfacf, 0)
  write(architecture === 'arm64' ? 0x0100000c : 0x01000007, 4)
  return bytes
}

function universalMachO(wide = false): Buffer {
  const stride = wide ? 32 : 20
  const bytes = Buffer.alloc(8 + 2 * stride)
  bytes.writeUInt32BE(wide ? 0xcafebabf : 0xcafebabe, 0)
  bytes.writeUInt32BE(2, 4)
  bytes.writeUInt32BE(0x01000007, 8)
  bytes.writeUInt32BE(0x0100000c, 8 + stride)
  return bytes
}

describe('pinned portable runtime', () => {
  it('discards inherited Git routing/configuration while retaining the SSH agent', () => {
    const polluted = {
      GIT_DIR: '/unrelated/.git',
      GIT_WORK_TREE: '/unrelated',
      GIT_INDEX_FILE: '/unrelated/index',
      GIT_CONFIG_COUNT: '1',
      GIT_CONFIG_KEY_0: 'core.hooksPath',
      GIT_CONFIG_VALUE_0: '/unrelated/hooks',
      GIT_CONFIG_PARAMETERS: 'injected',
      GIT_SSH_COMMAND: '/unrelated/ssh',
      GIT_ASKPASS: '/unrelated/askpass',
      SSH_ASKPASS: '/unrelated/ssh-askpass',
      SSH_AUTH_SOCK: '/synthetic/ssh-agent',
    }
    try {
      for (const [key, value] of Object.entries(polluted)) vi.stubEnv(key, value)
      const environment = runtimeEnvironment('/synthetic/duckit', 'arm64', '/synthetic/state')
      for (const key of Object.keys(polluted)) {
        if (key === 'SSH_AUTH_SOCK' || key === 'GIT_SSH_COMMAND') continue
        expect(environment[key]).toBeUndefined()
      }
      expect(environment.SSH_AUTH_SOCK).toBe('/synthetic/ssh-agent')
      expect(environment.GIT_SSH_COMMAND).toBe('/usr/bin/ssh -oBatchMode=yes')
    } finally {
      vi.unstubAllEnvs()
    }
  })

  it('rejects corrupted downloads before extraction', () => {
    const expected = createHash('sha256').update('publisher archive').digest('hex')
    expect(() => verifyDigest(Buffer.from('publisher archive'), expected)).not.toThrow()
    expect(() => verifyDigest(Buffer.from('corrupted archive'), expected)).toThrow(
      'checksum mismatch',
    )
  })

  it('rejects archive paths outside the staging directory', () => {
    for (const entry of ['../escape', '/absolute', 'directory/../../escape', 'directory\\escape']) {
      expect(() => validateArchivePaths(entry)).toThrow('Unsafe')
    }
    expect(() => validateArchivePaths('./bin/git\n./libexec/git-core/git')).not.toThrow()
  })

  it('accepts internal links and rejects external links', async () => {
    const directory = await mkdtemp(path.join(tmpdir(), 'duckit-runtime-test-'))
    try {
      await mkdir(path.join(directory, 'bundle'))
      await writeFile(path.join(directory, 'bundle/binary'), 'synthetic')
      await symlink('binary', path.join(directory, 'bundle/internal'))
      await expect(verifyTreeLinks(path.join(directory, 'bundle'))).resolves.toBeUndefined()
      await writeFile(path.join(directory, 'outside'), 'synthetic')
      await symlink('../outside', path.join(directory, 'bundle/external'))
      await expect(verifyTreeLinks(path.join(directory, 'bundle'))).rejects.toThrow(
        'escapes bundle',
      )
    } finally {
      await rm(directory, { recursive: true, force: true })
    }
  })

  it('pins both architectures and excludes developer runtimes from subprocess PATH', async () => {
    const manifest = await readManifest()
    expect(Object.keys(manifest.platforms).sort()).toEqual(['arm64', 'x64'])
    expect(manifest.notices.some((n) => n.name === 'git-v2.53.0-source.tar.gz')).toBe(true)
    const environment = runtimeEnvironment('/synthetic/duckit', 'arm64', '/synthetic/state')
    expect(environment.PATH).not.toContain('/opt/homebrew')
    expect(environment.PATH).not.toContain('/usr/local')
    expect(environment.DOLT_ROOT_PATH).toBe('/synthetic/state')
    expect(environment.GIT_CONFIG_GLOBAL).toBe('/dev/null')
  })

  it('recognizes thin and universal Mach-O CPU declarations without executing code', () => {
    expect(machOArchitectures(thinMachO('arm64'))).toEqual(['arm64'])
    expect(machOArchitectures(thinMachO('x64'))).toEqual(['x64'])
    expect(machOArchitectures(thinMachO('arm64', false))).toEqual(['arm64'])
    expect(machOArchitectures(universalMachO())).toEqual(['arm64', 'x64'])
    expect(machOArchitectures(universalMachO(true))).toEqual(['arm64', 'x64'])
    expect(machOArchitectures(Buffer.from('#!/bin/sh\nexit 0'))).toBeNull()
    expect(() => machOArchitectures(thinMachO('arm64').subarray(0, 8))).toThrow('Truncated')
    expect(() => machOArchitectures(universalMachO().subarray(0, 20))).toThrow('architecture table')
    const invalid = universalMachO()
    invalid.writeUInt32BE(65, 4)
    expect(() => machOArchitectures(invalid)).toThrow('architecture table')
  })

  it('rejects a nested Intel-only helper even when the main executable is arm64', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'duckit-native-helper-test-'))
    try {
      await mkdir(path.join(root, 'nested/libraries'), { recursive: true })
      await writeFile(path.join(root, 'Duckit'), thinMachO('arm64'))
      await writeFile(path.join(root, 'nested/libraries/helper'), thinMachO('x64'))
      await expect(verifyNativeTree(root, 'arm64', ['Duckit'])).rejects.toThrow(
        'Native arm64 code missing from nested/libraries/helper: x64',
      )
      await writeFile(path.join(root, 'nested/libraries/helper'), universalMachO())
      expect(await verifyNativeTree(root, 'arm64', ['Duckit'])).toHaveLength(2)
      await expect(verifyNativeTree(root, 'x64', ['Duckit'])).rejects.toThrow(
        'Native x64 code missing',
      )
      await writeFile(path.join(root, 'Duckit'), thinMachO('x64'))
      expect(await verifyNativeTree(root, 'x64', ['Duckit'])).toHaveLength(2)
      await writeFile(path.join(root, 'required-helper'), '#!/bin/sh\nexit 0')
      await expect(verifyNativeTree(root, 'x64', ['required-helper'])).rejects.toThrow(
        'Required native x64 binary missing',
      )
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('audits canonical framework code while rejecting external symlink targets', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'duckit-native-links-test-'))
    const bundle = path.join(root, 'bundle')
    try {
      await mkdir(path.join(bundle, 'Versions/A'), { recursive: true })
      await writeFile(path.join(bundle, 'Versions/A/Framework'), thinMachO('arm64'))
      await symlink('A', path.join(bundle, 'Versions/Current'))
      await symlink('Versions/Current/Framework', path.join(bundle, 'Framework'))
      expect(await verifyNativeTree(bundle, 'arm64', ['Framework'])).toEqual([
        { file: 'Versions/A/Framework', architectures: ['arm64'] },
      ])
      await writeFile(path.join(root, 'external'), thinMachO('arm64'))
      await symlink('../external', path.join(bundle, 'external'))
      await expect(verifyNativeTree(bundle, 'arm64')).rejects.toThrow('symlink escapes')
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('detects a native Intel host when its optional arm64 sysctl OID is absent', () => {
    expect(hostArchitecture('', 'x64')).toBe('x64')
    expect(hostArchitecture('0\n', 'x64')).toBe('x64')
    expect(hostArchitecture('1\n', 'arm64')).toBe('arm64')
    expect(hostArchitecture('1\n', 'x64')).toBe('arm64')
    expect(() => hostArchitecture('', 'arm64')).toThrow('Could not determine')
    expect(() => hostArchitecture('unexpected', 'x64')).toThrow('Could not determine')
  })
})
