// Copyright 2026 Tim Perkins (tjwp) | SPDX-License-Identifier: Apache-2.0
/**
 * Playwright fixtures for per-worker test server isolation.
 *
 * Each worker gets its own Express server on a unique port with its own
 * in-memory SQLite database, enabling safe parallel execution.
 */

import net from 'node:net';
import { test as base, expect } from '@playwright/test';
import { startTestServer } from './test-server.js';

/** An ephemeral port the kernel reports as free, for the retry path below. */
function freePort() {
  return new Promise((resolve, reject) => {
    const probe = net.createServer();
    probe.unref();
    probe.on('error', reject);
    probe.listen(0, '127.0.0.1', () => {
      const { port } = probe.address();
      probe.close(() => resolve(port));
    });
  });
}

const test = base.extend({
  testServer: [async ({}, use, workerInfo) => {
    // Preferred port is derived from the worker index so logs stay predictable,
    // but it is NOT guaranteed free: a back-to-back suite run (or any process
    // holding it) makes `listen` throw EADDRINUSE, which fails the fixture and
    // reports the worker's first test as failed in ~1ms — an infrastructure
    // failure that reads exactly like a flaky test. Observed as
    // `EADDRINUSE :::4002` taking down three unrelated specs. Fall back to
    // kernel-assigned ports; `baseURL` below already follows the actual port.
    let result;
    let lastErr;
    for (let attempt = 0; attempt < 5; attempt++) {
      const port = attempt === 0 ? 4000 + workerInfo.workerIndex : await freePort();
      try {
        result = await startTestServer(port);
        break;
      } catch (err) {
        lastErr = err;
        if (err?.code !== 'EADDRINUSE') throw err;
      }
    }
    if (!result) {
      throw new Error(`E2E test server could not bind a port: ${lastErr?.message || lastErr}`);
    }
    await use(result);
    // Await the close so a following run is not racing this socket's release.
    await new Promise((resolve) => result.server.close(resolve));
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
