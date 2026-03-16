// SPDX-License-Identifier: GPL-3.0-or-later
/**
 * Playwright fixtures for per-worker test server isolation.
 *
 * Each worker gets its own Express server on a unique port with its own
 * in-memory SQLite database, enabling safe parallel execution.
 */

import { test as base, expect } from '@playwright/test';
import { startTestServer } from './test-server.js';

const test = base.extend({
  testServer: [async ({}, use, workerInfo) => {
    const port = 4000 + workerInfo.workerIndex;
    const result = await startTestServer(port);
    await use(result);
    result.server.close();
  }, { scope: 'worker' }],

  baseURL: async ({ testServer }, use) => {
    await use(`http://localhost:${testServer.port}`);
  },

  // Inject CSS to disable all animations/transitions for faster test execution
  page: async ({ page }, use) => {
    await page.addInitScript(() => {
      const style = document.createElement('style');
      style.textContent = '*, *::before, *::after { animation-duration: 0s !important; transition-duration: 0s !important; animation-delay: 0s !important; transition-delay: 0s !important; }';
      (document.head || document.documentElement).appendChild(style);
    });
    await use(page);
  },
});

export { test, expect };
