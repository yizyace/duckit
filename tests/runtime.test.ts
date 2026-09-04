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
} from '../scripts/runtime.ts'

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
})
