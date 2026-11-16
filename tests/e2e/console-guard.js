// Copyright 2026 Tim Perkins (tjwp) | SPDX-License-Identifier: Apache-2.0
/**
 * Console and page-error guard for the E2E suite.
 *
 * A browser `console.error` or an uncaught exception during a test is a
 * failure even when every assertion passes. The frontend talks to a bundled
 * vendor component through callbacks; a mismatch at that boundary (a callback
 * signature that moved, a missing export) does not fail a locator: it logs a
 * TypeError and the feature quietly renders nothing. The previous CodeView
 * attempt shipped a bridge that rendered zero annotations that way.
 *
 * Every error is checked against ALLOWED below. Each entry carries the reason
 * it is tolerated; an entry without a real reason does not belong here. Add a
 * pattern only for a message the application logs on purpose in a flow a test
 * exercises on purpose (an API failure the test provokes, a 4xx the server is
 * mocked to return). Fix anything else at its source.
 *
 * Environment:
 *   E2E_CONSOLE_GUARD=record   collect and log, never fail (for surveying what
 *                              a new area of the suite logs)
 *   E2E_CONSOLE_LOG=<file>     also append every error seen, allowed or not,
 *                              as JSON lines
 */

const fs = require('fs');

/**
 * Tolerated messages. `pattern` is tested against the message text; when `url`
 * is present it is also tested against the URL the browser attributes the
 * message to (for "Failed to load resource" that is the failed request, and
 * the text alone does not say which one).
 *
 * `kind`, when present, limits the entry to 'console.error' or 'pageerror'
 * (an uncaught exception).
 *
 * Nothing here covers a vendor parser or renderer message. The shared fixture
 * diff used to provoke four of them on every page load (it was malformed,
 * ledger H36) and mismatched file contents a fifth (H37); both causes were
 * removed, so any such message now fails the test that produced it.
 *
 * @type {Array<{pattern: RegExp, url?: RegExp, kind?: string, reason: string}>}
 */
const ALLOWED = [
  // ---- the E2E environment ----
  {
    pattern: /^WebSocket connection to 'ws:\/\/localhost:\d+\/ws' failed/,
    reason: 'tests/e2e/test-server.js mounts no WebSocket endpoint, so every page load of ws-client.js fails its handshake and retries. Live updates are not under test in E2E.',
  },
  {
    // Anchored on the application's own log prefix for each loader that a
    // navigation can interrupt. A bare /TypeError: Failed to fetch/ would also
    // allow an uncaught fetch rejection anywhere, a failed fetch of the vendor
    // bundle or worker, and any new loader's failure: each of those must fail
    // the test until it is looked at and named here.
    kind: 'console.error',
    pattern: new RegExp('^(?:' + [
      'Error loading user comments',
      'Error loading context files',
      'Failed to fetch file contents for [^:]+',
      'Failed to load viewed state from API',
      // The two top-level loaders, each waiting for the first request of its
      // page: a spec that reloads right after its first goto (panel-resize
      // does) cuts that request short. Reproduced on demand by
      // fixture-isolation.spec.js, "A page reloaded while its first request
      // is in flight".
      'Error loading PR',
      'Error loading local review',
      'Error loading files',
      'Error loading local diff',
      'Error loading AI suggestions',
      'Error checking running analysis',
      'Error loading recent reviews',
      'Error loading config',
      'Error loading team-reviews',
      // The same tab's second request: the live refresh (POST) that follows
      // the cached GET. A reload right after applying a team filter
      // (team-reviews-filter.spec.js) interrupts whichever is in flight.
      'Error refreshing team-reviews',
    ].join('|') + '): TypeError: Failed to fetch(?:$|\\s)'),
    reason: 'An in-flight fetch aborted by a navigation, a reload or the page closing at the end of a test: the named loader logs the rejection of what it was loading. The test server is in-process and always up, so for these loaders this is never a server failure. Only console.error lines with one of these prefixes are covered; an uncaught "Failed to fetch" is not.',
  },

  // ---- failures a test provokes on purpose ----
  {
    pattern: /^Failed to load resource: the server responded with a status of 404 \(Not Found\)$/,
    url: /\/api\/pr\/[^/]+\/[^/]+\/\d+$/,
    reason: 'Tests that open a pull request the mock does not have (the "non-existent PR" cases, and dashboard rows that link to PRs not in the database).',
  },
  {
    pattern: /^Error loading PR: Error: Pull request #\d+ not found in repository /,
    reason: 'The frontend log line for the same non-existent pull request cases.',
  },
  {
    pattern: /^Failed to load resource: the server responded with a status of 404 \(Not Found\)$/,
    url: /\/api\/analyses\/test-(local-)?analysis[^/]*\/status$/,
    reason: 'The mocked analysis endpoints hand out ids that the real status route does not know; the progress modal polls it once and gets 404 before the mock reports completion.',
  },
  {
    pattern: /^Failed to load resource: the server responded with a status of 404 \(Not Found\)$/,
    url: /\/api\/bulk-analysis-configs\/missing-(local-)?config$/,
    reason: 'auto-analyze.spec.js asks for a stored config that does not exist, to assert there is no fallback to defaults.',
  },
  {
    pattern: /^Failed to load resource: the server responded with a status of 404 \(Not Found\)$/,
    url: /\/api\/reviews\/\d+\/comments\/\d+\/update-on-github$/,
    reason: 'edited-posted-comments.spec.js "a failed update shows the error": the update is meant to fail.',
  },
];

/**
 * The ALLOWED entry a message matches, or null.
 * @param {string} text
 * @param {string|null} [url]
 * @param {Array} [allowed]
 * @param {string|null} [kind] - 'console.error' or 'pageerror'; an entry that
 *   names a kind only matches that kind
 */
function findAllowance(text, url = null, allowed = ALLOWED, kind = null) {
  return allowed.find((entry) =>
    entry.pattern.test(text) &&
    (!entry.url || (url != null && entry.url.test(url))) &&
    (!entry.kind || entry.kind === kind)
  ) || null;
}

/** One line for a failure message: bounded, single-line. */
function summarize(text) {
  const single = String(text).replace(/\s+/g, ' ').trim();
  return single.length > 300 ? `${single.slice(0, 300)}…` : single;
}

/**
 * Attach the guard to a browser context. Covers every page the context opens.
 * @param {import('@playwright/test').BrowserContext} context
 * @param {Object} [options]
 * @param {string} [options.title] - test title, for the optional log file
 * @returns {{ unexpected: () => string[], all: () => Array<{kind: string, text: string, url: string|null, allowed: boolean}> }}
 */
function attachConsoleGuard(context, { title = '' } = {}) {
  const seen = [];
  const logFile = process.env.E2E_CONSOLE_LOG || null;

  const record = (kind, text, url) => {
    const allowance = findAllowance(text, url || null, ALLOWED, kind);
    const entry = { kind, text, url: url || null, allowed: !!allowance };
    seen.push(entry);
    if (logFile) {
      try {
        fs.appendFileSync(logFile, `${JSON.stringify({ title, kind, allowed: entry.allowed, url: url || null, text: summarize(text) })}\n`);
      } catch {
        // The log is a survey aid; failing to write it must not fail a test.
      }
    }
  };

  context.on('console', (message) => {
    if (message.type() !== 'error') return;
    let url = null;
    try {
      url = message.location().url || null;
    } catch {
      url = null;
    }
    record('console.error', message.text(), url);
  });
  context.on('weberror', (webError) => {
    const error = webError.error();
    record('pageerror', (error && (error.stack || error.message)) || String(error));
  });

  return {
    unexpected: () => seen
      .filter((entry) => !entry.allowed)
      .map((entry) => `[${entry.kind}] ${summarize(entry.text)}${entry.url ? ` (${entry.url})` : ''}`),
    all: () => seen.slice(),
  };
}

/** True when the guard only records (E2E_CONSOLE_GUARD=record). */
function isRecordOnly() {
  return process.env.E2E_CONSOLE_GUARD === 'record';
}

module.exports = { ALLOWED, attachConsoleGuard, findAllowance, summarize, isRecordOnly };
