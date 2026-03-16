import { defineConfig } from '@playwright/test';

export default defineConfig({
  testDir: './tests/e2e',
  fullyParallel: false,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 2 : 0,
  workers: 8,
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
