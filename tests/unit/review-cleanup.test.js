// SPDX-License-Identifier: GPL-3.0-or-later
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createTestDatabase, closeTestDatabase } from '../utils/schema';
import { ReviewRepository, run, query, queryOne } from '../../src/database';

describe('Review Cleanup', () => {
  let db;
  let reviewRepo;

  beforeEach(async () => {
    db = await createTestDatabase();
    reviewRepo = new ReviewRepository(db);
  });

  afterEach(async () => {
    if (db) await closeTestDatabase(db);
  });

  /**
   * Helper: create a review and backdate its updated_at
   */
  async function createAgedReview({ prNumber = null, repository = 'owner/repo', reviewType = 'pr', daysOld = 30 }) {
    const result = await run(db, `
      INSERT INTO reviews (pr_number, repository, status, review_type)
      VALUES (?, ?, 'draft', ?)
    `, [prNumber, repository, reviewType]);

    const pastDate = new Date();
    pastDate.setDate(pastDate.getDate() - daysOld);
    await run(db, `UPDATE reviews SET updated_at = ? WHERE id = ?`, [pastDate.toISOString(), result.lastID]);

    return result.lastID;
  }

  describe('findStale()', () => {
    it('should return empty array when no reviews exist', async () => {
      const cutoff = new Date().toISOString();
      const stale = await reviewRepo.findStale(cutoff);
      expect(stale).toEqual([]);
    });

    it('should return reviews older than cutoff', async () => {
      const oldId = await createAgedReview({ prNumber: 1, daysOld: 30 });
      await createAgedReview({ prNumber: 2, daysOld: 5 }); // recent

      const cutoff = new Date();
      cutoff.setDate(cutoff.getDate() - 21);
      const stale = await reviewRepo.findStale(cutoff.toISOString());

      expect(stale).toHaveLength(1);
      expect(stale[0].id).toBe(oldId);
    });

    it('should return both PR and local reviews', async () => {
      await createAgedReview({ prNumber: 1, reviewType: 'pr', daysOld: 30 });
      await createAgedReview({ prNumber: null, repository: 'local/repo', reviewType: 'local', daysOld: 30 });

      const cutoff = new Date();
      cutoff.setDate(cutoff.getDate() - 21);
      const stale = await reviewRepo.findStale(cutoff.toISOString());

      expect(stale).toHaveLength(2);
      const types = stale.map(r => r.review_type).sort();
      expect(types).toEqual(['local', 'pr']);
    });

    it('should not return reviews updated at exactly the cutoff', async () => {
      const cutoff = new Date();
      cutoff.setDate(cutoff.getDate() - 21);

      const result = await run(db, `
        INSERT INTO reviews (pr_number, repository, status, review_type)
        VALUES (1, 'owner/repo', 'draft', 'pr')
      `, []);
      await run(db, `UPDATE reviews SET updated_at = ? WHERE id = ?`, [cutoff.toISOString(), result.lastID]);

      const stale = await reviewRepo.findStale(cutoff.toISOString());
      expect(stale).toHaveLength(0);
    });
  });

  describe('deleteWithRelatedData()', () => {
    it('should return false for non-existent review', async () => {
      const deleted = await reviewRepo.deleteWithRelatedData(999);
      expect(deleted).toBe(false);
    });

    it('should delete review and cascade to comments', async () => {
      const reviewId = await createAgedReview({ prNumber: 1 });

      // Add a comment
      await run(db, `
        INSERT INTO comments (id, review_id, file, line_start, body, status)
        VALUES (1, ?, 'test.js', 10, 'A comment', 'active')
      `, [reviewId]);

      const deleted = await reviewRepo.deleteWithRelatedData(reviewId, { prNumber: 1, repository: 'owner/repo' });
      expect(deleted).toBe(true);

      const review = await queryOne(db, 'SELECT * FROM reviews WHERE id = ?', [reviewId]);
      expect(review).toBeUndefined();

      const comments = await query(db, 'SELECT * FROM comments WHERE review_id = ?', [reviewId]);
      expect(comments).toHaveLength(0);
    });

    it('should cascade to analysis_runs', async () => {
      const reviewId = await createAgedReview({ prNumber: 1 });

      await run(db, `
        INSERT INTO analysis_runs (id, review_id, status)
        VALUES ('run-1', ?, 'completed')
      `, [reviewId]);

      await reviewRepo.deleteWithRelatedData(reviewId, { prNumber: 1, repository: 'owner/repo' });

      const runs = await query(db, 'SELECT * FROM analysis_runs WHERE review_id = ?', [reviewId]);
      expect(runs).toHaveLength(0);
    });

    it('should cascade to chat_sessions and chat_messages', async () => {
      const reviewId = await createAgedReview({ prNumber: 1 });

      await run(db, `
        INSERT INTO chat_sessions (review_id, provider, status)
        VALUES (?, 'claude', 'active')
      `, [reviewId]);

      const session = await queryOne(db, 'SELECT id FROM chat_sessions WHERE review_id = ?', [reviewId]);
      await run(db, `
        INSERT INTO chat_messages (session_id, role, content)
        VALUES (?, 'user', 'hello')
      `, [session.id]);

      await reviewRepo.deleteWithRelatedData(reviewId, { prNumber: 1, repository: 'owner/repo' });

      const sessions = await query(db, 'SELECT * FROM chat_sessions WHERE review_id = ?', [reviewId]);
      expect(sessions).toHaveLength(0);

      const messages = await query(db, 'SELECT * FROM chat_messages WHERE session_id = ?', [session.id]);
      expect(messages).toHaveLength(0);
    });

    it('should cascade to context_files', async () => {
      const reviewId = await createAgedReview({ prNumber: 1 });

      await run(db, `
        INSERT INTO context_files (review_id, file, line_start, line_end)
        VALUES (?, 'test.js', 1, 10)
      `, [reviewId]);

      await reviewRepo.deleteWithRelatedData(reviewId, { prNumber: 1, repository: 'owner/repo' });

      const files = await query(db, 'SELECT * FROM context_files WHERE review_id = ?', [reviewId]);
      expect(files).toHaveLength(0);
    });

    it('should clean up orphaned pr_metadata when last review for PR is deleted', async () => {
      const reviewId = await createAgedReview({ prNumber: 42, repository: 'owner/repo' });

      await run(db, `
        INSERT INTO pr_metadata (pr_number, repository, title)
        VALUES (42, 'owner/repo', 'Test PR')
      `, []);

      await reviewRepo.deleteWithRelatedData(reviewId, { prNumber: 42, repository: 'owner/repo' });

      const metadata = await queryOne(db, `
        SELECT * FROM pr_metadata WHERE pr_number = 42 AND repository = 'owner/repo'
      `, []);
      expect(metadata).toBeUndefined();
    });

    it('should NOT clean up pr_metadata when other reviews still reference the PR', async () => {
      // This shouldn't normally happen (unique constraint) but tests the guard
      await createAgedReview({ prNumber: 42, repository: 'owner/repo' });
      const reviewId2 = await createAgedReview({ prNumber: 42, repository: 'Owner/Repo' }); // case variant

      await run(db, `
        INSERT INTO pr_metadata (pr_number, repository, title)
        VALUES (42, 'owner/repo', 'Test PR')
      `, []);

      // Delete one — the COLLATE NOCASE query should still find the other
      await reviewRepo.deleteWithRelatedData(reviewId2, { prNumber: 42, repository: 'Owner/Repo' });

      const metadata = await queryOne(db, `
        SELECT * FROM pr_metadata WHERE pr_number = 42 AND repository = 'owner/repo'
      `, []);
      expect(metadata).not.toBeUndefined();
    });

    it('should clean up github_pr_cache when last review for PR is deleted', async () => {
      const reviewId = await createAgedReview({ prNumber: 10, repository: 'acme/widgets' });

      await run(db, `
        INSERT INTO github_pr_cache (owner, repo, number, title, collection)
        VALUES ('acme', 'widgets', 10, 'Test PR', 'review-requests')
      `, []);

      await reviewRepo.deleteWithRelatedData(reviewId, { prNumber: 10, repository: 'acme/widgets' });

      const cache = await queryOne(db, `
        SELECT * FROM github_pr_cache WHERE owner = 'acme' AND repo = 'widgets' AND number = 10
      `, []);
      expect(cache).toBeUndefined();
    });

    it('should work for local reviews (no prNumber)', async () => {
      const reviewId = await createAgedReview({ prNumber: null, repository: 'local/path', reviewType: 'local' });

      await run(db, `
        INSERT INTO comments (id, review_id, file, line_start, body, status)
        VALUES (1, ?, 'test.js', 5, 'Local comment', 'active')
      `, [reviewId]);

      const deleted = await reviewRepo.deleteWithRelatedData(reviewId);
      expect(deleted).toBe(true);

      const review = await queryOne(db, 'SELECT * FROM reviews WHERE id = ?', [reviewId]);
      expect(review).toBeUndefined();

      const comments = await query(db, 'SELECT * FROM comments WHERE review_id = ?', [reviewId]);
      expect(comments).toHaveLength(0);
    });

    it('should cascade to local_diffs', async () => {
      const reviewId = await createAgedReview({ prNumber: null, repository: 'local/path', reviewType: 'local' });

      await run(db, `
        INSERT INTO local_diffs (review_id, diff_text, stats)
        VALUES (?, 'diff content', '{}')
      `, [reviewId]);

      await reviewRepo.deleteWithRelatedData(reviewId);

      const diffs = await query(db, 'SELECT * FROM local_diffs WHERE review_id = ?', [reviewId]);
      expect(diffs).toHaveLength(0);
    });

    it('should cascade to github_reviews', async () => {
      const reviewId = await createAgedReview({ prNumber: 1 });

      await run(db, `
        INSERT INTO github_reviews (review_id, state, event, body)
        VALUES (?, 'submitted', 'APPROVE', 'LGTM')
      `, [reviewId]);

      await reviewRepo.deleteWithRelatedData(reviewId, { prNumber: 1, repository: 'owner/repo' });

      const ghReviews = await query(db, 'SELECT * FROM github_reviews WHERE review_id = ?', [reviewId]);
      expect(ghReviews).toHaveLength(0);
    });
  });
});
