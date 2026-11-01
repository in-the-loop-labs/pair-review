// Copyright 2026 Tim Perkins (tjwp) | SPDX-License-Identifier: Apache-2.0
import { describe, it, expect, vi } from 'vitest';

/**
 * Unit tests for the GraphQL implementation of the
 * `pending_review_comments` area. These focus on `buildBatchMutation`,
 * which interpolates user-supplied values (file paths, bodies) into a
 * raw GraphQL document. Path and body must be encoded with
 * JSON.stringify so values containing quotes, backslashes, or
 * newlines do not produce a malformed mutation that fails the whole
 * batch.
 */

const graphqlImpl = require('../../../../../src/github/impl/graphql/pending-review-comments');
const { buildBatchMutation, addCommentsInBatches, isSafeToRetry, MIN_BATCH_SIZE } = graphqlImpl;

/**
 * Run addCommentsInBatches through its real retry loop with fake timers,
 * so the fixed 1s retry delay elapses instantly.
 */
async function runBatches(graphql, comments, batchSize = 10) {
  vi.useFakeTimers();
  try {
    const promise = addCommentsInBatches({ graphql }, 'PR_node', 'REVIEW_node', comments, batchSize);
    promise.catch(() => {});
    await vi.runAllTimersAsync();
    return await promise;
  } finally {
    vi.useRealTimers();
  }
}

function httpError(message, status, withResponse = true) {
  const error = new Error(message);
  error.name = 'HttpError';
  error.status = status;
  if (withResponse) error.response = { status, headers: {}, data: { message } };
  return error;
}

const twoComments = [
  { path: 'a.js', line: 1, side: 'RIGHT', body: 'one' },
  { path: 'b.js', line: 2, side: 'RIGHT', body: 'two' }
];
const bothAdded = {
  comment0: { thread: { id: 't0' } },
  comment1: { thread: { id: 't1' } }
};
// Posted entries for threads returned without comment metadata.
const postedAt = (...indexes) => indexes.map(index => ({
  index, github_comment_id: null, github_comment_node_id: null, github_comment_url: null
}));

/**
 * Pull out the GraphQL string literal that follows a given field
 * name in the mutation text. Returns the raw literal as it appears
 * in the document (including the surrounding double quotes). Used so
 * tests can JSON.parse it and confirm the embedded value round-trips
 * back to the original input.
 */
function extractStringLiteral(mutation, fieldName) {
  // Matches: <fieldName>: "<contents>" where <contents> is any
  // sequence of non-quote chars or escaped chars (\\, \", \uXXXX, ...).
  const re = new RegExp(`${fieldName}:\\s*("(?:\\\\.|[^"\\\\])*")`);
  const match = mutation.match(re);
  if (!match) {
    throw new Error(`Could not find ${fieldName} string literal in mutation:\n${mutation}`);
  }
  return match[1];
}

describe('impl/graphql/pending-review-comments', () => {
  describe('addCommentsInBatches retry safety', () => {
    // Each of these may have been applied by GitHub before the response was
    // lost, so re-sending the batch would add every comment twice.
    it.each([
      ['a lost connection with no response', httpError('read ECONNRESET', 500, false)],
      ['a request timeout', Object.assign(new Error('Request timed out'), { code: 'ETIMEDOUT' })],
      ['a 502 from GitHub', httpError('Bad Gateway', 502)],
      ['a 500 from GitHub', httpError('Internal Server Error', 500)],
      ['a 502 from GitHub whose message names ECONNREFUSED', httpError('upstream connect ECONNREFUSED 10.0.0.1:443', 502)],
      ['an unknown error', new Error('socket hang up')],
      ['a GraphQL timeout with no data', Object.assign(new Error('timeout'), {
        errors: [{ message: 'Something went wrong while executing your query. This may be the result of a timeout.' }]
      })],
      ['a GraphQL error with data: null', Object.assign(new Error('failed'), {
        data: null, errors: [{ message: 'failed' }]
      })]
    ])('does not re-send the batch after %s', async (_label, error) => {
      const graphql = vi.fn()
        .mockRejectedValueOnce(error)
        .mockResolvedValueOnce(bothAdded);

      const result = await runBatches(graphql, twoComments);

      expect(graphql).toHaveBeenCalledTimes(1);
      expect(result.successCount).toBe(0);
      expect(result.failed).toBe(true);
      expect(result.failedDetails).toEqual([
        `a.js:1 - ${error.message}`,
        `b.js:2 - ${error.message}`
      ]);
      // GitHub may have added these comments, so the added subset is unknown.
      expect(result.posted).toBeNull();
    });

    // GitHub did not run the mutation for any of these, so one retry is safe.
    it.each([
      ['a refused connection', httpError('request to https://api.github.com/graphql failed, reason: connect ECONNREFUSED 127.0.0.1:443', 500, false)],
      ['a DNS failure', Object.assign(new Error('fetch failed'), { cause: { code: 'ENOTFOUND' } })],
      ['a 4xx rejection', httpError('You have exceeded a secondary rate limit', 403)],
      ['a GraphQL error response with no data', Object.assign(new Error('rate limited'), {
        errors: [{ type: 'RATE_LIMITED', message: 'API rate limit exceeded' }]
      })]
    ])('retries once after %s', async (_label, error) => {
      const graphql = vi.fn()
        .mockRejectedValueOnce(error)
        .mockResolvedValueOnce(bothAdded);

      const result = await runBatches(graphql, twoComments);

      expect(graphql).toHaveBeenCalledTimes(2);
      expect(result).toEqual({ successCount: 2, failed: false, failedDetails: [], posted: postedAt(0, 1) });
    });

    it('stops after one retry of a safe failure', async () => {
      const graphql = vi.fn().mockRejectedValue(new Error('getaddrinfo EAI_AGAIN api.github.com'));

      const result = await runBatches(graphql, twoComments);

      expect(graphql).toHaveBeenCalledTimes(2);
      expect(result.failed).toBe(true);
      expect(result.successCount).toBe(0);
      // GitHub never ran the batch, so it is known that nothing was added.
      expect(result.posted).toEqual([]);
    });

    it('never re-sends a batch that returned partial data', async () => {
      const partial = Object.assign(new Error('partial'), {
        data: { comment0: { thread: { id: 't0' } }, comment1: null },
        errors: [{ path: ['comment1'], message: 'line is not part of the diff' }]
      });
      const graphql = vi.fn()
        .mockRejectedValueOnce(partial)
        .mockResolvedValueOnce(bothAdded);

      const result = await runBatches(graphql, twoComments);

      expect(graphql).toHaveBeenCalledTimes(1);
      expect(result).toEqual({
        successCount: 1,
        failed: true,
        failedDetails: ['b.js:2 - line is not part of the diff'],
        posted: postedAt(0)
      });
    });

    it('counts a partial-data batch whose comments all landed without re-sending it', async () => {
      const allAdded = Object.assign(new Error('warning'), {
        data: bothAdded,
        errors: [{ message: 'Some warning' }]
      });
      const graphql = vi.fn().mockRejectedValueOnce(allAdded);

      const result = await runBatches(graphql, twoComments);

      expect(graphql).toHaveBeenCalledTimes(1);
      expect(result).toEqual({ successCount: 2, failed: false, failedDetails: [], posted: postedAt(0, 1) });
    });

    it('does not halve and re-send a partial-data batch whose error looks like a complexity limit', async () => {
      const partial = Object.assign(new Error('query cost exceeds limit'), {
        data: { comment0: { thread: { id: 't0' } }, comment1: null },
        errors: [{ path: ['comment1'], message: 'query cost exceeds limit' }]
      });
      const graphql = vi.fn()
        .mockRejectedValueOnce(partial)
        .mockResolvedValue({ comment0: { thread: { id: 't' } } });

      const result = await runBatches(graphql, twoComments, 2);

      expect(graphql).toHaveBeenCalledTimes(1);
      expect(result).toEqual({
        successCount: 1,
        failed: true,
        failedDetails: ['b.js:2 - query cost exceeds limit'],
        posted: postedAt(0)
      });
    });

    it.each([
      ['a batch it could halve', 2, twoComments],
      ['a batch at the minimum size', MIN_BATCH_SIZE, twoComments.slice(0, 1)]
    ])('does not halve or re-send a 502 whose message looks like a complexity limit, for %s', async (_label, size, comments) => {
      const error = httpError('upstream response too large', 502);
      const graphql = vi.fn()
        .mockRejectedValueOnce(error)
        .mockResolvedValue({ comment0: { thread: { id: 't' } } });

      const result = await runBatches(graphql, comments, size);

      expect(graphql).toHaveBeenCalledTimes(1);
      expect(result.successCount).toBe(0);
      expect(result.failed).toBe(true);
      expect(result.failedDetails).toHaveLength(comments.length);
    });

    it('does not halve a fetch failure whose message looks like a complexity limit', async () => {
      const graphql = vi.fn()
        .mockRejectedValueOnce(httpError('response body too large, socket closed', 500, false))
        .mockResolvedValue({ comment0: { thread: { id: 't' } } });

      const result = await runBatches(graphql, twoComments, 2);

      expect(graphql).toHaveBeenCalledTimes(1);
      expect(result.failed).toBe(true);
    });

    it('retries a complexity rejection at the minimum batch size once', async () => {
      const graphql = vi.fn().mockRejectedValue(new Error('Mutation payload too large'));

      const result = await runBatches(graphql, twoComments.slice(0, 1), MIN_BATCH_SIZE);

      expect(graphql).toHaveBeenCalledTimes(2);
      expect(result.failed).toBe(true);
      expect(result.successCount).toBe(0);
    });

    it('does not re-send a complexity error with data at the minimum batch size', async () => {
      const withData = Object.assign(new Error('Mutation payload too large'), {
        data: { comment0: null },
        errors: [{ path: ['comment0'], message: 'Mutation payload too large' }]
      });
      const graphql = vi.fn().mockRejectedValue(withData);

      const result = await runBatches(graphql, twoComments.slice(0, 1), MIN_BATCH_SIZE);

      expect(graphql).toHaveBeenCalledTimes(1);
      expect(result).toEqual({
        successCount: 0,
        failed: true,
        failedDetails: ['a.js:1 - Mutation payload too large'],
        posted: []
      });
    });
  });

  describe('isSafeToRetry', () => {
    it('treats a complexity rejection as safe', () => {
      expect(isSafeToRetry(new Error('Mutation payload too large'))).toBe(true);
    });

    it('treats a missing error as unsafe', () => {
      expect(isSafeToRetry(undefined)).toBe(false);
    });
  });

  describe('buildBatchMutation', () => {
    it('produces a working mutation for a normal path (regression guard)', () => {
      const mutation = buildBatchMutation([
        { path: 'src/foo.js', line: 10, side: 'RIGHT', body: 'looks good' }
      ]);

      expect(mutation).toContain('comment0: addPullRequestReviewThread');
      expect(mutation).toContain('path: "src/foo.js"');
      expect(mutation).toContain('body: "looks good"');
      expect(mutation).toContain('line: 10');
      expect(mutation).toContain('side: RIGHT');

      // The interpolated path should be a valid JSON string literal.
      const pathLiteral = extractStringLiteral(mutation, 'path');
      expect(JSON.parse(pathLiteral)).toBe('src/foo.js');
    });

    it('escapes double quotes in line-comment paths', () => {
      const weirdPath = 'weird"file.js';
      const mutation = buildBatchMutation([
        { path: weirdPath, line: 3, side: 'RIGHT', body: 'note' }
      ]);

      const pathLiteral = extractStringLiteral(mutation, 'path');
      // The literal must round-trip back to the original path via
      // JSON.parse — proving the GraphQL string is well-formed and
      // the unescaped quote did not break out of the literal.
      expect(JSON.parse(pathLiteral)).toBe(weirdPath);
      // And the raw quote must NOT appear unescaped inside the
      // literal (which would split the GraphQL string in two).
      expect(pathLiteral).toBe('"weird\\"file.js"');
    });

    it('escapes backslashes in line-comment paths', () => {
      const backslashPath = 'dir\\file.js';
      const mutation = buildBatchMutation([
        { path: backslashPath, line: 1, side: 'RIGHT', body: 'note' }
      ]);

      const pathLiteral = extractStringLiteral(mutation, 'path');
      expect(JSON.parse(pathLiteral)).toBe(backslashPath);
      expect(pathLiteral).toBe('"dir\\\\file.js"');
    });

    it('escapes newlines in line-comment paths', () => {
      const newlinePath = 'a\nb.js';
      const mutation = buildBatchMutation([
        { path: newlinePath, line: 1, side: 'RIGHT', body: 'note' }
      ]);

      const pathLiteral = extractStringLiteral(mutation, 'path');
      expect(JSON.parse(pathLiteral)).toBe(newlinePath);
      // The newline must be escaped, not raw, or the GraphQL parser
      // will reject the unterminated string literal.
      expect(pathLiteral).not.toContain('\n');
      expect(pathLiteral).toContain('\\n');
    });

    it('escapes special characters in file-level comment paths', () => {
      const weirdPath = 'weird"file\\with\nnewline.md';
      const mutation = buildBatchMutation([
        { path: weirdPath, body: 'whole file', isFileLevel: true }
      ]);

      expect(mutation).toContain('subjectType: FILE');
      const pathLiteral = extractStringLiteral(mutation, 'path');
      expect(JSON.parse(pathLiteral)).toBe(weirdPath);
      // Sanity-check: no raw control characters or unescaped quotes
      // inside the literal.
      expect(pathLiteral).not.toContain('\n');
      const innerLiteral = pathLiteral.slice(1, -1); // strip the surrounding quotes
      // Every unescaped char must not be a bare double-quote.
      // Walk the literal and verify no unescaped quote remains.
      let i = 0;
      while (i < innerLiteral.length) {
        if (innerLiteral[i] === '\\') {
          i += 2;
          continue;
        }
        expect(innerLiteral[i]).not.toBe('"');
        i++;
      }
    });

    it('still escapes quote characters inside bodies (existing behavior regression guard)', () => {
      const trickyBody = 'this has a " in it';
      const mutation = buildBatchMutation([
        { path: 'src/foo.js', line: 1, side: 'RIGHT', body: trickyBody }
      ]);

      const bodyLiteral = extractStringLiteral(mutation, 'body');
      expect(JSON.parse(bodyLiteral)).toBe(trickyBody);
    });

    it('handles a mixed batch with a malicious path next to a normal one', () => {
      const mutation = buildBatchMutation([
        { path: 'src/foo.js', line: 10, side: 'RIGHT', body: 'normal' },
        { path: 'weird"file.js', line: 5, side: 'RIGHT', body: 'still works' }
      ]);

      expect(mutation).toContain('comment0:');
      expect(mutation).toContain('comment1:');

      // Pull both path literals (one per inner mutation).
      const matches = [...mutation.matchAll(/path:\s*("(?:\\.|[^"\\])*")/g)];
      expect(matches).toHaveLength(2);
      expect(JSON.parse(matches[0][1])).toBe('src/foo.js');
      expect(JSON.parse(matches[1][1])).toBe('weird"file.js');
    });

    it('sends startSide with startLine for a range, defaulting to the comment side', () => {
      const mutation = buildBatchMutation([
        { path: 'src/foo.js', start_line: 3, start_side: 'LEFT', line: 5, side: 'LEFT', body: 'deleted lines' },
        { path: 'src/foo.js', start_line: 7, line: 9, side: 'LEFT', body: 'no start_side' },
        { path: 'src/foo.js', start_line: 1, line: 2, body: 'no sides' }
      ]);

      const inner = mutation.split(/comment\d+:/).slice(1);
      expect(inner).toHaveLength(3);
      expect(inner[0]).toContain('startLine: 3');
      expect(inner[0]).toContain('startSide: LEFT');
      expect(inner[0]).toContain('side: LEFT');
      // An absent start_side falls back to the end side, never GitHub's
      // RIGHT default.
      expect(inner[1]).toContain('startLine: 7');
      expect(inner[1]).toContain('startSide: LEFT');
      expect(inner[2]).toContain('startSide: RIGHT');
      expect(inner[2]).toContain('side: RIGHT');
    });

    it('omits startLine and startSide for single-line and file-level comments', () => {
      const mutation = buildBatchMutation([
        { path: 'src/foo.js', line: 10, side: 'LEFT', body: 'single line' },
        { path: 'src/foo.js', body: 'whole file', isFileLevel: true }
      ]);

      expect(mutation).not.toContain('startLine');
      expect(mutation).not.toContain('startSide');
      expect(mutation).toContain('side: LEFT');
    });
  });
});
