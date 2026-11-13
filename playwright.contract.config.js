// Copyright 2026 Tim Perkins (tjwp) | SPDX-License-Identifier: Apache-2.0
//
// Vendor contract suite: the real @pierre/diffs bundle in a real browser, with
// no application server. Specs import `test` from tests/contract/harness/
// contract-test.js, which extends @playwright/test directly, so the E2E
// worker-scoped test server (tests/e2e/fixtures.js) never starts and no port is
// bound. That is why this suite may run at any time, including next to an E2E
// run.
//
//   pnpm run test:contract
//   pnpm run test:contract -- tests/contract/vendor/annotations.spec.js
import { defineConfig } from '@playwright/test';

export default defineConfig({
  testDir: './tests/contract',
  testMatch: '**/*.spec.js',
  globalSetup: './tests/contract/harness/global-setup.js',
  // Each test opens its own page on its own browser context; nothing is shared.
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  retries: 0,
  workers: process.env.CONTRACT_WORKERS ? parseInt(process.env.CONTRACT_WORKERS, 10) : (process.env.CI ? 2 : 4),
  reporter: process.env.CI ? 'github' : 'list',

  use: {
    headless: true,
    // The scroll root is 1400 x 860 (a 40 px toolbar above it). Specs that
    // assert positions depend on this size.
    viewport: { width: 1400, height: 900 },
    screenshot: 'only-on-failure',
  },

  timeout: 60000,
  expect: {
    timeout: 10000,
  },
});
