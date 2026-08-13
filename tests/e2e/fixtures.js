// Copyright 2026 Tim Perkins (tjwp) | SPDX-License-Identifier: Apache-2.0
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
      // Init scripts also run before the document element exists (the initial
      // about:blank, and the very start of each navigation), where BOTH
      // document.head and document.documentElement are null. Appending blindly
      // threw an uncaught TypeError on every page in the suite — invisible
      // until a spec attached a `pageerror` listener. Retry once the DOM is up.
      const inject = () => {
        const root = document.head || document.documentElement;
        if (!root) return false;
        const style = document.createElement('style');
        style.textContent = '*, *::before, *::after { animation-duration: 0s !important; transition-duration: 0s !important; animation-delay: 0s !important; transition-delay: 0s !important; }';
        root.appendChild(style);
        return true;
      };
      if (!inject()) {
        document.addEventListener('DOMContentLoaded', inject, { once: true });
      }
    });
    await use(page);
  },
});

export { test, expect };
