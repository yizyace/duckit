import { expect, type Page } from '@playwright/test'
import { monthLabel } from '../../src/renderer/src/views/format'

export async function chooseMonth(page: Page, label: string, month: string) {
  await page.getByRole('button', { name: new RegExp(`^${label}:`) }).click()
  const chooser = page.getByRole('dialog', { name: `Choose ${label.toLowerCase()}` })
  await chooser.getByLabel('Year', { exact: true }).fill(month.slice(0, 4))
  await chooser.getByRole('button', { name: monthLabel(month).split(' ')[0]!, exact: true }).click()
  await expect(chooser).toHaveCount(0)
}
