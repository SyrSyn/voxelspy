import { expect, test, type Page } from '@playwright/test'

const viewKinds = ['baseline', 'candidate', 'difference'] as const

type RenderCamera = {
  position: number[]
  target: number[]
  zoom: number
}

async function renderedCameras(page: Page) {
  return Promise.all(viewKinds.map(async (kind) => {
    const value = await page.getByTestId(`${kind}-viewport`).locator('canvas').getAttribute('data-render-camera')
    return value ? JSON.parse(value) as RenderCamera : null
  }))
}

async function expectRenderedTarget(page: Page, expected: number[]) {
  await expect.poll(async () => {
    const cameras = await renderedCameras(page)
    return cameras.every((camera) => camera && camera.target.every((value, index) => Math.abs(value - expected[index]) < 0.001))
  }).toBe(true)
}

test('desktop interactions synchronize the workbench state', async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== 'desktop', 'Desktop interaction coverage uses the persistent analysis rail.')
  await page.goto('/')
  await expect(page.getByRole('heading', { name: 'Three-view workbench' })).toBeVisible()
  await expect(page.getByTestId('difference-viewport')).toBeVisible()

  await page.getByRole('button', { name: /Lower notch/ }).click()
  await expect(page.getByText('Selected').locator('..').getByText('Lower notch')).toBeVisible()
  await expect(page.getByTestId('baseline-viewport').getByText('Lower notch')).toBeVisible()
  await expect(page.getByTestId('candidate-viewport').getByText('Lower notch')).toBeVisible()
  await expect(page.getByTestId('difference-viewport').getByText('Lower notch')).toBeVisible()
  await expectRenderedTarget(page, [-1.35, -0.72, 0.38])

  const clip = page.getByRole('slider', { name: 'Cross section depth' })
  await clip.fill('45')
  await expect(page.getByText('45%', { exact: true })).toBeVisible()
  for (const kind of viewKinds) {
    const canvas = page.getByTestId(`${kind}-viewport`).locator('canvas')
    await expect(canvas).toHaveAttribute('data-render-clipping', /"clip":45,"materials":[1-9]/)
    const clipping = JSON.parse((await canvas.getAttribute('data-render-clipping'))!) as { constants: number[] }
    expect(new Set(clipping.constants)).toEqual(new Set([-0.32]))
  }

  const beforeZoom = await renderedCameras(page)
  const differenceCanvas = page.getByTestId('difference-viewport').locator('canvas')
  await differenceCanvas.hover({ position: { x: 180, y: 180 } })
  await page.mouse.wheel(0, 420)
  await expect.poll(async () => JSON.stringify(await renderedCameras(page))).not.toBe(JSON.stringify(beforeZoom))
  await expect.poll(async () => {
    const cameras = await renderedCameras(page)
    return cameras.every(Boolean) ? new Set(cameras.map((camera) => JSON.stringify(camera))).size : 0
  }).toBe(1)
  const synchronized = await renderedCameras(page)
  expect(synchronized).not.toEqual(beforeZoom)
  await page.waitForTimeout(250)
  expect(await renderedCameras(page)).toEqual(synchronized)

  await page.getByRole('button', { name: 'High contrast' }).click()
  await expect(page.locator('.app')).toHaveAttribute('data-theme', 'contrast')
  await expect(page.getByText('Removed · hatch')).toBeVisible()

  await page.screenshot({ path: testInfo.outputPath('desktop-workbench.png'), fullPage: true })
})

test('keyboard region navigation updates all view labels', async ({ page }) => {
  await page.goto('/')
  await page.locator('body').press('ArrowDown')
  await expect(page.getByTestId('difference-viewport').getByText('Lower notch')).toBeVisible()
  await page.locator('body').press(']')
  await expect(page.getByTestId('difference-viewport').getByText('Center bore')).toBeVisible()
  await expectRenderedTarget(page, [0.1, 0.05, 0.55])
  await page.locator('body').press('f')
  await expectRenderedTarget(page, [0, 0, 0])
  const cameras = await renderedCameras(page)
  expect(cameras.every((camera) => camera?.position.every((value, index) => Math.abs(value - [5.7, 4.2, 6.2][index]) < 0.001))).toBe(true)
})

test('compact layouts keep comparison usable and gate findings', async ({ page }, testInfo) => {
  test.skip(testInfo.project.name === 'desktop', 'Compact gating applies at tablet and mobile breakpoints.')
  await page.goto('/')
  const toggle = page.getByRole('button', { name: 'Show findings' })
  const panel = page.locator('#mobile-analysis')
  await expect(toggle).toBeVisible()
  await expect(panel).toBeHidden()
  await expect(panel).toHaveAttribute('inert', '')
  for (let step = 0; step < 12; step += 1) {
    await page.keyboard.press('Tab')
    expect(await panel.evaluate((node) => node.contains(document.activeElement))).toBe(false)
  }
  await toggle.tap()
  await expect(panel).toHaveClass(/analysis-shell--open/)
  await expect(panel).not.toHaveAttribute('hidden', '')
  await expect(panel.getByRole('heading', { name: 'Ranked regions' })).toBeFocused()
  await page.keyboard.press('Tab')
  await expect(page.getByRole('button', { name: /Upper mount/ })).toBeFocused()
  await page.getByRole('button', { name: 'Light' }).tap()
  await expect(page.locator('.app')).toHaveAttribute('data-theme', 'light')

  const comparisonWidth = await page.locator('#comparison').evaluate((node) => node.scrollWidth - node.clientWidth)
  expect(comparisonWidth).toBeLessThanOrEqual(1)
  await page.screenshot({ path: testInfo.outputPath(`${testInfo.project.name}-workbench.png`), fullPage: true })
})

test('accessibility cues, reduced motion, and local-only loading remain explicit', async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== 'desktop', 'One representative audit avoids redundant browser work.')
  const externalRequests: string[] = []
  page.on('request', (request) => {
    const url = new URL(request.url())
    if (url.hostname !== '127.0.0.1') externalRequests.push(request.url())
  })
  await page.emulateMedia({ reducedMotion: 'reduce' })
  await page.goto('/')
  await page.keyboard.press('Tab')
  await expect(page.getByRole('link', { name: 'Skip to comparison' })).toBeFocused()
  await expect(page.getByText('Added · solid')).toBeVisible()
  await expect(page.getByText('Removed · hatch')).toBeVisible()
  await expect(page.getByText('Shifted · ring')).toBeVisible()
  await page.getByRole('button', { name: 'High contrast' }).click()
  const contrastRatio = await page.locator('.analysis').evaluate((node) => {
    const parse = (value: string) => (value.match(/[\d.]+/g) ?? []).slice(0, 3).map(Number)
    const luminance = (rgb: number[]) => {
      const channels = rgb.map((channel) => {
        const value = channel / 255
        return value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4
      })
      return channels[0] * 0.2126 + channels[1] * 0.7152 + channels[2] * 0.0722
    }
    const foreground = luminance(parse(getComputedStyle(node).color))
    const background = luminance(parse(getComputedStyle(node).backgroundColor))
    return (Math.max(foreground, background) + 0.05) / (Math.min(foreground, background) + 0.05)
  })
  expect(contrastRatio).toBeGreaterThanOrEqual(7)
  const motion = await page.locator('.finding').first().evaluate((node) => getComputedStyle(node).animationDuration)
  expect(['0s', '0.00001s', '1e-05s']).toContain(motion)
  expect(externalRequests).toEqual([])
})
