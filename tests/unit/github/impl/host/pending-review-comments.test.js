// Copyright 2026 Tim Perkins (tjwp) | SPDX-License-Identifier: Apache-2.0
import { describe, it, expect, vi } from 'vitest';

/**
 * Unit tests for the host-extension implementation of the
 * `pending_review_comments` area. The tests mock `octokit.request` and
 * assert against the endpoint, method, headers, body, and response
 * normalisation.
 */

const hostImpl = require('../../../../../src/github/impl/host/pending-review-comments');

function makeOctokit(responder) {
  return {
    request: vi.fn(responder)
  };
}

const PR_CTX = { owner: 'alice', repo: 'widgets', prNumber: 7 };

describe('impl/host/pending-review-comments', () => {
  describe('addCommentsInBatches', () => {
    it('returns an empty result and makes no request when comments is empty', async () => {
      const octokit = makeOctokit(() => { throw new Error('should not be called'); });
      const result = await hostImpl.addCommentsInBatches(
        octokit, {}, PR_CTX, 123, []
      );
      expect(result).toEqual({ successCount: 0, failed: false, failedDetails: [] });
      expect(octokit.request).not.toHaveBeenCalled();
    });

    it('posts to the documented default endpoint when no override is set', async () => {
      const octokit = makeOctokit(async () => ({ data: { added: 1, failed: [] } }));
      await hostImpl.addCommentsInBatches(
        octokit,
        {},
        PR_CTX,
        42,
        [{ path: 'src/file.js', line: 10, side: 'RIGHT', body: 'looks good' }]
      );
      expect(octokit.request).toHaveBeenCalledTimes(1);
      const [endpoint, options] = octokit.request.mock.calls[0];
      expect(endpoint).toBe('POST /repos/alice/widgets/pulls/7/reviews/42/comments');
      expect(options.data).toEqual({
        comments: [
          {
            path: 'src/file.js',
            body: 'looks good',
            side: 'RIGHT',
            line: 10,
            subject_type: 'line'
          }
        ]
      });
      expect(options.headers).toMatchObject({
        'content-type': 'application/json',
        accept: 'application/json'
      });
    });

    it('uses the configured endpoint override when features.pending_review_comments_endpoint is set', async () => {
      const octokit = makeOctokit(async () => ({ data: { added: 1, failed: [] } }));
      const features = {
        pending_review_comments: 'host',
        pending_review_comments_endpoint:
          '/custom/{owner}/{repo}/prs/{pull_number}/reviews/{review_id}/append-comments'
      };
      await hostImpl.addCommentsInBatches(
        octokit,
        features,
        PR_CTX,
        99,
        [{ path: 'a.txt', line: 1, body: 'ok' }]
      );
      const [endpoint] = octokit.request.mock.calls[0];
      expect(endpoint).toBe('POST /custom/alice/widgets/prs/7/reviews/99/append-comments');
    });

    it('substitutes every occurrence of each placeholder (global, not first-only)', async () => {
      const captured = vi.fn(async () => ({ data: { added: 1, failed: [] } }));
      const octokit = { request: captured };
      const features = {
        pending_review_comments_endpoint:
          '/x/{owner}/{repo}/{pull_number}/{review_id}/{owner}-{repo}'
      };
      await hostImpl.addCommentsInBatches(
        octokit,
        features,
        { owner: 'o', repo: 'r', prNumber: 12 },
        77,
        [{ path: 'p.txt', line: 1, body: 'hi' }]
      );
      const [endpoint] = captured.mock.calls[0];
      // All four required placeholders are substituted globally, so
      // templates that repeat a placeholder (e.g. once in the path and
      // once in a query string) resolve every occurrence.
      expect(endpoint).toBe('POST /x/o/r/12/77/o-r');
    });

    it('resolves repeated placeholders in a query string', async () => {
      const octokit = makeOctokit(async () => ({ data: { added: 1, failed: [] } }));
      const features = {
        pending_review_comments_endpoint:
          '/repos/{owner}/{repo}/pulls/{pull_number}/reviews/{review_id}/comments?repo={repo}'
      };
      await hostImpl.addCommentsInBatches(
        octokit,
        features,
        PR_CTX,
        99,
        [{ path: 'a.txt', line: 1, body: 'ok' }]
      );
      const [endpoint] = octokit.request.mock.calls[0];
      expect(endpoint).toBe(
        'POST /repos/alice/widgets/pulls/7/reviews/99/comments?repo=widgets'
      );
    });

    it('reports partial failure when the host returns a non-empty failed[] array', async () => {
      const octokit = makeOctokit(async () => ({
        data: {
          added: 1,
          failed: [
            { index: 1, error_message: 'invalid line' }
          ]
        }
      }));
      const comments = [
        { path: 'a.js', line: 1, body: 'one' },
        { path: 'b.js', line: 2, body: 'two' }
      ];
      const result = await hostImpl.addCommentsInBatches(
        octokit, {}, PR_CTX, 1, comments
      );
      expect(result).toEqual({
        successCount: 1,
        failed: true,
        failedDetails: ['b.js:2 - invalid line']
      });
    });

    it('returns all-success when failed[] is empty', async () => {
      const octokit = makeOctokit(async () => ({
        data: { added: 3, failed: [] }
      }));
      const comments = [
        { path: 'a.js', line: 1, body: '1' },
        { path: 'a.js', line: 2, body: '2' },
        { path: 'a.js', line: 3, body: '3' }
      ];
      const result = await hostImpl.addCommentsInBatches(
        octokit, {}, PR_CTX, 1, comments
      );
      expect(result).toEqual({
        successCount: 3,
        failed: false,
        failedDetails: []
      });
    });

    it('falls back to comments.length when the host omits the "added" field on success', async () => {
      const octokit = makeOctokit(async () => ({ data: { failed: [] } }));
      const result = await hostImpl.addCommentsInBatches(
        octokit, {}, PR_CTX, 1,
        [{ path: 'a.js', line: 1, body: '1' }, { path: 'a.js', line: 2, body: '2' }]
      );
      expect(result).toEqual({ successCount: 2, failed: false, failedDetails: [] });
    });

    it('honors an explicit "added: 0" instead of falling back to comments.length', async () => {
      // Regression: an explicit `added: 0` with no failed[] is a host
      // saying "I accepted none of these" — we must NOT report success
      // for every comment in that case.
      const octokit = makeOctokit(async () => ({ data: { added: 0, failed: [] } }));
      const result = await hostImpl.addCommentsInBatches(
        octokit, {}, PR_CTX, 1,
        [
          { path: 'a.js', line: 1, body: '1' },
          { path: 'a.js', line: 2, body: '2' }
        ]
      );
      expect(result).toEqual({ successCount: 0, failed: false, failedDetails: [] });
    });

    it('returns the explicit "added" value when failed[] is non-empty', async () => {
      const octokit = makeOctokit(async () => ({
        data: {
          added: 2,
          failed: [{ index: 2, error_message: 'rejected' }]
        }
      }));
      const result = await hostImpl.addCommentsInBatches(
        octokit, {}, PR_CTX, 1,
        [
          { path: 'a.js', line: 1, body: '1' },
          { path: 'a.js', line: 2, body: '2' },
          { path: 'a.js', line: 3, body: '3' }
        ]
      );
      expect(result.successCount).toBe(2);
      expect(result.failed).toBe(true);
      expect(result.failedDetails).toEqual(['a.js:3 - rejected']);
    });

    it('formats file-level comments with subject_type: "file"', async () => {
      const octokit = makeOctokit(async () => ({ data: { added: 1, failed: [] } }));
      await hostImpl.addCommentsInBatches(
        octokit, {}, PR_CTX, 1,
        [{ path: 'README.md', body: 'whole file', isFileLevel: true }]
      );
      const [, options] = octokit.request.mock.calls[0];
      expect(options.data.comments[0]).toEqual({
        path: 'README.md',
        body: 'whole file',
        subject_type: 'file'
      });
    });

    it('infers file-level when "line" is missing even without isFileLevel', async () => {
      const octokit = makeOctokit(async () => ({ data: { added: 1, failed: [] } }));
      await hostImpl.addCommentsInBatches(
        octokit, {}, PR_CTX, 1,
        [{ path: 'README.md', body: 'no line' }]
      );
      const [, options] = octokit.request.mock.calls[0];
      expect(options.data.comments[0].subject_type).toBe('file');
    });

    it('includes start_line and start_side for range comments', async () => {
      const octokit = makeOctokit(async () => ({ data: { added: 1, failed: [] } }));
      await hostImpl.addCommentsInBatches(
        octokit, {}, PR_CTX, 1,
        [{ path: 'a.js', line: 10, start_line: 7, side: 'RIGHT', body: 'range' }]
      );
      const [, options] = octokit.request.mock.calls[0];
      expect(options.data.comments[0]).toMatchObject({
        path: 'a.js',
        line: 10,
        start_line: 7,
        side: 'RIGHT',
        start_side: 'RIGHT',
        subject_type: 'line'
      });
    });

    it('throws a clear error when prContext is missing', async () => {
      const octokit = makeOctokit(() => { throw new Error('should not be called'); });
      await expect(
        hostImpl.addCommentsInBatches(
          octokit, {}, null, 'r1',
          [{ path: 'a.js', line: 1, body: 'hi' }]
        )
      ).rejects.toThrow(/prContext is required/);
      expect(octokit.request).not.toHaveBeenCalled();
    });

    it('throws when prContext is missing required fields', async () => {
      const octokit = makeOctokit(() => { throw new Error('should not be called'); });
      await expect(
        hostImpl.addCommentsInBatches(
          octokit, {}, { owner: 'a', repo: 'b' }, 'r1',
          [{ path: 'a.js', line: 1, body: 'hi' }]
        )
      ).rejects.toThrow(/prContext must include owner, repo, and prNumber/);
    });

    it('throws when reviewId is missing', async () => {
      const octokit = makeOctokit(() => { throw new Error('should not be called'); });
      await expect(
        hostImpl.addCommentsInBatches(
          octokit, {}, PR_CTX, null,
          [{ path: 'a.js', line: 1, body: 'hi' }]
        )
      ).rejects.toThrow(/reviewId is required/);
    });

    it('normalises transport errors to the partial-failure shape with status in failedDetails', async () => {
      // Host transport failures used to throw; they now return the same
      // `{ failed: true, ... }` shape as the GraphQL impl so callers can
      // branch uniformly on `batchResult.failed`. The orchestration in
      // `src/github/client.js` remains defensive against throws regardless.
      const transportError = Object.assign(new Error('Unauthorized'), { status: 401 });
      const octokit = makeOctokit(async () => { throw transportError; });
      const result = await hostImpl.addCommentsInBatches(
        octokit, {}, PR_CTX, 1,
        [{ path: 'a.js', line: 1, body: 'hi' }]
      );
      expect(result.failed).toBe(true);
      expect(result.successCount).toBe(0);
      expect(result.failedDetails).toHaveLength(1);
      expect(result.failedDetails[0]).toMatch(/a\.js:1 - 401: Unauthorized/);
    });

    it('URL-encodes path components so unusual owners/repos do not break the path', async () => {
      const octokit = makeOctokit(async () => ({ data: { added: 1, failed: [] } }));
      await hostImpl.addCommentsInBatches(
        octokit, {},
        { owner: 'space org', repo: 'r', prNumber: 1, reviewId: 42 },
        42,
        [{ path: 'a.js', line: 1, body: 'hi' }]
      );
      const [endpoint] = octokit.request.mock.calls[0];
      expect(endpoint).toBe('POST /repos/space%20org/r/pulls/1/reviews/42/comments');
    });
  });

  describe('substituteEndpoint', () => {
    it('replaces all four required placeholders', () => {
      const out = hostImpl.substituteEndpoint(
        hostImpl.DEFAULT_ENDPOINT_TEMPLATE,
        { owner: 'o', repo: 'r', pull_number: 42, review_id: 'rid-1' }
      );
      expect(out).toBe('/repos/o/r/pulls/42/reviews/rid-1/comments');
    });

    it('replaces every occurrence of a repeated placeholder', () => {
      const out = hostImpl.substituteEndpoint(
        '/repos/{owner}/{repo}/pulls/{pull_number}/reviews/{review_id}/comments?repo={repo}&owner={owner}',
        { owner: 'alice', repo: 'widgets', pull_number: 7, review_id: 99 }
      );
      expect(out).toBe(
        '/repos/alice/widgets/pulls/7/reviews/99/comments?repo=widgets&owner=alice'
      );
    });

    it('URL-encodes values everywhere a placeholder appears', () => {
      const out = hostImpl.substituteEndpoint(
        '/x/{owner}/{repo}/{repo}-mirror',
        { owner: 'space org', repo: 'widget/sub', pull_number: 1, review_id: 1 }
      );
      expect(out).toBe('/x/space%20org/widget%2Fsub/widget%2Fsub-mirror');
    });

    it('throws a clear error when a referenced placeholder value is missing', () => {
      expect(() => hostImpl.substituteEndpoint(
        '/x/{owner}/{repo}/{pull_number}/{review_id}',
        { owner: 'o', repo: 'r', pull_number: 1 }
        // review_id intentionally omitted
      )).toThrow(/template references \{review_id\}/);
    });
  });

  describe('exports', () => {
    it('exposes the documented default template', () => {
      expect(hostImpl.DEFAULT_ENDPOINT_TEMPLATE).toBe(
        '/repos/{owner}/{repo}/pulls/{pull_number}/reviews/{review_id}/comments'
      );
    });

    it('lists the required placeholders for validation reuse', () => {
      expect(hostImpl.REQUIRED_PLACEHOLDERS).toEqual([
        '{owner}', '{repo}', '{pull_number}', '{review_id}'
      ]);
    });
  });
});
