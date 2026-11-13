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
  it('allows the messages the shared fixture diff provokes, exactly', () => {
    expect(findAllowance('parsePatchContent: hunk line count mismatch: "@@ -1,5 +1,8 @@", declared old/new 5/8, parsed old/new 4/7')).not.toBeNull();
    expect(findAllowance('processFile: invalid rawLine: ')).not.toBeNull();
    expect(findAllowance('parseLineType: Invalid firstChar: " ", full line: " "')).not.toBeNull();
  });

  it('does not allow the same vendor message for any other hunk', () => {
    // A malformed patch produced by application code must still fail a test.
    expect(findAllowance('parsePatchContent: hunk line count mismatch: "@@ -3,7 +3,9 @@", declared old/new 7/9, parsed old/new 6/9')).toBeNull();
    expect(findAllowance('parseLineType: Invalid firstChar: "x", full line: "x = 1"')).toBeNull();
  });

  it('matches "Failed to load resource" only together with its URL', () => {
    expect(findAllowance(NOT_FOUND, 'http://localhost:4003/api/pr/test-owner/test-repo/999')).not.toBeNull();
    expect(findAllowance(NOT_FOUND, 'http://localhost:4003/api/analyses/test-analysis-1794537864300/status')).not.toBeNull();
    expect(findAllowance(SERVER_ERROR, 'http://localhost:4001/api/local/2/refresh')).not.toBeNull();
    // Same text, a request nobody expects to fail.
    expect(findAllowance(NOT_FOUND, 'http://localhost:4003/js/vendor/pierre-diffs.js')).toBeNull();
    expect(findAllowance(SERVER_ERROR, 'http://localhost:4003/api/reviews/1/comments')).toBeNull();
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
