// Copyright 2026 Tim Perkins (tjwp) | SPDX-License-Identifier: Apache-2.0
// @vitest-environment jsdom
/**
 * The fetch interceptor tags review mutations with X-Client-Id so the server
 * can mark its review:comments_changed broadcast and the originating tab can
 * skip its own echo. Review submission broadcasts too (issue #612), so it
 * must carry the id, or the submitting tab reloads twice.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

const { PRManager } = require('../../public/js/pr.js');

let originalFetch;
let innerFetch;

beforeEach(() => {
  originalFetch = window.fetch;
  innerFetch = vi.fn().mockResolvedValue({ ok: true });
  window.fetch = innerFetch;
  delete window._prFetchIntercepted;
  const manager = Object.create(PRManager.prototype);
  manager._clientId = 'tab-a';
  manager._installFetchInterceptor();
});

afterEach(() => {
  window.fetch = originalFetch;
  delete window._prFetchIntercepted;
});

function sentHeaders() {
  return innerFetch.mock.calls[0][1]?.headers;
}

describe('X-Client-Id fetch interceptor', () => {
  it('tags review submission', async () => {
    await window.fetch('/api/pr/acme/widget/7/submit-review', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: '{}'
    });
    expect(sentHeaders()).toEqual({ 'Content-Type': 'application/json', 'X-Client-Id': 'tab-a' });
  });

  it('still tags reviews API mutations', async () => {
    await window.fetch('/api/reviews/42/comments', { method: 'POST' });
    expect(sentHeaders()).toEqual({ 'X-Client-Id': 'tab-a' });
  });

  it('leaves other PR routes and reads alone', async () => {
    await window.fetch('/api/pr/acme/widget/7/refresh', { method: 'POST' });
    await window.fetch('/api/pr/acme/widget/7/submit-review');
    expect(innerFetch.mock.calls[0][1]?.headers).toBeUndefined();
    expect(innerFetch.mock.calls[1][1]).toBeUndefined();
  });
});
