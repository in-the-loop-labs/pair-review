// Copyright 2026 Tim Perkins (tjwp) | SPDX-License-Identifier: Apache-2.0
/**
 * tests/e2e/console-guard.js decides, for every browser console.error and
 * uncaught page error in an E2E run, whether the test fails. A pattern that is
 * too wide silently switches the guard off for a whole class of errors, so the
 * matching rules are tested here against the real module.
 */

import { describe, it, expect } from 'vitest';

const { EventEmitter } = require('events');
const { ALLOWED, attachConsoleGuard, findAllowance, summarize } = require('../e2e/console-guard');

const NOT_FOUND = 'Failed to load resource: the server responded with a status of 404 (Not Found)';
const SERVER_ERROR = 'Failed to load resource: the server responded with a status of 500 (Internal Server Error)';

/** A stand-in for Playwright's BrowserContext: only the two events the guard listens to. */
function fakeContext() {
  const emitter = new EventEmitter();
  return {
    on: (name, handler) => emitter.on(name, handler),
    console: (type, text, url) => emitter.emit('console', {
      type: () => type,
      text: () => text,
      location: () => ({ url }),
    }),
    weberror: (error) => emitter.emit('weberror', { error: () => error }),
  };
}

describe('ALLOWED', () => {
  it('gives every entry a pattern and a real reason', () => {
    expect(ALLOWED.length).toBeGreaterThan(0);
    for (const entry of ALLOWED) {
      expect(entry.pattern).toBeInstanceOf(RegExp);
      expect(typeof entry.reason).toBe('string');
      expect(entry.reason.length).toBeGreaterThan(40);
      if (entry.url !== undefined) expect(entry.url).toBeInstanceOf(RegExp);
    }
  });

  it('never allows a bare "Failed to load resource" without naming the request', () => {
    // The text of that message is the same for every URL. An entry for it
    // without a `url` would allow every 404 and 500 in the suite.
    for (const entry of ALLOWED) {
      if (entry.pattern.test(NOT_FOUND) || entry.pattern.test(SERVER_ERROR)) {
        expect(entry.url, `entry for "${entry.pattern}" needs a url`).toBeInstanceOf(RegExp);
      }
    }
  });
});

describe('findAllowance', () => {
  it('allows no vendor parser or renderer message', () => {
    // The shared fixture diff was malformed and provoked these on every page
    // load; it was fixed, and the allowances went with it. A malformed patch
    // or mismatched contents must fail the test that produced them.
    expect(findAllowance('parsePatchContent: hunk line count mismatch: "@@ -1,5 +1,8 @@", declared old/new 5/8, parsed old/new 4/7', null, ALLOWED, 'console.error')).toBeNull();
    expect(findAllowance('parsePatchContent: hunk line count mismatch: "@@ -3,7 +3,9 @@", declared old/new 7/9, parsed old/new 6/9', null, ALLOWED, 'console.error')).toBeNull();
    expect(findAllowance('processFile: invalid rawLine: ', null, ALLOWED, 'console.error')).toBeNull();
    expect(findAllowance('parseLineType: Invalid firstChar: " ", full line: " "', null, ALLOWED, 'console.error')).toBeNull();
    expect(findAllowance('DiffHunksRenderer.processDiffResult: deletionLine and additionLine are null, something is wrong {file: q.sql}', null, ALLOWED, 'console.error')).toBeNull();
  });

  it('allows an interrupted fetch only as a console.error from a named loader', () => {
    const logged = (prefix) => `${prefix}: TypeError: Failed to fetch\n    at window.fetch (http://localhost:4001/js/pr.js:1:1)`;
    expect(findAllowance(logged('Error loading user comments'), null, ALLOWED, 'console.error')).not.toBeNull();
    expect(findAllowance(logged('Failed to fetch file contents for src/main.js'), null, ALLOWED, 'console.error')).not.toBeNull();
    expect(findAllowance('Error loading context files: TypeError: Failed to fetch', null, ALLOWED, 'console.error')).not.toBeNull();
    // Both requests of the Team Review Requests tab: the cached GET and the refresh that follows it.
    expect(findAllowance(logged('Error loading team-reviews'), null, ALLOWED, 'console.error')).not.toBeNull();
    expect(findAllowance(logged('Error refreshing team-reviews'), null, ALLOWED, 'console.error')).not.toBeNull();
    // The two top-level loaders, cut short by a reload right after the first goto.
    expect(findAllowance(logged('Error loading PR'), null, ALLOWED, 'console.error')).not.toBeNull();
    expect(findAllowance(logged('Error loading local review'), null, ALLOWED, 'console.error')).not.toBeNull();
    // A pull request that failed to load for another reason is a failure.
    expect(findAllowance('Error loading PR: Error: Failed to load PR', null, ALLOWED, 'console.error')).toBeNull();
    // A refresh that failed for another reason is a failure.
    expect(findAllowance('Error refreshing team-reviews: Error: Refresh failed', null, ALLOWED, 'console.error')).toBeNull();
    expect(findAllowance(logged('Error refreshing my-prs'), null, ALLOWED, 'console.error')).toBeNull();
    // An uncaught rejection is a different thing from a logged one.
    expect(findAllowance('TypeError: Failed to fetch', null, ALLOWED, 'pageerror')).toBeNull();
    expect(findAllowance(logged('Error loading user comments'), null, ALLOWED, 'pageerror')).toBeNull();
    // A bare message, or one from a loader nobody has looked at.
    expect(findAllowance('TypeError: Failed to fetch', null, ALLOWED, 'console.error')).toBeNull();
    expect(findAllowance(logged('Error loading the vendor bundle'), null, ALLOWED, 'console.error')).toBeNull();
    // The words in the middle of some other message.
    expect(findAllowance('[PierreBridge] worker init failed: TypeError: Failed to fetch', null, ALLOWED, 'console.error')).toBeNull();
    expect(findAllowance('Error loading user comments: TypeError: Failed to fetchSomethingElse', null, ALLOWED, 'console.error')).toBeNull();
  });

  it('applies an entry that names a kind to that kind only', () => {
    const list = [{ pattern: /^boom$/, kind: 'console.error', reason: 'test' }];
    expect(findAllowance('boom', null, list, 'console.error')).toBe(list[0]);
    expect(findAllowance('boom', null, list, 'pageerror')).toBeNull();
    expect(findAllowance('boom', null, list)).toBeNull();
  });

  it('matches "Failed to load resource" only together with its URL', () => {
    expect(findAllowance(NOT_FOUND, 'http://localhost:4003/api/pr/test-owner/test-repo/999')).not.toBeNull();
    expect(findAllowance(NOT_FOUND, 'http://localhost:4003/api/analyses/test-analysis-1794537864300/status')).not.toBeNull();
    // Same text, a request nobody expects to fail.
    expect(findAllowance(NOT_FOUND, 'http://localhost:4003/js/vendor/pierre-diffs.js')).toBeNull();
    expect(findAllowance(SERVER_ERROR, 'http://localhost:4003/api/reviews/1/comments')).toBeNull();
    expect(findAllowance(SERVER_ERROR, 'http://localhost:4001/api/local/2/refresh')).toBeNull();
    // No URL at all: cannot be attributed, so not allowed.
    expect(findAllowance(NOT_FOUND)).toBeNull();
    expect(findAllowance(NOT_FOUND, null)).toBeNull();
  });

  it('does not allow an ordinary application error', () => {
    expect(findAllowance("TypeError: Cannot read properties of undefined (reading 'item')")).toBeNull();
    expect(findAllowance('[PierreBridge] custom annotation renderer for "tour-stop" failed: Error: boom')).toBeNull();
    expect(findAllowance('')).toBeNull();
  });

  it('accepts a custom list', () => {
    const list = [{ pattern: /^boom$/, reason: 'test' }];
    expect(findAllowance('boom', null, list)).toBe(list[0]);
    expect(findAllowance('boom!', null, list)).toBeNull();
  });
});

describe('summarize', () => {
  it('collapses whitespace and bounds the length', () => {
    expect(summarize('a\n   b\t c ')).toBe('a b c');
    const long = summarize('x'.repeat(1000));
    expect(long.length).toBe(301);
    expect(long.endsWith('…')).toBe(true);
    expect(summarize(undefined)).toBe('undefined');
  });
});

describe('attachConsoleGuard', () => {
  it('reports console.error and uncaught errors, and ignores other console levels', () => {
    const context = fakeContext();
    const guard = attachConsoleGuard(context);
    context.console('log', 'just a log', 'http://localhost:4000/js/pr.js');
    context.console('warning', 'a warning', 'http://localhost:4000/js/pr.js');
    expect(guard.unexpected()).toEqual([]);

    context.console('error', "TypeError: annotation.metadata is undefined", 'http://localhost:4000/js/modules/pierre-bridge.js');
    context.weberror(new Error('uncaught in a vendor callback'));
    const unexpected = guard.unexpected();
    expect(unexpected.length).toBe(2);
    expect(unexpected[0]).toBe('[console.error] TypeError: annotation.metadata is undefined (http://localhost:4000/js/modules/pierre-bridge.js)');
    expect(unexpected[1]).toMatch(/^\[pageerror\] Error: uncaught in a vendor callback/);
  });

  it('keeps allowed messages out of the failure list but in the full record', () => {
    const context = fakeContext();
    const guard = attachConsoleGuard(context);
    context.console('error', "WebSocket connection to 'ws://localhost:4002/ws' failed: Error during WebSocket handshake: Unexpected response code: 404", 'http://localhost:4002/js/ws-client.js');
    context.console('error', NOT_FOUND, 'http://localhost:4002/api/pr/test-owner/test-repo/999');
    expect(guard.unexpected()).toEqual([]);
    expect(guard.all().map((entry) => entry.allowed)).toEqual([true, true]);
  });

  it('survives a console message whose location cannot be read', () => {
    const emitter = new EventEmitter();
    const guard = attachConsoleGuard({ on: (name, handler) => emitter.on(name, handler) });
    emitter.emit('console', { type: () => 'error', text: () => 'no location', location: () => { throw new Error('gone'); } });
    expect(guard.unexpected()).toEqual(['[console.error] no location']);
  });
});
