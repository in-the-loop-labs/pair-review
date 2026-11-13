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
import { attachConsoleGuard, isRecordOnly } from './console-guard.js';

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

/**
 * Which diff engine the frontend should use, from PR_ENGINE.
 *
 * The CodeView migration (plans/codeview-virtualized-diff.md) builds the new
 * engine behind `window.__PAIR_REVIEW_DIFF_ENGINE === 'codeview'` so the same
 * specs can run against both engines. Nothing reads the flag yet: until the
 * cut-over phases wire it into PRManager, setting it changes nothing.
 * An unknown value is an error, not a silent run on the default engine.
 */
function requestedDiffEngine() {
  const value = process.env.PR_ENGINE;
  if (value === undefined || value === '' || value === 'filediff') return null;
  if (value === 'codeview') return 'codeview';
  throw new Error(`PR_ENGINE must be "codeview" or "filediff" (got "${value}")`);
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

  // Console and page-error guard (see console-guard.js), and the diff-engine
  // flag. Both are attached to the context, not the page, so they cover every
  // page a test opens (a second tab, a popup), not only the `page` fixture.
  context: async ({ context }, use, testInfo) => {
    const guard = attachConsoleGuard(context, { title: testInfo.titlePath.join(' › ') });
    const engine = requestedDiffEngine();
    if (engine) {
      // Sets a global only. An init script runs before the parser has created
      // <html>: `document.head` and `document.documentElement` are both null
      // here, so an init script cannot touch the DOM.
      await context.addInitScript((value) => {
        window.__PAIR_REVIEW_DIFF_ENGINE = value;
      }, engine);
    }
    await use(context);
    const unexpected = guard.unexpected();
    if (unexpected.length > 0 && !isRecordOnly()) {
      throw new Error(
        `Console guard: ${unexpected.length} unexpected console error(s) or page error(s) during this test.\n` +
        `Fix the source, or add a reasoned entry to ALLOWED in tests/e2e/console-guard.js.\n` +
        unexpected.slice(0, 10).map((line) => `  ${line}`).join('\n')
      );
    }
  },

  // There is deliberately no `page` override. CSS transitions and animations
  // are ON in E2E, exactly as in production.
  //
  // This file used to override `page` to register an init script that appended
  // a "transition-duration: 0s !important" style to
  // `document.head || document.documentElement`. Both are null when an init
  // script runs, on every navigation, so the script threw a TypeError once per
  // document and styled nothing. Measured over a whole run: 714 documents,
  // 0 styled. It was deleted, not repaired, because every result this suite has
  // ever produced was measured with transitions on, and a width transition
  // (the AI panel) changes what the diff measures. So a spec must not assume a
  // transition is instant: poll for the settled value (`expect.poll`,
  // `toHaveCSS`), never read geometry once right after a class change, and
  // never sleep. See "Playwright E2E" in tests/CONVENTIONS.md and hazard H41
  // in plans/codeview-virtualized-diff.md.
});

export { test, expect };
