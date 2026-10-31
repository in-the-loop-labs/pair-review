// Copyright 2026 Tim Perkins (tjwp) | SPDX-License-Identifier: Apache-2.0
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

/**
 * Batch retry safety through the real transport: a real Octokit with a
 * stubbed `globalThis.fetch` rejecting the way native fetch does
 * (`TypeError('fetch failed')`, error code on `cause`). @octokit/request
 * rewraps that as a status-500 error keeping only the message, so this
 * checks the code survives far enough for a never-connected failure to be
 * retried while a connection lost mid-request is not.
 */

const { GitHubClient } = require('../../../src/github/client');

function nativeFetchFailure(code) {
  const cause = Object.assign(new Error(`connect ${code} 127.0.0.1:443`), { code });
  return new TypeError('fetch failed', { cause });
}

function graphqlResponse(data) {
  return new Response(JSON.stringify({ data }), {
    status: 200,
    headers: { 'content-type': 'application/json' }
  });
}

const comments = [{ path: 'a.js', line: 1, side: 'RIGHT', body: 'one' }];

async function runBatches(client) {
  vi.useFakeTimers();
  try {
    const promise = client.addCommentsInBatches('PR_node', 'REVIEW_node', comments, 10);
    promise.catch(() => {});
    await vi.runAllTimersAsync();
    return await promise;
  } finally {
    vi.useRealTimers();
  }
}

describe('GraphQL comment batches through the real transport', () => {
  let originalFetch;

  beforeEach(() => {
    originalFetch = globalThis.fetch;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it.each(['ECONNREFUSED', 'ENOTFOUND', 'EAI_AGAIN'])(
    'retries once after a native fetch failure with %s',
    async (code) => {
      globalThis.fetch = vi.fn()
        .mockRejectedValueOnce(nativeFetchFailure(code))
        .mockResolvedValueOnce(graphqlResponse({ comment0: { thread: { id: 't0' } } }));
      const client = new GitHubClient('test-token');

      const result = await runBatches(client);

      expect(globalThis.fetch).toHaveBeenCalledTimes(2);
      expect(result).toEqual({ successCount: 1, failed: false, failedDetails: [] });
    }
  );

  it('does not re-send after a connection lost mid-request', async () => {
    globalThis.fetch = vi.fn()
      .mockRejectedValueOnce(nativeFetchFailure('ECONNRESET'))
      .mockResolvedValueOnce(graphqlResponse({ comment0: { thread: { id: 't0' } } }));
    const client = new GitHubClient('test-token');

    const result = await runBatches(client);

    expect(globalThis.fetch).toHaveBeenCalledTimes(1);
    expect(result.failed).toBe(true);
    expect(result.failedDetails).toEqual(['a.js:1 - fetch failed (ECONNRESET)']);
  });

  it('does not re-send after a fetch failure with no error code', async () => {
    globalThis.fetch = vi.fn()
      .mockRejectedValueOnce(new TypeError('fetch failed'))
      .mockResolvedValueOnce(graphqlResponse({ comment0: { thread: { id: 't0' } } }));
    const client = new GitHubClient('test-token');

    const result = await runBatches(client);

    expect(globalThis.fetch).toHaveBeenCalledTimes(1);
    expect(result.failed).toBe(true);
  });
});
