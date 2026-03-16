import { defineConfig } from '@playwright/test';

export default defineConfig({
  testDir: './tests/e2e',
  fullyParallel: false,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 2 : 0,
  // GitHub Actions ubuntu-latest: 4 vCPUs; local dev: tune to your machine
  workers: process.env.E2E_WORKERS ? parseInt(process.env.E2E_WORKERS, 10) : (process.env.CI ? 3 : 8),
  reporter: process.env.CI ? 'github' : 'list',

  use: {
    trace: 'on-first-retry',
    screenshot: 'only-on-failure',
  },

  timeout: 30000,
  expect: {
    timeout: 10000,
  },

  // Only match spec files, not helper files
  testMatch: '**/*.spec.js',
});
