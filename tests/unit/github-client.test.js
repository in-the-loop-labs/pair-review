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

    it('should include startLine for multi-line comments', async () => {
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
        start_line: 10,
        line: 15,
        side: 'RIGHT',
        body: 'Multi-line comment spanning lines 10-15',
        isFileLevel: false
      }];

      await client.createReviewGraphQL('PR_node123', 'COMMENT', 'Review body', comments);

      const commentMutationCall = mockGraphql.mock.calls[1];
      const mutationString = commentMutationCall[0];

      expect(mutationString).toContain('startLine: 10');
      expect(mutationString).toContain('line: 15');
      expect(mutationString).toContain('side: RIGHT');
    });

    it('should not include startLine for single-line comments', async () => {
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
        body: 'Single line comment',
        isFileLevel: false
        // Note: no start_line property
      }];

      await client.createReviewGraphQL('PR_node123', 'COMMENT', 'Review body', comments);

      const commentMutationCall = mockGraphql.mock.calls[1];
      const mutationString = commentMutationCall[0];

      expect(mutationString).not.toContain('startLine');
      expect(mutationString).toContain('line: 42');
    });
  });

  describe('createReviewGraphQL with existingReviewId', () => {
    it('should skip creating a new pending review when existingReviewId is provided', async () => {
      const client = new GitHubClient('test-token');
      const mockGraphql = vi.fn()
        // No first call to create a pending review - skipped!
        .mockResolvedValueOnce({
          comment0: { thread: { id: 'thread-0' } }
        })
        .mockResolvedValueOnce({
          submitPullRequestReview: {
            pullRequestReview: {
              id: 'existing-review-123',
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
        body: 'Line-level comment',
        isFileLevel: false
      }];

      await client.createReviewGraphQL('PR_node123', 'COMMENT', 'Review body', comments, 'existing-review-123');

      // Should only have 2 calls (add comments + submit), NOT 3 (no create review)
      expect(mockGraphql).toHaveBeenCalledTimes(2);

      // First call should be add comments (not create review)
      const firstCallMutation = mockGraphql.mock.calls[0][0];
      expect(firstCallMutation).toContain('addPullRequestReviewThread');
      // Should NOT contain the create-review mutation (AddPendingReview)
      expect(firstCallMutation).not.toContain('AddPendingReview');

      // Second call should be submit review
      const secondCallMutation = mockGraphql.mock.calls[1][0];
      expect(secondCallMutation).toContain('submitPullRequestReview');
    });

    it('should still create a new pending review when existingReviewId is null', async () => {
      const client = new GitHubClient('test-token');
      const mockGraphql = vi.fn()
        .mockResolvedValueOnce({
          addPullRequestReview: {
            pullRequestReview: { id: 'new-review-123' }
          }
        })
        .mockResolvedValueOnce({
          comment0: { thread: { id: 'thread-0' } }
        })
        .mockResolvedValueOnce({
          submitPullRequestReview: {
            pullRequestReview: {
              id: 'new-review-123',
              url: 'https://github.com/owner/repo/pull/1#pullrequestreview-123',
              state: 'APPROVED'
            }
          }
        });
      client.octokit.graphql = mockGraphql;

      const comments = [{
        path: 'src/file.js',
        line: 10,
        side: 'RIGHT',
        body: 'Comment',
        isFileLevel: false
      }];

      await client.createReviewGraphQL('PR_node123', 'APPROVE', 'LGTM', comments, null);

      // Should have 3 calls (create review + add comments + submit)
      expect(mockGraphql).toHaveBeenCalledTimes(3);

      // First call should be create review
      const firstCallMutation = mockGraphql.mock.calls[0][0];
      expect(firstCallMutation).toContain('addPullRequestReview');
    });

    it('should NOT delete pre-existing review on batch failure', async () => {
      const client = new GitHubClient('test-token');
      const mockGraphql = vi.fn()
        // Add comments batch fails completely
        .mockRejectedValueOnce(new Error('Batch failed'))
        .mockRejectedValueOnce(new Error('Batch failed retry'));
      client.octokit.graphql = mockGraphql;

      // Spy on deletePendingReview to ensure it's NOT called
      const deleteSpy = vi.spyOn(client, 'deletePendingReview').mockResolvedValue(true);

      const comments = [{
        path: 'src/file.js',
        line: 1,
        side: 'RIGHT',
        body: 'Comment',
        isFileLevel: false
      }];

      await expect(
        client.createReviewGraphQL('PR_node123', 'COMMENT', 'Body', comments, 'existing-review-id')
      ).rejects.toThrow('Failed to add');

      // deletePendingReview should NOT be called for pre-existing reviews
      expect(deleteSpy).not.toHaveBeenCalled();
    });

    it('should delete newly-created review on batch failure', async () => {
      const client = new GitHubClient('test-token');
      const mockGraphql = vi.fn()
        // Step 1: Create review succeeds
        .mockResolvedValueOnce({
          addPullRequestReview: {
            pullRequestReview: { id: 'new-review-456' }
          }
        })
        // Step 2: Add comments fails
        .mockRejectedValueOnce(new Error('Batch failed'))
        .mockRejectedValueOnce(new Error('Batch failed retry'));
      client.octokit.graphql = mockGraphql;

      // Spy on deletePendingReview
      const deleteSpy = vi.spyOn(client, 'deletePendingReview').mockResolvedValue(true);

      const comments = [{
        path: 'src/file.js',
        line: 1,
        side: 'RIGHT',
        body: 'Comment',
        isFileLevel: false
      }];

      await expect(
        client.createReviewGraphQL('PR_node123', 'COMMENT', 'Body', comments)
      ).rejects.toThrow('Failed to add');

      // deletePendingReview SHOULD be called for reviews we created
      expect(deleteSpy).toHaveBeenCalledWith('new-review-456');
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

    it('should include startLine for multi-line draft comments', async () => {
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
        start_line: 20,
        line: 30,
        side: 'RIGHT',
        body: 'Draft multi-line comment',
        isFileLevel: false
      }];

      await client.createDraftReviewGraphQL('PR_node123', 'Draft body', comments);

      const commentMutationCall = mockGraphql.mock.calls[1];
      const mutationString = commentMutationCall[0];

      expect(mutationString).toContain('startLine: 20');
      expect(mutationString).toContain('line: 30');
    });

    it('should not include startLine for single-line draft comments', async () => {
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
        line: 50,
        side: 'RIGHT',
        body: 'Single line draft comment',
        isFileLevel: false
      }];

      await client.createDraftReviewGraphQL('PR_node123', 'Draft body', comments);

      const commentMutationCall = mockGraphql.mock.calls[1];
      const mutationString = commentMutationCall[0];

      expect(mutationString).not.toContain('startLine');
      expect(mutationString).toContain('line: 50');
    });
  });

  describe('addCommentsInBatches', () => {
    it('should split comments into batches of the correct size', async () => {
      const client = new GitHubClient('test-token');
      const graphqlCalls = [];
      const mockGraphql = vi.fn().mockImplementation((mutation) => {
        graphqlCalls.push(mutation);
        // Count how many comments are in this mutation
        const commentMatches = mutation.match(/comment\d+:/g) || [];
        const result = {};
        commentMatches.forEach((match, index) => {
          result[`comment${index}`] = { thread: { id: `thread-${index}` } };
        });
        return Promise.resolve(result);
      });
      client.octokit.graphql = mockGraphql;

      // Create 30 comments with batch size 10 = should result in 3 batches
      const comments = [];
      for (let i = 0; i < 30; i++) {
        comments.push({
          path: `file${i}.js`,
          line: i + 1,
          side: 'RIGHT',
          body: `Comment ${i}`
        });
      }

      const result = await client.addCommentsInBatches('PR_node123', 'review-123', comments, 10);

      expect(result.successCount).toBe(30);
      expect(result.failed).toBe(false);
      // Should have made 3 GraphQL calls (one per batch)
      expect(mockGraphql).toHaveBeenCalledTimes(3);

      // Verify each batch has the correct number of comments
      expect(graphqlCalls[0].match(/comment\d+:/g).length).toBe(10);
      expect(graphqlCalls[1].match(/comment\d+:/g).length).toBe(10);
      expect(graphqlCalls[2].match(/comment\d+:/g).length).toBe(10);
    });

    it('should make multiple GraphQL calls (one per batch)', async () => {
      const client = new GitHubClient('test-token');
      const mockGraphql = vi.fn().mockImplementation((mutation) => {
        const commentMatches = mutation.match(/comment\d+:/g) || [];
        const result = {};
        commentMatches.forEach((match, index) => {
          result[`comment${index}`] = { thread: { id: `thread-${index}` } };
        });
        return Promise.resolve(result);
      });
      client.octokit.graphql = mockGraphql;

      // 7 comments with batch size 3 = 3 batches (3, 3, 1)
      const comments = [];
      for (let i = 0; i < 7; i++) {
        comments.push({
          path: `file${i}.js`,
          line: i + 1,
          side: 'RIGHT',
          body: `Comment ${i}`
        });
      }

      await client.addCommentsInBatches('PR_node123', 'review-123', comments, 3);

      expect(mockGraphql).toHaveBeenCalledTimes(3);
    });

    it('should retry on transient failure and succeed', async () => {
      const client = new GitHubClient('test-token');
      let callCount = 0;
      const mockGraphql = vi.fn().mockImplementation(() => {
        callCount++;
        if (callCount === 1) {
          // First call fails
          return Promise.reject(new Error('Transient network error'));
        }
        // Retry succeeds
        return Promise.resolve({
          comment0: { thread: { id: 'thread-0' } }
        });
      });
      client.octokit.graphql = mockGraphql;

      const comments = [{
        path: 'file.js',
        line: 1,
        side: 'RIGHT',
        body: 'Comment'
      }];

      const result = await client.addCommentsInBatches('PR_node123', 'review-123', comments, 25);

      expect(result.successCount).toBe(1);
      expect(result.failed).toBe(false);
      // Should have been called twice (initial + 1 retry)
      expect(mockGraphql).toHaveBeenCalledTimes(2);
    });

    it('should return failed: true on partial failure', async () => {
      const client = new GitHubClient('test-token');
      const mockGraphql = vi.fn().mockResolvedValue({
        comment0: { thread: { id: 'thread-0' } },
        comment1: null // This comment failed
      });
      client.octokit.graphql = mockGraphql;

      const comments = [
        { path: 'file1.js', line: 1, side: 'RIGHT', body: 'Comment 1' },
        { path: 'file2.js', line: 2, side: 'RIGHT', body: 'Comment 2' }
      ];

      const result = await client.addCommentsInBatches('PR_node123', 'review-123', comments, 25);

      expect(result.successCount).toBe(1);
      expect(result.failed).toBe(true);
    });

    it('should return failed: true when batch completely fails after retry', async () => {
      const client = new GitHubClient('test-token');
      const mockGraphql = vi.fn().mockRejectedValue(new Error('Persistent error'));
      client.octokit.graphql = mockGraphql;

      const comments = [{
        path: 'file.js',
        line: 1,
        side: 'RIGHT',
        body: 'Comment'
      }];

      const result = await client.addCommentsInBatches('PR_node123', 'review-123', comments, 25);

      expect(result.successCount).toBe(0);
      expect(result.failed).toBe(true);
      // Should have been called twice (initial + 1 retry)
      expect(mockGraphql).toHaveBeenCalledTimes(2);
    });

    it('should return empty success for no comments', async () => {
      const client = new GitHubClient('test-token');
      const mockGraphql = vi.fn();
      client.octokit.graphql = mockGraphql;

      const result = await client.addCommentsInBatches('PR_node123', 'review-123', [], 25);

      expect(result.successCount).toBe(0);
      expect(result.failed).toBe(false);
      expect(mockGraphql).not.toHaveBeenCalled();
    });

    it('should recover from partial error when all comments succeed', async () => {
      const client = new GitHubClient('test-token');
      // Simulate error with data (partial success that actually succeeded fully)
      const errorWithData = new Error('GraphQL error with partial data');
      errorWithData.data = {
        comment0: { thread: { id: 'thread-0' } },
        comment1: { thread: { id: 'thread-1' } }
      };
      errorWithData.errors = [{ message: 'Some warning' }];

      const mockGraphql = vi.fn()
        .mockRejectedValueOnce(errorWithData) // First attempt fails with partial data
        .mockRejectedValueOnce(errorWithData); // Retry also returns same result

      client.octokit.graphql = mockGraphql;

      const comments = [
        { path: 'file1.js', line: 1, side: 'RIGHT', body: 'Comment 1' },
        { path: 'file2.js', line: 2, side: 'RIGHT', body: 'Comment 2' }
      ];

      const result = await client.addCommentsInBatches('PR_node123', 'review-123', comments, 25);

      // Should succeed because all comments in error.data succeeded
      expect(result.successCount).toBe(2);
      expect(result.failed).toBe(false);
    });

    it('should include per-comment GitHub error messages in failedDetails on partial failure', async () => {
      const client = new GitHubClient('test-token');
      // Simulate a GraphQL partial failure where comment1 fails with a specific GitHub error
      const errorWithData = new Error('GraphQL partial failure');
      errorWithData.data = {
        comment0: { thread: { id: 'thread-0' } },
        comment1: null // This comment failed
      };
      errorWithData.errors = [
        { path: ['comment1'], message: 'line is not part of the diff' }
      ];

      const mockGraphql = vi.fn()
        .mockRejectedValueOnce(errorWithData)  // First attempt
        .mockRejectedValueOnce(errorWithData); // Retry
      client.octokit.graphql = mockGraphql;

      const comments = [
        { path: 'src/good.js', line: 10, side: 'RIGHT', body: 'OK comment' },
        { path: 'src/bad.js', line: 999, side: 'RIGHT', body: 'Bad comment' }
      ];

      const result = await client.addCommentsInBatches('PR_node123', 'review-123', comments, 25);

      expect(result.failed).toBe(true);
      expect(result.successCount).toBe(1);
      expect(result.failedDetails).toHaveLength(1);
      expect(result.failedDetails[0]).toBe('src/bad.js:999 - line is not part of the diff');
    });

    it('should include error message in failedDetails on total batch failure', async () => {
      const client = new GitHubClient('test-token');
      const mockGraphql = vi.fn().mockRejectedValue(new Error('Server unavailable'));
      client.octokit.graphql = mockGraphql;

      const comments = [
        { path: 'file1.js', line: 1, side: 'RIGHT', body: 'Comment 1' },
        { path: 'file2.js', line: 2, side: 'RIGHT', body: 'Comment 2' }
      ];

      const result = await client.addCommentsInBatches('PR_node123', 'review-123', comments, 25);

      expect(result.failed).toBe(true);
      expect(result.successCount).toBe(0);
      expect(result.failedDetails).toHaveLength(2);
      // Without per-comment GraphQL errors, each comment gets the batch-level error
      expect(result.failedDetails[0]).toBe('file1.js:1 - Server unavailable');
      expect(result.failedDetails[1]).toBe('file2.js:2 - Server unavailable');
    });

    it('should return empty failedDetails on success', async () => {
      const client = new GitHubClient('test-token');
      const mockGraphql = vi.fn().mockResolvedValue({
        comment0: { thread: { id: 'thread-0' } }
      });
      client.octokit.graphql = mockGraphql;

      const comments = [
        { path: 'file.js', line: 1, side: 'RIGHT', body: 'Comment' }
      ];

      const result = await client.addCommentsInBatches('PR_node123', 'review-123', comments, 25);

      expect(result.failed).toBe(false);
      expect(result.failedDetails).toEqual([]);
    });

    it('should include file-level comment failures in failedDetails', async () => {
      const client = new GitHubClient('test-token');
      const mockGraphql = vi.fn().mockResolvedValue({
        comment0: null // File-level comment failed
      });
      client.octokit.graphql = mockGraphql;

      const comments = [
        { path: 'README.md', isFileLevel: true, body: 'File-level comment' }
      ];

      const result = await client.addCommentsInBatches('PR_node123', 'review-123', comments, 25);

      expect(result.failed).toBe(true);
      expect(result.failedDetails).toHaveLength(1);
      expect(result.failedDetails[0]).toBe('README.md:file-level - No error details available');
    });

    it('should match per-comment GraphQL errors to specific comments on total failure', async () => {
      const client = new GitHubClient('test-token');
      // Simulate a total failure that still has per-comment GraphQL error details
      const error = new Error('GraphQL mutation failed');
      error.errors = [
        { path: ['comment0'], message: 'path not found in diff' },
        { path: ['comment1'], message: 'line is not part of the diff' }
      ];
      // No error.data means total failure (no partial results)

      const mockGraphql = vi.fn()
        .mockRejectedValueOnce(error)
        .mockRejectedValueOnce(error);
      client.octokit.graphql = mockGraphql;

      const comments = [
        { path: 'deleted-file.js', line: 5, side: 'RIGHT', body: 'Comment 1' },
        { path: 'other-file.js', line: 100, side: 'RIGHT', body: 'Comment 2' }
      ];

      const result = await client.addCommentsInBatches('PR_node123', 'review-123', comments, 25);

      expect(result.failed).toBe(true);
      expect(result.failedDetails).toHaveLength(2);
      expect(result.failedDetails[0]).toBe('deleted-file.js:5 - path not found in diff');
      expect(result.failedDetails[1]).toBe('other-file.js:100 - line is not part of the diff');
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

  describe('getPendingReviewForUser', () => {
    it('should return the pending review authored by the viewer', async () => {
      const client = new GitHubClient('test-token');
      const mockGraphql = vi.fn().mockResolvedValue({
        repository: {
          pullRequest: {
            reviews: {
              nodes: [
                {
                  id: 'PR_R_abc123',
                  databaseId: 12345,
                  body: 'My draft review',
                  url: 'https://github.com/owner/repo/pull/1#pullrequestreview-12345',
                  state: 'PENDING',
                  createdAt: '2024-01-15T10:00:00Z',
                  viewerDidAuthor: true,
                  comments: { totalCount: 3 }
                }
              ]
            }
          }
        }
      });
      client.octokit.graphql = mockGraphql;

      const result = await client.getPendingReviewForUser('owner', 'repo', 42);

      expect(result).toEqual({
        id: 'PR_R_abc123',
        databaseId: 12345,
        body: 'My draft review',
        url: 'https://github.com/owner/repo/pull/1#pullrequestreview-12345',
        state: 'PENDING',
        createdAt: '2024-01-15T10:00:00Z',
        comments: { totalCount: 3 }
      });

      // Verify the GraphQL query was called with correct parameters
      expect(mockGraphql).toHaveBeenCalledWith(
        expect.stringContaining('reviews(states: PENDING'),
        { owner: 'owner', repo: 'repo', prNumber: 42 }
      );
    });

    it('should return null when no pending review exists', async () => {
      const client = new GitHubClient('test-token');
      const mockGraphql = vi.fn().mockResolvedValue({
        repository: {
          pullRequest: {
            reviews: {
              nodes: []
            }
          }
        }
      });
      client.octokit.graphql = mockGraphql;

      const result = await client.getPendingReviewForUser('owner', 'repo', 42);

      expect(result).toBeNull();
    });

    it('should filter out pending reviews not authored by the viewer', async () => {
      const client = new GitHubClient('test-token');
      const mockGraphql = vi.fn().mockResolvedValue({
        repository: {
          pullRequest: {
            reviews: {
              nodes: [
                {
                  id: 'PR_R_other123',
                  databaseId: 99999,
                  body: 'Someone else draft',
                  url: 'https://github.com/owner/repo/pull/1#pullrequestreview-99999',
                  state: 'PENDING',
                  createdAt: '2024-01-14T10:00:00Z',
                  viewerDidAuthor: false,
                  comments: { totalCount: 1 }
                }
              ]
            }
          }
        }
      });
      client.octokit.graphql = mockGraphql;

      const result = await client.getPendingReviewForUser('owner', 'repo', 42);

      expect(result).toBeNull();
    });

    it('should find the viewer pending review among multiple reviews', async () => {
      const client = new GitHubClient('test-token');
      const mockGraphql = vi.fn().mockResolvedValue({
        repository: {
          pullRequest: {
            reviews: {
              nodes: [
                {
                  id: 'PR_R_other1',
                  databaseId: 11111,
                  body: 'Other user 1 draft',
                  url: 'https://github.com/owner/repo/pull/1#pullrequestreview-11111',
                  state: 'PENDING',
                  createdAt: '2024-01-13T10:00:00Z',
                  viewerDidAuthor: false,
                  comments: { totalCount: 0 }
                },
                {
                  id: 'PR_R_mine',
                  databaseId: 22222,
                  body: 'My draft',
                  url: 'https://github.com/owner/repo/pull/1#pullrequestreview-22222',
                  state: 'PENDING',
                  createdAt: '2024-01-14T10:00:00Z',
                  viewerDidAuthor: true,
                  comments: { totalCount: 5 }
                },
                {
                  id: 'PR_R_other2',
                  databaseId: 33333,
                  body: 'Other user 2 draft',
                  url: 'https://github.com/owner/repo/pull/1#pullrequestreview-33333',
                  state: 'PENDING',
                  createdAt: '2024-01-15T10:00:00Z',
                  viewerDidAuthor: false,
                  comments: { totalCount: 2 }
                }
              ]
            }
          }
        }
      });
      client.octokit.graphql = mockGraphql;

      const result = await client.getPendingReviewForUser('owner', 'repo', 42);

      expect(result.id).toBe('PR_R_mine');
      expect(result.databaseId).toBe(22222);
    });

    it('should throw error on authentication failure', async () => {
      const client = new GitHubClient('test-token');
      const authError = new Error('Bad credentials');
      authError.status = 401;
      const mockGraphql = vi.fn().mockRejectedValue(authError);
      client.octokit.graphql = mockGraphql;

      await expect(client.getPendingReviewForUser('owner', 'repo', 42))
        .rejects.toThrow('GitHub authentication failed');
    });

    it('should throw error when PR is not found', async () => {
      const client = new GitHubClient('test-token');
      const notFoundError = new Error('Not found');
      notFoundError.status = 404;
      const mockGraphql = vi.fn().mockRejectedValue(notFoundError);
      client.octokit.graphql = mockGraphql;

      await expect(client.getPendingReviewForUser('owner', 'repo', 999))
        .rejects.toThrow('Pull request #999 not found');
    });

    it('should throw error on GraphQL errors', async () => {
      const client = new GitHubClient('test-token');
      const graphqlError = new Error('GraphQL error');
      graphqlError.errors = [{ message: 'Field X is invalid' }];
      const mockGraphql = vi.fn().mockRejectedValue(graphqlError);
      client.octokit.graphql = mockGraphql;

      await expect(client.getPendingReviewForUser('owner', 'repo', 42))
        .rejects.toThrow('GitHub GraphQL error: Field X is invalid');
    });

    it('should handle null/undefined values in response gracefully', async () => {
      const client = new GitHubClient('test-token');
      const mockGraphql = vi.fn().mockResolvedValue({
        repository: {
          pullRequest: null
        }
      });
      client.octokit.graphql = mockGraphql;

      const result = await client.getPendingReviewForUser('owner', 'repo', 42);

      expect(result).toBeNull();
    });
  });

  describe('getReviewById', () => {
    it('should return review data for a valid node ID', async () => {
      const client = new GitHubClient('test-token');
      const mockGraphql = vi.fn().mockResolvedValue({
        node: {
          id: 'PRR_kwDOTest123',
          state: 'APPROVED',
          submittedAt: '2024-01-20T10:00:00Z',
          url: 'https://github.com/owner/repo/pull/1#pullrequestreview-123'
        }
      });
      client.octokit.graphql = mockGraphql;

      const result = await client.getReviewById('PRR_kwDOTest123');

      expect(result).toEqual({
        id: 'PRR_kwDOTest123',
        state: 'APPROVED',
        submittedAt: '2024-01-20T10:00:00Z',
        url: 'https://github.com/owner/repo/pull/1#pullrequestreview-123'
      });
    });

    it('should return null when review is not found', async () => {
      const client = new GitHubClient('test-token');
      const mockGraphql = vi.fn().mockResolvedValue({
        node: null
      });
      client.octokit.graphql = mockGraphql;

      const result = await client.getReviewById('PRR_nonexistent');

      expect(result).toBeNull();
    });

    it('should return null when node has no id (invalid response)', async () => {
      const client = new GitHubClient('test-token');
      const mockGraphql = vi.fn().mockResolvedValue({
        node: { state: 'PENDING' }  // Missing id
      });
      client.octokit.graphql = mockGraphql;

      const result = await client.getReviewById('PRR_invalid');

      expect(result).toBeNull();
    });

    it('should return null on NOT_FOUND GraphQL error', async () => {
      const client = new GitHubClient('test-token');
      const notFoundError = new Error('Not found');
      notFoundError.errors = [{ type: 'NOT_FOUND', message: 'Could not resolve to a node' }];
      const mockGraphql = vi.fn().mockRejectedValue(notFoundError);
      client.octokit.graphql = mockGraphql;

      const result = await client.getReviewById('PRR_deleted');

      expect(result).toBeNull();
    });

    it('should return null on other errors (fail gracefully)', async () => {
      const client = new GitHubClient('test-token');
      const networkError = new Error('Network timeout');
      const mockGraphql = vi.fn().mockRejectedValue(networkError);
      client.octokit.graphql = mockGraphql;

      const result = await client.getReviewById('PRR_network_error');

      expect(result).toBeNull();
    });

    it('should return PENDING state for draft reviews', async () => {
      const client = new GitHubClient('test-token');
      const mockGraphql = vi.fn().mockResolvedValue({
        node: {
          id: 'PRR_pending',
          state: 'PENDING',
          submittedAt: null,
          url: null
        }
      });
      client.octokit.graphql = mockGraphql;

      const result = await client.getReviewById('PRR_pending');

      expect(result.state).toBe('PENDING');
      expect(result.submittedAt).toBeNull();
    });

    it('should return DISMISSED state for dismissed reviews', async () => {
      const client = new GitHubClient('test-token');
      const mockGraphql = vi.fn().mockResolvedValue({
        node: {
          id: 'PRR_dismissed',
          state: 'DISMISSED',
          submittedAt: null,
          url: 'https://github.com/owner/repo/pull/1#pullrequestreview-456'
        }
      });
      client.octokit.graphql = mockGraphql;

      const result = await client.getReviewById('PRR_dismissed');

      expect(result.state).toBe('DISMISSED');
    });
  });
});
