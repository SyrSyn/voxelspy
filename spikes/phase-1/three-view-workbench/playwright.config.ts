import { defineConfig, devices } from '@playwright/test'

export default defineConfig({
  testDir: './tests',
  outputDir: './test-results',
  reporter: [['list']],
  use: {
    baseURL: 'http://127.0.0.1:4173',
    screenshot: 'only-on-failure',
    trace: 'retain-on-failure',
  },
  webServer: {
    command: 'pnpm vite preview --host 127.0.0.1 --port 4173',
    url: 'http://127.0.0.1:4173',
    reuseExistingServer: false,
  },
  projects: [
    {
      name: 'desktop',
      testIgnore: '**/webgl-fallback.spec.ts',
      use: { ...devices['Desktop Chrome'], browserName: 'chromium', viewport: { width: 1440, height: 1000 } },
    },
    {
      name: 'tablet',
      testIgnore: '**/webgl-fallback.spec.ts',
      use: { ...devices['iPad (gen 7)'], browserName: 'chromium' },
    },
    {
      name: 'mobile',
      testIgnore: '**/webgl-fallback.spec.ts',
      use: { ...devices['iPhone 13'], browserName: 'chromium' },
    },
    {
      name: 'no-webgl',
      testMatch: '**/webgl-fallback.spec.ts',
      use: {
        ...devices['Desktop Chrome'],
        browserName: 'chromium',
        launchOptions: { args: ['--disable-webgl', '--disable-webgl2', '--disable-gpu'] },
        viewport: { width: 1280, height: 900 },
      },
    },
  ],
})
