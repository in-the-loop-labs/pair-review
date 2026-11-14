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
 * Ports Chromium refuses to navigate to (net::ERR_UNSAFE_PORT), within reach
 * of 4000 + workerIndex. The worker index grows by one every time Playwright
 * replaces a worker process, so a long run (or --repeat-each) gets there:
 * observed as `page.goto: net::ERR_UNSAFE_PORT at http://localhost:4045/...`
 * failing one test of a 120-execution run. The server binds such a port
 * without complaint; only the browser objects.
 */
const CHROMIUM_UNSAFE_PORTS = new Set([4045, 4190, 5060, 5061]);

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
    const expectedHere = (line) => expectedConsoleErrors.some((pattern) => pattern.test(line));
    const unexpected = guard.unexpected().filter((line) => !expectedHere(line));
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
