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
 * @type {Array<{pattern: RegExp, url?: RegExp, reason: string}>}
 */
const ALLOWED = [
  // ---- the E2E environment ----
  {
    pattern: /^WebSocket connection to 'ws:\/\/localhost:\d+\/ws' failed/,
    reason: 'tests/e2e/test-server.js mounts no WebSocket endpoint, so every page load of ws-client.js fails its handshake and retries. Live updates are not under test in E2E.',
  },
  {
    pattern: /TypeError: Failed to fetch/,
    reason: 'An in-flight fetch aborted by a navigation, a reload or the page closing at the end of a test. The app logs the rejection of whatever was loading (comments, context files, file contents, viewed state). The test server is in-process and always up, so this is never a server failure.',
  },
  {
    pattern: /^Failed to load resource: the server responded with a status of 500 \(Internal Server Error\)$/,
    url: /\/api\/local\/\d+\/refresh$/,
    reason: 'Local mode refreshes its diff on load. The fixture review points at a worktree path that does not exist, so the real route fails to run git and answers 500.',
  },
  {
    pattern: /^Error refreshing diff: Error: Failed to refresh diff: Failed to generate scoped diff: spawnSync \/bin\/sh ENOENT/,
    reason: 'The frontend log line for the Local-mode refresh failure described above.',
  },

  // ---- the shared fixture diff ----
  {
    pattern: /^parsePatchContent: hunk line count mismatch: "@@ -1,5 \+1,8 @@", declared old\/new 5\/8, parsed old\/new 4\/7$/,
    reason: 'The fixture diff in tests/e2e/test-server.js is not a well-formed unified diff: the first hunk of src/utils.js declares 5/8 lines and contains 4/7. The vendor parser reports it and renders what it parsed. About 100 specs index rows of this fixture by position, so it is not changed here; see "Open items" in plans/codeview-virtualized-diff.md.',
  },
  {
    pattern: /^parsePatchContent: hunk line count mismatch: "@@ -10,6 \+10,10 @@", declared old\/new 6\/10, parsed old\/new 4\/9$/,
    reason: 'Same fixture: the src/main.js hunk declares 6/10 lines and contains 4/9 that the parser accepts.',
  },
  {
    pattern: /^processFile: invalid rawLine:\s*$/,
    reason: 'Same fixture: a blank context line without its leading space, and a blank line between the two file sections.',
  },
  {
    pattern: /^parseLineType: Invalid firstChar: "\s*", full line: "\s*"$/,
    reason: 'Same fixture: the vendor parser\'s report for the blank lines above.',
  },
  {
    pattern: /^parsePatchContent: hunk line count mismatch: "@@ -1,1 \+1,20100 @@", declared old\/new 1\/20100, parsed old\/new 0\/20100$/,
    reason: 'The generated large diff in lazy-diff.spec.js declares one old line and has none.',
  },
  {
    pattern: /DiffHunksRenderer\.processDiffResult: deletionLine and additionLine are null, something is wrong/,
    reason: 'The file-contents mock answers every unregistered path with a generic 40-line body. When the idle content upgrade re-renders a file with contents that do not belong to its patch, a highlight result for the old diff can meet the new one and the vendor reports the mismatch. Seen on q.sql in diff-header-lookalike-stats.spec.js. Goes away when the mock serves truthful contents per path.',
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
 */
function findAllowance(text, url = null, allowed = ALLOWED) {
  return allowed.find((entry) => entry.pattern.test(text) && (!entry.url || (url != null && entry.url.test(url)))) || null;
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
    const allowance = findAllowance(text, url || null);
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
