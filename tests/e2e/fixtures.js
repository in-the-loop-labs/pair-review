// Copyright 2026 Tim Perkins (tjwp) | SPDX-License-Identifier: Apache-2.0
/**
 * Playwright fixtures for per-worker test server isolation.
 *
 * Each worker gets its own Express server on a unique port with its own
 * in-memory SQLite database, enabling safe parallel execution.
 */

import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { test as base, expect } from '@playwright/test';
import { startTestServer } from './test-server.js';
import { attachConsoleGuard, isRecordOnly } from './console-guard.js';
import { layoutValidator, orphanHostsAtEnd } from './diff-dom.js';

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
 * Ports Chromium refuses to navigate to (net::ERR_UNSAFE_PORT), within reach
 * of 4000 + workerIndex. The worker index grows by one every time Playwright
 * replaces a worker process, so a long run (or --repeat-each) gets there:
 * observed as `page.goto: net::ERR_UNSAFE_PORT at http://localhost:4045/...`
 * failing one test of a 120-execution run. The server binds such a port
 * without complaint; only the browser objects.
 */
const CHROMIUM_UNSAFE_PORTS = new Set([4045, 4190, 5060, 5061]);

/**
 * Whether the page gets the vendor's DEVELOPMENT bundle, from
 * PR_VENDOR_BUNDLE=dev.
 *
 * The development bundle has the viewer's own layout validator compiled in:
 * with `__devOnlyValidateItemHeights` it compares every mounted item's
 * measured height with the height its layout computed and logs a
 * `console.error` on a mismatch, which the console guard turns into a failed
 * test. A run with it asserts the viewer's layout under every scenario of
 * the suite, not only where a spec looks. It is built by
 * `scripts/build-pierre-diffs.mjs` next to the shipped bundle
 * (tests/.cache/pierre-diffs.dev.js; the contract suite's global setup
 * checks its version).
 */
function requestedVendorBundle() {
  const value = process.env.PR_VENDOR_BUNDLE;
  if (value === undefined || value === '' || value === 'shipped') return null;
  if (value === 'dev') return path.join(__dirname, '..', '.cache', 'pierre-diffs.dev.js');
  throw new Error(`PR_VENDOR_BUNDLE must be "dev" or "shipped" (got "${value}")`);
}

/** The reviews tests/e2e/test-server.js seeds: 1 is the pull request, 2 the Local review. */
const FIXTURE_REVIEW_IDS = [1, 2];

/**
 * Retire every user comment, delete every AI suggestion and analysis run, and
 * remove every context file of the fixture reviews, then check in the
 * worker's database that nothing of the three is left. Throws when a route
 * refuses or when rows remain: a silent failure here would hand the rows to
 * whichever test the worker runs next.
 *
 * What it cannot see is a request the page sent and never waited for, still
 * on its way when the test ended. A test waits for the saves it triggers
 * (tests/CONVENTIONS.md), and the page is closed before this runs.
 */
async function resetFixtureReviews(testServer) {
  // A comment save answers before the server has added its context file
  // (see `whenBackgroundWorkDone` in test-server.js): let that land first.
  await testServer.whenBackgroundWorkDone();
  const origin = `http://localhost:${testServer.port}`;
  const call = async (method, path, { tolerate = [] } = {}) => {
    const response = await fetch(`${origin}${path}`, { method });
    if (!response.ok && !tolerate.includes(response.status)) {
      throw new Error(`E2E isolation: ${method} ${path} answered ${response.status} ${await response.text()}`);
    }
    return response;
  };
  for (const reviewId of FIXTURE_REVIEW_IDS) {
    // One by one: the bulk route ("Clear All") leaves posted comments alone.
    const listed = await (await call('GET', `/api/reviews/${reviewId}/comments`)).json();
    for (const comment of (listed.comments || [])) {
      // 404: retired between the listing and here by a request still in flight.
      await call('DELETE', `/api/reviews/${reviewId}/comments/${comment.id}`, { tolerate: [404] });
    }
    await call('DELETE', `/api/reviews/${reviewId}/ai-suggestions`);
    await call('DELETE', `/api/reviews/${reviewId}/context-files`);
  }
  const ids = FIXTURE_REVIEW_IDS.join(', ');
  const left = testServer.db.prepare(`
    SELECT
      (SELECT COUNT(*) FROM comments WHERE review_id IN (${ids}) AND source = 'user' AND status = 'active') AS comments,
      (SELECT COUNT(*) FROM comments WHERE review_id IN (${ids}) AND source = 'ai') AS suggestions,
      (SELECT COUNT(*) FROM context_files WHERE review_id IN (${ids})) AS contextFiles
  `).get();
  if (left.comments || left.suggestions || left.contextFiles) {
    throw new Error(`E2E isolation: rows left on the fixture reviews after the reset: ${JSON.stringify(left)}`);
  }
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
      const preferred = 4000 + workerInfo.workerIndex;
      const port = attempt === 0 && !CHROMIUM_UNSAFE_PORTS.has(preferred) ? preferred : await freePort();
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
  // Console errors ONE test provokes on purpose (it blocks the worker script,
  // it makes a save fail): `test.use({ expectedConsoleErrors: [/^.../] })` in
  // that describe block. Scoped to the tests that opt in, so the same message
  // anywhere else still fails. Not a place for messages a test does not cause.
  // Each pattern is tested against the guard's report line:
  // `[console.error] <text> (<url>)` or `[pageerror] <text>`.
  expectedConsoleErrors: [[], { option: true }],

  context: async ({ context, expectedConsoleErrors }, use, testInfo) => {
    const guard = attachConsoleGuard(context, { title: testInfo.titlePath.join(' › ') });
    const devBundle = requestedVendorBundle();
    if (devBundle) {
      if (!fs.existsSync(devBundle)) {
        throw new Error(`PR_VENDOR_BUNDLE=dev: ${devBundle} is missing; build it with "node scripts/build-pierre-diffs.mjs --dev"`);
      }
      // On the context, so a route a spec puts on its page (a spec that
      // blocks the bundle) still wins.
      await context.route(/\/js\/vendor\/pierre-diffs\.js(\?.*)?$/, (route) => route.fulfill({
        path: devBundle, contentType: 'application/javascript'
      }));
      // The validator is an option of the viewer, which the application
      // does not pass, and what it reports is the viewer's business: both
      // are the engine half's (tests/e2e/diff-dom-codeview.js).
      await context.addInitScript(layoutValidator.installInPage);
    }
    await use(context);
    // A development-bundle run: whatever the test did, the viewer's layout
    // is exact once the pane rests. One more validating pass (a pixel of
    // scroll downward, the way a wheel moves it) must report nothing.
    const restless = [];
    // A check that cannot run is not a check that passed: it is reported,
    // unless the test closed the page. A page that is navigating when the
    // test ends gets one more try on the document it arrives at.
    const endOfTestCheck = async (page, label, run, missing) => {
      for (let attempt = 0; ; attempt++) {
        if (page.isClosed()) return missing;
        try {
          return await run(page);
        } catch (error) {
          if (page.isClosed()) return missing;
          const navigating = /Execution context was destroyed|navigation|Target page, context or browser has been closed/i.test(String(error && error.message));
          if (navigating && attempt === 0) {
            await page.waitForLoadState('domcontentloaded').catch(() => {});
            continue;
          }
          restless.push(`[${label}] the end-of-test check could not run: ${String(error && error.message).split('\n')[0]} (${page.url()})`);
          return missing;
        }
      }
    };
    // Every test, on an engine that can leave one: no orphan host when it ends.
    for (const page of context.pages()) {
      const problems = await endOfTestCheck(page, 'hosts', orphanHostsAtEnd, []);
      for (const problem of problems) restless.push(`[hosts] ${problem} (${page.url()})`);
    }
    if (devBundle) {
      for (const page of context.pages()) {
        const reports = await endOfTestCheck(page, 'layout', layoutValidator.reportsAtRest, 0);
        if (reports > 0) restless.push(`[layout] ${reports} validator report(s) with the pane at rest (${page.url()})`);
      }
    }
    const expectedHere = (line) => expectedConsoleErrors.some((pattern) => pattern.test(line));
    const unexpected = [...guard.unexpected().filter((line) => !expectedHere(line)), ...restless];
    if (unexpected.length > 0 && !isRecordOnly()) {
      throw new Error(
        `Console guard: ${unexpected.length} unexpected console error(s) or page error(s) during this test.\n` +
        `Fix the source, or add a reasoned entry to ALLOWED in tests/e2e/console-guard.js.\n` +
        unexpected.slice(0, 10).map((line) => `  ${line}`).join('\n')
      );
    }
  },

  // What a test drew on the two fixture reviews does not outlive it.
  //
  // A worker's database is shared by every spec file that worker runs, and
  // which files share a worker changes from run to run. A comment, an AI
  // suggestion or a context file left on a fixture review is rendered by the
  // next page load of that review, whichever spec makes it: an extra card, an
  // extra file in the pane and the sidebar, different counts. Cleaning up in
  // each describe's own `afterEach` leaves that to every author and every
  // rewrite; one such hook was lost in a rewrite, and a census of what each
  // test leaves behind found thirteen describes leaving user comments and
  // fourteen leaving AI suggestions, most of them on main before that.
  //
  // So it is done here, once, after every test, through the same routes the
  // cleanup helpers use (a user comment is retired, not erased, exactly as a
  // reader's delete does). Registered as an automatic fixture that depends on
  // nothing of the browser, so it is set up before `context` and `page` and
  // torn down after them: the page that could still be saving something is
  // closed by then. A describe's own cleanup in `beforeEach` or `afterEach`
  // is still fine and still needed for anything else a spec creates (another
  // review, a setting, viewed state it did not mock).
  fixtureReviewsLeftClean: [async ({ testServer }, use) => {
    await use();
    await resetFixtureReviews(testServer);
  }, { auto: true }],

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
