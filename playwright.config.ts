import { defineConfig } from '@playwright/test'
export default defineConfig({
  testDir: 'tests/e2e',
  workers: 1,
  timeout: 30000,
  forbidOnly: Boolean(process.env.CI),
  reporter: process.env.CI
    ? [['list'], ['html', { open: 'never' }], ['junit', { outputFile: 'reports/electron.xml' }]]
    : 'list',
})
