import { test, expect, _electron as electron } from '@playwright/test'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
test('test launches cannot open development or production storage', async () => {
  const root = await mkdtemp(join(tmpdir(), 'duckit-e2e-'))
  const app = await electron.launch({
    args: ['.'],
    env: { ...process.env, DUCKIT_TEST_ROOT: root },
  })
  try {
    expect(await app.evaluate(({ app }) => app.getPath('userData'))).toBe(root)
    const page = await app.firstWindow()
    await expect(page.getByRole('status')).toHaveText('Desktop foundation ready')
    const api = await page.evaluate(() => Object.keys(window.duckit))
    expect(api).not.toContain('invoke')
    expect(api).not.toContain('readFile')
  } finally {
    await app.close()
    await rm(root, { recursive: true, force: true })
  }
})
