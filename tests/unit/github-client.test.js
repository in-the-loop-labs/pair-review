// SPDX-License-Identifier: GPL-3.0-or-later
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

/**
 * GitHub Client Unit Tests
 *
 * These tests verify the GraphQL mutation generation for file-level and line-level comments.
 * The actual GitHub API calls are mocked by replacing the graphql method on each client instance.
 */

const { GitHubClient } = require('../../src/github/client');

describe('GitHubClient', () => {
  describe('createReviewGraphQL', () => {
    it('should format file-level comments with subjectType: FILE', async () => {
      const client = new GitHubClient('test-token');
      const mockGraphql = vi.fn()
        .mockResolvedValueOnce({
          addPullRequestReview: {
            pullRequestReview: { id: 'review-123' }
          }
        })
        .mockResolvedValueOnce({
          comment0: { thread: { id: 'thread-0' } }
        })
        .mockResolvedValueOnce({
          submitPullRequestReview: {
            pullRequestReview: {
              id: 'review-123',
              url: 'https://github.com/owner/repo/pull/1#pullrequestreview-123',
              state: 'COMMENTED'
            }
          }
        });
      client.octokit.graphql = mockGraphql;

      const comments = [{
        path: 'src/file.js',
        body: 'This is a file-level comment',
        isFileLevel: true
      }];

      await client.createReviewGraphQL('PR_node123', 'COMMENT', 'Review body', comments);

      // Verify the comment mutation includes subjectType: FILE
      expect(mockGraphql).toHaveBeenCalledTimes(3);
      const commentMutationCall = mockGraphql.mock.calls[1];
      const mutationString = commentMutationCall[0];

      expect(mutationString).toContain('subjectType: FILE');
      expect(mutationString).toContain('path: "src/file.js"');
      // Should NOT contain line or side for file-level comments
      expect(mutationString).not.toMatch(/line: \d+/);
      expect(mutationString).not.toContain('side: RIGHT');
      expect(mutationString).not.toContain('side: LEFT');
    });

    it('should format line-level comments with line and side parameters', async () => {
      const client = new GitHubClient('test-token');
      const mockGraphql = vi.fn()
        .mockResolvedValueOnce({
          addPullRequestReview: {
            pullRequestReview: { id: 'review-123' }
          }
        })
        .mockResolvedValueOnce({
          comment0: { thread: { id: 'thread-0' } }
        })
        .mockResolvedValueOnce({
          submitPullRequestReview: {
            pullRequestReview: {
              id: 'review-123',
              url: 'https://github.com/owner/repo/pull/1#pullrequestreview-123',
              state: 'COMMENTED'
            }
          }
        });
      client.octokit.graphql = mockGraphql;

      const comments = [{
        path: 'src/file.js',
        line: 42,
        side: 'RIGHT',
        body: 'This is a line-level comment',
        isFileLevel: false
      }];

      await client.createReviewGraphQL('PR_node123', 'COMMENT', 'Review body', comments);

      // Verify the comment mutation includes line and side
      const commentMutationCall = mockGraphql.mock.calls[1];
      const mutationString = commentMutationCall[0];

      expect(mutationString).toContain('line: 42');
      expect(mutationString).toContain('side: RIGHT');
      // Should NOT contain subjectType: FILE for line-level comments
      expect(mutationString).not.toContain('subjectType: FILE');
    });

    it('should handle comments without line as file-level', async () => {
      const client = new GitHubClient('test-token');
      const mockGraphql = vi.fn()
        .mockResolvedValueOnce({
          addPullRequestReview: {
            pullRequestReview: { id: 'review-123' }
          }
        })
        .mockResolvedValueOnce({
          comment0: { thread: { id: 'thread-0' } }
        })
        .mockResolvedValueOnce({
          submitPullRequestReview: {
            pullRequestReview: {
              id: 'review-123',
              url: 'https://github.com/owner/repo/pull/1#pullrequestreview-123',
              state: 'COMMENTED'
            }
          }
        });
      client.octokit.graphql = mockGraphql;

      // When isFileLevel is not set and line is missing, treat as file-level
      const comments = [{
        path: 'src/file.js',
        body: 'Comment without line',
        // No isFileLevel, no line
      }];

      await client.createReviewGraphQL('PR_node123', 'COMMENT', 'Review body', comments);

      const commentMutationCall = mockGraphql.mock.calls[1];
      const mutationString = commentMutationCall[0];

      expect(mutationString).toContain('subjectType: FILE');
    });

    it('should handle mixed file-level and line-level comments', async () => {
      const client = new GitHubClient('test-token');
      const mockGraphql = vi.fn()
        .mockResolvedValueOnce({
          addPullRequestReview: {
            pullRequestReview: { id: 'review-123' }
          }
        })
        .mockResolvedValueOnce({
          comment0: { thread: { id: 'thread-0' } },
          comment1: { thread: { id: 'thread-1' } }
        })
        .mockResolvedValueOnce({
          submitPullRequestReview: {
            pullRequestReview: {
              id: 'review-123',
              url: 'https://github.com/owner/repo/pull/1#pullrequestreview-123',
              state: 'COMMENTED'
            }
          }
        });
      client.octokit.graphql = mockGraphql;

      const comments = [
        {
          path: 'src/file1.js',
          body: 'File-level comment',
          isFileLevel: true
        },
        {
          path: 'src/file2.js',
          line: 10,
          side: 'LEFT',
          body: 'Line-level comment',
          isFileLevel: false
        }
      ];

      await client.createReviewGraphQL('PR_node123', 'COMMENT', 'Review body', comments);

      const commentMutationCall = mockGraphql.mock.calls[1];
      const mutationString = commentMutationCall[0];

      // Should have file-level mutation for first comment
      expect(mutationString).toContain('comment0');
      expect(mutationString).toContain('path: "src/file1.js"');
      expect(mutationString).toContain('subjectType: FILE');

      // Should have line-level mutation for second comment
      expect(mutationString).toContain('comment1');
      expect(mutationString).toContain('path: "src/file2.js"');
      expect(mutationString).toContain('line: 10');
      expect(mutationString).toContain('side: LEFT');
    });

    it('should default side to RIGHT for line-level comments without side', async () => {
      const client = new GitHubClient('test-token');
      const mockGraphql = vi.fn()
        .mockResolvedValueOnce({
          addPullRequestReview: {
            pullRequestReview: { id: 'review-123' }
          }
        })
        .mockResolvedValueOnce({
          comment0: { thread: { id: 'thread-0' } }
        })
        .mockResolvedValueOnce({
          submitPullRequestReview: {
            pullRequestReview: {
              id: 'review-123',
              url: 'https://github.com/owner/repo/pull/1#pullrequestreview-123',
              state: 'COMMENTED'
            }
          }
        });
      client.octokit.graphql = mockGraphql;

      const comments = [{
        path: 'src/file.js',
        line: 5,
        body: 'Line comment without explicit side',
        isFileLevel: false
      }];

      await client.createReviewGraphQL('PR_node123', 'COMMENT', 'Review body', comments);

      const commentMutationCall = mockGraphql.mock.calls[1];
      const mutationString = commentMutationCall[0];

      expect(mutationString).toContain('side: RIGHT');
    });
  });

  describe('createDraftReviewGraphQL', () => {
    it('should format file-level comments with subjectType: FILE for drafts', async () => {
      const client = new GitHubClient('test-token');
      const mockGraphql = vi.fn()
        .mockResolvedValueOnce({
          addPullRequestReview: {
            pullRequestReview: { id: 'review-456', url: 'https://github.com/owner/repo/pull/1#pullrequestreview-456' }
          }
        })
        .mockResolvedValueOnce({
          comment0: { thread: { id: 'thread-0' } }
        });
      client.octokit.graphql = mockGraphql;

      const comments = [{
        path: 'src/draft-file.js',
        body: 'Draft file-level comment',
        isFileLevel: true
      }];

      await client.createDraftReviewGraphQL('PR_node123', 'Draft body', comments);

      // Verify the comment mutation includes subjectType: FILE
      const commentMutationCall = mockGraphql.mock.calls[1];
      const mutationString = commentMutationCall[0];

      expect(mutationString).toContain('subjectType: FILE');
      expect(mutationString).toContain('path: "src/draft-file.js"');
      // Should NOT contain line or side for file-level comments
      expect(mutationString).not.toMatch(/line: \d+/);
    });

    it('should format line-level comments with line and side for drafts', async () => {
      const client = new GitHubClient('test-token');
      const mockGraphql = vi.fn()
        .mockResolvedValueOnce({
          addPullRequestReview: {
            pullRequestReview: { id: 'review-456', url: 'https://github.com/owner/repo/pull/1#pullrequestreview-456' }
          }
        })
        .mockResolvedValueOnce({
          comment0: { thread: { id: 'thread-0' } }
        });
      client.octokit.graphql = mockGraphql;

      const comments = [{
        path: 'src/draft-file.js',
        line: 100,
        side: 'LEFT',
        body: 'Draft line-level comment',
        isFileLevel: false
      }];

      await client.createDraftReviewGraphQL('PR_node123', 'Draft body', comments);

      const commentMutationCall = mockGraphql.mock.calls[1];
      const mutationString = commentMutationCall[0];

      expect(mutationString).toContain('line: 100');
      expect(mutationString).toContain('side: LEFT');
      expect(mutationString).not.toContain('subjectType: FILE');
    });

    it('should not submit the review (keep as pending)', async () => {
      const client = new GitHubClient('test-token');
      const mockGraphql = vi.fn()
        .mockResolvedValueOnce({
          addPullRequestReview: {
            pullRequestReview: { id: 'review-456', url: 'https://github.com/owner/repo/pull/1#pullrequestreview-456' }
          }
        })
        .mockResolvedValueOnce({
          comment0: { thread: { id: 'thread-0' } }
        });
      client.octokit.graphql = mockGraphql;

      const comments = [{
        path: 'src/file.js',
        body: 'Draft comment',
        isFileLevel: true
      }];

      const result = await client.createDraftReviewGraphQL('PR_node123', 'Draft body', comments);

      // Should return PENDING state
      expect(result.state).toBe('PENDING');

      // Should only have 2 calls (create review + add comments), NOT a third call (no submitPullRequestReview)
      expect(mockGraphql).toHaveBeenCalledTimes(2);
    });
  });

  describe('calculateDiffPosition', () => {
    it('should return -1 for missing parameters', () => {
      const client = new GitHubClient('test-token');
      expect(client.calculateDiffPosition(null, 'file.js', 10)).toBe(-1);
      expect(client.calculateDiffPosition('diff', null, 10)).toBe(-1);
      expect(client.calculateDiffPosition('diff', 'file.js', undefined)).toBe(-1);
    });

    it('should calculate position for added lines', () => {
      const client = new GitHubClient('test-token');
      const diff = `diff --git a/file.js b/file.js
--- a/file.js
+++ b/file.js
@@ -1,3 +1,4 @@
+// New comment
 line1
 line2
 line3`;

      // Line 1 in new file is the added line, which is position 1 (first line after hunk header)
      expect(client.calculateDiffPosition(diff, 'file.js', 1)).toBe(1);
    });

    it('should return -1 for lines not in diff', () => {
      const client = new GitHubClient('test-token');
      const diff = `diff --git a/file.js b/file.js
--- a/file.js
+++ b/file.js
@@ -1,3 +1,3 @@
 line1
 line2
 line3`;

      // Line 100 is not in the diff
      expect(client.calculateDiffPosition(diff, 'file.js', 100)).toBe(-1);
    });

    it('should return -1 for non-existent file', () => {
      const client = new GitHubClient('test-token');
      const diff = `diff --git a/file.js b/file.js
--- a/file.js
+++ b/file.js
@@ -1,3 +1,3 @@
 line1
 line2
 line3`;

      expect(client.calculateDiffPosition(diff, 'other-file.js', 1)).toBe(-1);
    });
  });
});
