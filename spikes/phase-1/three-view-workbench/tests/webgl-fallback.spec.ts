import { expect, test } from '@playwright/test'

test('unsupported WebGL shows an accessible workbench fallback without page errors', async ({ page }) => {
  const pageErrors: string[] = []
  const consoleErrors: string[] = []
  page.on('pageerror', (error) => pageErrors.push(error.message))
  page.on('console', (message) => {
    if (message.type() === 'error') consoleErrors.push(message.text())
  })

  await page.goto('/')

  await expect(page.getByRole('status').filter({ hasText: '3D preview unavailable' })).toHaveCount(3)
  await expect(page.locator('canvas')).toHaveCount(0)
  await expect(page.getByRole('heading', { name: 'Ranked regions' })).toBeVisible()
  await expect(page.getByRole('button', { name: /Upper mount/ })).toBeVisible()
  await page.waitForTimeout(100)
  expect(pageErrors).toEqual([])
  expect(consoleErrors).toEqual([])
})
