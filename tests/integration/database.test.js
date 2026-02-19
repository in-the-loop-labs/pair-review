// SPDX-License-Identifier: GPL-3.0-or-later
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createTestDatabase, closeTestDatabase } from '../utils/schema';

// Import database module functions and classes
const database = require('../../src/database.js');
const {
  query,
  queryOne,
  run,
  beginTransaction,
  commit,
  rollback,
  withTransaction,
  getDatabaseStatus,
  getSchemaVersion,
  WorktreeRepository,
  RepoSettingsRepository,
  ReviewRepository,
  AnalysisRunRepository,
  generateWorktreeId,
} = database;

// ============================================================================
// Database Initialization Tests
// ============================================================================

describe('Database Initialization', () => {
  let db;

  beforeEach(async () => {
    db = await createTestDatabase();
  });

  afterEach(async () => {
    if (db) {
      await closeTestDatabase(db);
    }
  });

  it('should create all required tables', async () => {
    const tables = await query(db, `
      SELECT name FROM sqlite_master
      WHERE type='table' AND name NOT LIKE 'sqlite_%'
      ORDER BY name
    `);

    const tableNames = tables.map(t => t.name).sort();
    expect(tableNames).toContain('reviews');
    expect(tableNames).toContain('comments');
    expect(tableNames).toContain('pr_metadata');
    expect(tableNames).toContain('worktrees');
    expect(tableNames).toContain('repo_settings');
  });

  it('should create reviews table with correct schema', async () => {
    const columns = await query(db, 'PRAGMA table_info(reviews)');
    const columnNames = columns.map(c => c.name);

    expect(columnNames).toContain('id');
    expect(columnNames).toContain('pr_number');
    expect(columnNames).toContain('repository');
    expect(columnNames).toContain('status');
    expect(columnNames).toContain('review_id');
    expect(columnNames).toContain('created_at');
    expect(columnNames).toContain('updated_at');
    expect(columnNames).toContain('submitted_at');
    expect(columnNames).toContain('review_data');
    expect(columnNames).toContain('custom_instructions');
  });

  it('should create comments table with correct schema', async () => {
    const columns = await query(db, 'PRAGMA table_info(comments)');
    const columnNames = columns.map(c => c.name);

    expect(columnNames).toContain('id');
    expect(columnNames).toContain('review_id');
    expect(columnNames).toContain('source');
    expect(columnNames).toContain('author');
    expect(columnNames).toContain('ai_run_id');
    expect(columnNames).toContain('ai_level');
    expect(columnNames).toContain('ai_confidence');
    expect(columnNames).toContain('file');
    expect(columnNames).toContain('line_start');
    expect(columnNames).toContain('line_end');
    expect(columnNames).toContain('diff_position');
    expect(columnNames).toContain('side');
    expect(columnNames).toContain('commit_sha');
    expect(columnNames).toContain('type');
    expect(columnNames).toContain('title');
    expect(columnNames).toContain('body');
    expect(columnNames).toContain('status');
    expect(columnNames).toContain('adopted_as_id');
    expect(columnNames).toContain('parent_id');
  });

  it('should create worktrees table with correct schema', async () => {
    const columns = await query(db, 'PRAGMA table_info(worktrees)');
    const columnNames = columns.map(c => c.name);

    expect(columnNames).toContain('id');
    expect(columnNames).toContain('pr_number');
    expect(columnNames).toContain('repository');
    expect(columnNames).toContain('branch');
    expect(columnNames).toContain('path');
    expect(columnNames).toContain('created_at');
    expect(columnNames).toContain('last_accessed_at');
  });

  it('should create repo_settings table with correct schema', async () => {
    const columns = await query(db, 'PRAGMA table_info(repo_settings)');
    const columnNames = columns.map(c => c.name);

    expect(columnNames).toContain('id');
    expect(columnNames).toContain('repository');
    expect(columnNames).toContain('default_instructions');
    expect(columnNames).toContain('default_model');
    expect(columnNames).toContain('created_at');
    expect(columnNames).toContain('updated_at');
  });

  it('should create required indexes', async () => {
    const indexes = await query(db, `
      SELECT name FROM sqlite_master
      WHERE type='index' AND name NOT LIKE 'sqlite_%'
    `);
    const indexNames = indexes.map(i => i.name);

    expect(indexNames).toContain('idx_reviews_pr');
    expect(indexNames).toContain('idx_comments_review_file');
    expect(indexNames).toContain('idx_comments_ai_run');
    expect(indexNames).toContain('idx_comments_status');
    expect(indexNames).toContain('idx_comments_file_level');
    expect(indexNames).toContain('idx_worktrees_last_accessed');
    expect(indexNames).toContain('idx_worktrees_repo');
    // Partial unique indexes from migration 5
    expect(indexNames).toContain('idx_reviews_local');
    expect(indexNames).toContain('idx_reviews_pr_unique');
    // Analysis runs indexes
    expect(indexNames).toContain('idx_analysis_runs_review_id');
    expect(indexNames).toContain('idx_analysis_runs_status');
    // Local sessions listing index
    expect(indexNames).toContain('idx_reviews_type_updated');
  });
});

// ============================================================================
// Basic Query Operations Tests
// ============================================================================

describe('Basic Query Operations', () => {
  let db;

  beforeEach(async () => {
    db = await createTestDatabase();
  });

  afterEach(async () => {
    if (db) {
      await closeTestDatabase(db);
    }
  });

  describe('query()', () => {
    it('should return empty array for empty table', async () => {
      const rows = await query(db, 'SELECT * FROM reviews');
      expect(rows).toEqual([]);
    });

    it('should return multiple rows', async () => {
      await run(db, `INSERT INTO reviews (pr_number, repository) VALUES (1, 'owner/repo1')`);
      await run(db, `INSERT INTO reviews (pr_number, repository) VALUES (2, 'owner/repo2')`);

      const rows = await query(db, 'SELECT * FROM reviews ORDER BY pr_number');
      expect(rows).toHaveLength(2);
      expect(rows[0].pr_number).toBe(1);
      expect(rows[1].pr_number).toBe(2);
    });

    it('should support parameterized queries', async () => {
      await run(db, `INSERT INTO reviews (pr_number, repository) VALUES (1, 'owner/repo')`);
      await run(db, `INSERT INTO reviews (pr_number, repository) VALUES (2, 'owner/repo2')`);

      const rows = await query(db, 'SELECT * FROM reviews WHERE repository = ?', ['owner/repo']);
      expect(rows).toHaveLength(1);
      expect(rows[0].pr_number).toBe(1);
    });
  });

  describe('queryOne()', () => {
    it('should return undefined for no match', async () => {
      const row = await queryOne(db, 'SELECT * FROM reviews WHERE id = ?', [999]);
      expect(row).toBeUndefined();
    });

    it('should return single row', async () => {
      await run(db, `INSERT INTO reviews (pr_number, repository) VALUES (42, 'owner/repo')`);

      const row = await queryOne(db, 'SELECT * FROM reviews WHERE pr_number = ?', [42]);
      expect(row).toBeDefined();
      expect(row.pr_number).toBe(42);
      expect(row.repository).toBe('owner/repo');
    });

    it('should return first row when multiple match', async () => {
      await run(db, `INSERT INTO reviews (pr_number, repository) VALUES (1, 'owner/repo')`);
      await run(db, `INSERT INTO reviews (pr_number, repository) VALUES (2, 'owner/repo2')`);

      const row = await queryOne(db, 'SELECT * FROM reviews ORDER BY pr_number DESC LIMIT 1');
      expect(row.pr_number).toBe(2);
    });
  });

  describe('run()', () => {
    it('should return lastID for INSERT', async () => {
      const result = await run(db, `INSERT INTO reviews (pr_number, repository) VALUES (1, 'owner/repo')`);
      expect(result.lastID).toBe(1);

      const result2 = await run(db, `INSERT INTO reviews (pr_number, repository) VALUES (2, 'owner/repo2')`);
      expect(result2.lastID).toBe(2);
    });

    it('should return changes count for UPDATE', async () => {
      await run(db, `INSERT INTO reviews (pr_number, repository) VALUES (1, 'owner/repo')`);
      await run(db, `INSERT INTO reviews (pr_number, repository) VALUES (2, 'owner/repo2')`);

      const result = await run(db, `UPDATE reviews SET status = 'submitted' WHERE repository LIKE 'owner/%'`);
      expect(result.changes).toBe(2);
    });

    it('should return changes count for DELETE', async () => {
      await run(db, `INSERT INTO reviews (pr_number, repository) VALUES (1, 'owner/repo')`);

      const result = await run(db, `DELETE FROM reviews WHERE pr_number = ?`, [1]);
      expect(result.changes).toBe(1);
    });

    it('should return 0 changes when nothing matches', async () => {
      const result = await run(db, `DELETE FROM reviews WHERE id = ?`, [999]);
      expect(result.changes).toBe(0);
    });
  });
});

// ============================================================================
// Transaction Tests
// ============================================================================

describe('Transaction Handling', () => {
  let db;

  beforeEach(async () => {
    db = await createTestDatabase();
  });

  afterEach(async () => {
    if (db) {
      await closeTestDatabase(db);
    }
  });

  describe('beginTransaction/commit/rollback', () => {
    it('should commit changes when commit is called', async () => {
      await beginTransaction(db);
      await run(db, `INSERT INTO reviews (pr_number, repository) VALUES (1, 'owner/repo')`);
      await commit(db);

      const rows = await query(db, 'SELECT * FROM reviews');
      expect(rows).toHaveLength(1);
    });

    it('should rollback changes when rollback is called', async () => {
      await beginTransaction(db);
      await run(db, `INSERT INTO reviews (pr_number, repository) VALUES (1, 'owner/repo')`);
      await rollback(db);

      const rows = await query(db, 'SELECT * FROM reviews');
      expect(rows).toHaveLength(0);
    });
  });

  describe('withTransaction()', () => {
    it('should commit on successful function execution', async () => {
      const result = await withTransaction(db, async () => {
        await run(db, `INSERT INTO reviews (pr_number, repository) VALUES (1, 'owner/repo')`);
        return 'success';
      });

      expect(result).toBe('success');
      const rows = await query(db, 'SELECT * FROM reviews');
      expect(rows).toHaveLength(1);
    });

    it('should rollback on error and rethrow', async () => {
      const testError = new Error('Test error');

      await expect(withTransaction(db, async () => {
        await run(db, `INSERT INTO reviews (pr_number, repository) VALUES (1, 'owner/repo')`);
        throw testError;
      })).rejects.toThrow('Test error');

      const rows = await query(db, 'SELECT * FROM reviews');
      expect(rows).toHaveLength(0);
    });

    it('should handle multiple operations atomically', async () => {
      await withTransaction(db, async () => {
        await run(db, `INSERT INTO reviews (pr_number, repository) VALUES (1, 'owner/repo')`);
        await run(db, `INSERT INTO reviews (pr_number, repository) VALUES (2, 'owner/repo2')`);
        await run(db, `UPDATE reviews SET status = 'pending' WHERE pr_number = 1`);
      });

      const rows = await query(db, 'SELECT * FROM reviews ORDER BY pr_number');
      expect(rows).toHaveLength(2);
      expect(rows[0].status).toBe('pending');
      expect(rows[1].status).toBe('draft');
    });
  });
});

// ============================================================================
// ReviewRepository Tests
// ============================================================================

describe('ReviewRepository', () => {
  let db;
  let reviewRepo;

  beforeEach(async () => {
    db = await createTestDatabase();
    reviewRepo = new ReviewRepository(db);
  });

  afterEach(async () => {
    if (db) {
      await closeTestDatabase(db);
    }
  });

  describe('createReview()', () => {
    it('should create a new review with default status', async () => {
      const review = await reviewRepo.createReview({
        prNumber: 123,
        repository: 'owner/repo'
      });

      expect(review.id).toBe(1);
      expect(review.pr_number).toBe(123);
      expect(review.repository).toBe('owner/repo');
      expect(review.status).toBe('draft');
      expect(review.created_at).toBeDefined();
    });

    it('should create review with custom status', async () => {
      const review = await reviewRepo.createReview({
        prNumber: 123,
        repository: 'owner/repo',
        status: 'pending'
      });

      expect(review.status).toBe('pending');
    });

    it('should create review with reviewData as JSON', async () => {
      const reviewData = { level: 1, findings: ['issue1', 'issue2'] };
      const review = await reviewRepo.createReview({
        prNumber: 123,
        repository: 'owner/repo',
        reviewData
      });

      expect(review.review_data).toEqual(reviewData);

      // Verify it's stored and retrievable
      const retrieved = await reviewRepo.getReview(review.id);
      expect(retrieved.review_data).toEqual(reviewData);
    });

    it('should create review with custom instructions', async () => {
      const review = await reviewRepo.createReview({
        prNumber: 123,
        repository: 'owner/repo',
        customInstructions: 'Focus on security issues'
      });

      expect(review.custom_instructions).toBe('Focus on security issues');
    });

    it('should reject duplicate pr_number + repository', async () => {
      await reviewRepo.createReview({ prNumber: 123, repository: 'owner/repo' });

      await expect(
        reviewRepo.createReview({ prNumber: 123, repository: 'owner/repo' })
      ).rejects.toThrow(/UNIQUE constraint failed/);
    });

    it('should allow same pr_number in different repositories', async () => {
      const review1 = await reviewRepo.createReview({ prNumber: 123, repository: 'owner/repo1' });
      const review2 = await reviewRepo.createReview({ prNumber: 123, repository: 'owner/repo2' });

      expect(review1.id).not.toBe(review2.id);
    });
  });

  describe('getReview()', () => {
    it('should return null for non-existent ID', async () => {
      const review = await reviewRepo.getReview(999);
      expect(review).toBeNull();
    });

    it('should retrieve review by ID', async () => {
      const created = await reviewRepo.createReview({
        prNumber: 42,
        repository: 'owner/repo',
        customInstructions: 'Test instructions'
      });

      const retrieved = await reviewRepo.getReview(created.id);
      expect(retrieved.id).toBe(created.id);
      expect(retrieved.pr_number).toBe(42);
      expect(retrieved.repository).toBe('owner/repo');
      expect(retrieved.custom_instructions).toBe('Test instructions');
    });

    it('should parse review_data JSON', async () => {
      const reviewData = { key: 'value', nested: { data: true } };
      const created = await reviewRepo.createReview({
        prNumber: 1,
        repository: 'owner/repo',
        reviewData
      });

      const retrieved = await reviewRepo.getReview(created.id);
      expect(retrieved.review_data).toEqual(reviewData);
    });
  });

  describe('getReviewByPR()', () => {
    it('should return null for non-existent PR', async () => {
      const review = await reviewRepo.getReviewByPR(999, 'owner/repo');
      expect(review).toBeNull();
    });

    it('should retrieve review by PR number and repository', async () => {
      await reviewRepo.createReview({ prNumber: 42, repository: 'owner/repo' });

      const review = await reviewRepo.getReviewByPR(42, 'owner/repo');
      expect(review).not.toBeNull();
      expect(review.pr_number).toBe(42);
      expect(review.repository).toBe('owner/repo');
    });

    it('should distinguish between repositories', async () => {
      await reviewRepo.createReview({ prNumber: 42, repository: 'owner/repo1' });
      await reviewRepo.createReview({ prNumber: 42, repository: 'owner/repo2' });

      const review1 = await reviewRepo.getReviewByPR(42, 'owner/repo1');
      const review2 = await reviewRepo.getReviewByPR(42, 'owner/repo2');
      const review3 = await reviewRepo.getReviewByPR(42, 'owner/repo3');

      expect(review1).not.toBeNull();
      expect(review2).not.toBeNull();
      expect(review3).toBeNull();
      expect(review1.id).not.toBe(review2.id);
    });
  });

  describe('updateReview()', () => {
    it('should return false for non-existent ID', async () => {
      const result = await reviewRepo.updateReview(999, { status: 'submitted' });
      expect(result).toBe(false);
    });

    it('should return false when no updates provided', async () => {
      const created = await reviewRepo.createReview({ prNumber: 1, repository: 'owner/repo' });
      const result = await reviewRepo.updateReview(created.id, {});
      expect(result).toBe(false);
    });

    it('should update status', async () => {
      const created = await reviewRepo.createReview({ prNumber: 1, repository: 'owner/repo' });
      const result = await reviewRepo.updateReview(created.id, { status: 'submitted' });

      expect(result).toBe(true);
      const retrieved = await reviewRepo.getReview(created.id);
      expect(retrieved.status).toBe('submitted');
    });

    it('should update reviewId', async () => {
      const created = await reviewRepo.createReview({ prNumber: 1, repository: 'owner/repo' });
      await reviewRepo.updateReview(created.id, { reviewId: 12345 });

      const retrieved = await reviewRepo.getReview(created.id);
      expect(retrieved.review_id).toBe(12345);
    });

    it('should update reviewData', async () => {
      const created = await reviewRepo.createReview({ prNumber: 1, repository: 'owner/repo' });
      const newData = { updated: true, count: 5 };
      await reviewRepo.updateReview(created.id, { reviewData: newData });

      const retrieved = await reviewRepo.getReview(created.id);
      expect(retrieved.review_data).toEqual(newData);
    });

    it('should update customInstructions', async () => {
      const created = await reviewRepo.createReview({ prNumber: 1, repository: 'owner/repo' });
      await reviewRepo.updateReview(created.id, { customInstructions: 'New instructions' });

      const retrieved = await reviewRepo.getReview(created.id);
      expect(retrieved.custom_instructions).toBe('New instructions');
    });

    it('should update submittedAt', async () => {
      const created = await reviewRepo.createReview({ prNumber: 1, repository: 'owner/repo' });
      const submittedAt = new Date('2024-01-15T10:30:00Z');
      await reviewRepo.updateReview(created.id, { submittedAt });

      const retrieved = await reviewRepo.getReview(created.id);
      expect(retrieved.submitted_at).toBe(submittedAt.toISOString());
    });

    it('should update multiple fields at once', async () => {
      const created = await reviewRepo.createReview({ prNumber: 1, repository: 'owner/repo' });
      await reviewRepo.updateReview(created.id, {
        status: 'submitted',
        reviewId: 999,
        customInstructions: 'Updated'
      });

      const retrieved = await reviewRepo.getReview(created.id);
      expect(retrieved.status).toBe('submitted');
      expect(retrieved.review_id).toBe(999);
      expect(retrieved.custom_instructions).toBe('Updated');
    });
  });

  describe('deleteReview()', () => {
    it('should return false for non-existent ID', async () => {
      const result = await reviewRepo.deleteReview(999);
      expect(result).toBe(false);
    });

    it('should delete review and return true', async () => {
      const created = await reviewRepo.createReview({ prNumber: 1, repository: 'owner/repo' });
      const result = await reviewRepo.deleteReview(created.id);

      expect(result).toBe(true);
      const retrieved = await reviewRepo.getReview(created.id);
      expect(retrieved).toBeNull();
    });
  });

  describe('getOrCreate()', () => {
    it('should create new review when none exists', async () => {
      const review = await reviewRepo.getOrCreate({
        prNumber: 123,
        repository: 'owner/repo',
        customInstructions: 'Test'
      });

      expect(review.id).toBe(1);
      expect(review.pr_number).toBe(123);
    });

    it('should return existing review when one exists', async () => {
      const created = await reviewRepo.createReview({
        prNumber: 123,
        repository: 'owner/repo',
        customInstructions: 'Original'
      });

      const retrieved = await reviewRepo.getOrCreate({
        prNumber: 123,
        repository: 'owner/repo',
        customInstructions: 'Different'
      });

      expect(retrieved.id).toBe(created.id);
      expect(retrieved.custom_instructions).toBe('Original'); // Should not update
    });
  });

  describe('upsertCustomInstructions()', () => {
    it('should create new review when none exists', async () => {
      const review = await reviewRepo.upsertCustomInstructions(123, 'owner/repo', 'New instructions');

      expect(review.pr_number).toBe(123);
      expect(review.custom_instructions).toBe('New instructions');
    });

    it('should update existing review instructions', async () => {
      await reviewRepo.createReview({
        prNumber: 123,
        repository: 'owner/repo',
        customInstructions: 'Original'
      });

      const updated = await reviewRepo.upsertCustomInstructions(123, 'owner/repo', 'Updated');
      expect(updated.custom_instructions).toBe('Updated');

      // Verify persisted
      const retrieved = await reviewRepo.getReviewByPR(123, 'owner/repo');
      expect(retrieved.custom_instructions).toBe('Updated');
    });
  });

  describe('updateSummary()', () => {
    it('should update summary for existing review', async () => {
      const created = await reviewRepo.createReview({
        prNumber: 123,
        repository: 'owner/repo'
      });

      const result = await reviewRepo.updateSummary(created.id, 'This is the analysis summary');
      expect(result).toBe(true);

      // Verify persisted
      const retrieved = await reviewRepo.getReview(created.id);
      expect(retrieved.summary).toBe('This is the analysis summary');
    });

    it('should return false for non-existent review', async () => {
      const result = await reviewRepo.updateSummary(999, 'Summary');
      expect(result).toBe(false);
    });
  });

  describe('upsertSummary()', () => {
    it('should create new review when none exists', async () => {
      const review = await reviewRepo.upsertSummary(123, 'owner/repo', 'New summary');

      expect(review.pr_number).toBe(123);
      expect(review.summary).toBe('New summary');
    });

    it('should update existing review summary', async () => {
      await reviewRepo.createReview({
        prNumber: 123,
        repository: 'owner/repo',
        summary: 'Original summary'
      });

      const updated = await reviewRepo.upsertSummary(123, 'owner/repo', 'Updated summary');
      expect(updated.summary).toBe('Updated summary');

      // Verify persisted
      const retrieved = await reviewRepo.getReviewByPR(123, 'owner/repo');
      expect(retrieved.summary).toBe('Updated summary');
    });
  });

  describe('updateAfterSubmission()', () => {
    it('should update review for DRAFT event', async () => {
      const created = await reviewRepo.createReview({
        prNumber: 123,
        repository: 'owner/repo'
      });

      const reviewData = {
        github_node_id: 'PRR_draft999',
        github_url: 'https://github.com/owner/repo/pull/123#pullrequestreview-999',
        event: 'DRAFT',
        comments_count: 5
      };

      const result = await reviewRepo.updateAfterSubmission(created.id, {
        event: 'DRAFT',
        reviewData
      });

      expect(result).toBe(true);

      const retrieved = await reviewRepo.getReview(created.id);
      expect(retrieved.status).toBe('draft');
      expect(retrieved.review_data.github_node_id).toBe('PRR_draft999');
      expect(retrieved.submitted_at).toBeNull(); // Should NOT be set for drafts
    });

    it('should update review for APPROVE event with submitted_at', async () => {
      const created = await reviewRepo.createReview({
        prNumber: 123,
        repository: 'owner/repo'
      });

      const reviewData = {
        github_node_id: 'PRR_approve1000',
        github_url: 'https://github.com/owner/repo/pull/123#pullrequestreview-1000',
        event: 'APPROVE',
        comments_count: 3
      };

      const result = await reviewRepo.updateAfterSubmission(created.id, {
        event: 'APPROVE',
        reviewData
      });

      expect(result).toBe(true);

      const retrieved = await reviewRepo.getReview(created.id);
      expect(retrieved.status).toBe('submitted');
      expect(retrieved.submitted_at).not.toBeNull(); // Should be set for submissions
      expect(retrieved.review_data.github_node_id).toBe('PRR_approve1000');
    });

    it('should update review for REQUEST_CHANGES event', async () => {
      const created = await reviewRepo.createReview({
        prNumber: 123,
        repository: 'owner/repo'
      });

      const result = await reviewRepo.updateAfterSubmission(created.id, {
        event: 'REQUEST_CHANGES',
        reviewData: { event: 'REQUEST_CHANGES' }
      });

      expect(result).toBe(true);

      const retrieved = await reviewRepo.getReview(created.id);
      expect(retrieved.status).toBe('submitted');
      expect(retrieved.submitted_at).not.toBeNull();
    });

    it('should update review for COMMENT event', async () => {
      const created = await reviewRepo.createReview({
        prNumber: 123,
        repository: 'owner/repo'
      });

      const result = await reviewRepo.updateAfterSubmission(created.id, {
        event: 'COMMENT',
        reviewData: { event: 'COMMENT' }
      });

      expect(result).toBe(true);

      const retrieved = await reviewRepo.getReview(created.id);
      expect(retrieved.status).toBe('submitted');
      expect(retrieved.submitted_at).not.toBeNull();
    });

    it('should return false for non-existent review ID', async () => {
      const result = await reviewRepo.updateAfterSubmission(99999, {
        event: 'DRAFT',
        reviewData: {}
      });

      expect(result).toBe(false);
    });

    it('should NOT delete associated comments (unlike INSERT OR REPLACE)', async () => {
      // Create review
      const review = await reviewRepo.createReview({
        prNumber: 123,
        repository: 'owner/repo'
      });

      // Add a comment to the review
      await run(db, `
        INSERT INTO comments (review_id, source, author, file, body, status)
        VALUES (?, 'user', 'test', 'test.js', 'Test comment', 'active')
      `, [review.id]);

      // Verify comment exists
      let comments = await query(db, 'SELECT * FROM comments WHERE review_id = ?', [review.id]);
      expect(comments).toHaveLength(1);

      // Update the review after submission
      await reviewRepo.updateAfterSubmission(review.id, {
        event: 'DRAFT',
        reviewData: { event: 'DRAFT' }
      });

      // Verify comment still exists (not cascade-deleted)
      comments = await query(db, 'SELECT * FROM comments WHERE review_id = ?', [review.id]);
      expect(comments).toHaveLength(1);
      expect(comments[0].body).toBe('Test comment');
    });

    it('should NOT delete associated analysis_runs (unlike INSERT OR REPLACE)', async () => {
      // Create review
      const review = await reviewRepo.createReview({
        prNumber: 123,
        repository: 'owner/repo'
      });

      // Add an analysis run to the review
      const analysisRunRepo = new AnalysisRunRepository(db);
      await analysisRunRepo.create({
        id: 'test-run-preserve',
        reviewId: review.id,
        provider: 'claude',
        model: 'sonnet'
      });

      // Verify analysis run exists
      let runs = await analysisRunRepo.getByReviewId(review.id);
      expect(runs).toHaveLength(1);

      // Update the review after submission
      await reviewRepo.updateAfterSubmission(review.id, {
        event: 'APPROVE',
        reviewData: { event: 'APPROVE' }
      });

      // Verify analysis run still exists (not cascade-deleted)
      runs = await analysisRunRepo.getByReviewId(review.id);
      expect(runs).toHaveLength(1);
      expect(runs[0].id).toBe('test-run-preserve');
    });
  });

  describe('listByRepository()', () => {
    it('should return empty array for repository with no reviews', async () => {
      const reviews = await reviewRepo.listByRepository('owner/repo');
      expect(reviews).toEqual([]);
    });

    it('should return reviews for specific repository', async () => {
      await reviewRepo.createReview({ prNumber: 1, repository: 'owner/repo' });
      await reviewRepo.createReview({ prNumber: 2, repository: 'owner/repo' });
      await reviewRepo.createReview({ prNumber: 3, repository: 'other/repo' });

      const reviews = await reviewRepo.listByRepository('owner/repo');
      expect(reviews).toHaveLength(2);
      expect(reviews.every(r => r.repository === 'owner/repo')).toBe(true);
    });

    it('should respect limit parameter', async () => {
      for (let i = 1; i <= 10; i++) {
        await reviewRepo.createReview({ prNumber: i, repository: 'owner/repo' });
      }

      const reviews = await reviewRepo.listByRepository('owner/repo', 5);
      expect(reviews).toHaveLength(5);
    });

    it('should order by updated_at DESC', async () => {
      await reviewRepo.createReview({ prNumber: 1, repository: 'owner/repo' });
      await reviewRepo.createReview({ prNumber: 2, repository: 'owner/repo' });
      await reviewRepo.createReview({ prNumber: 3, repository: 'owner/repo' });

      // Update the first one so it has the most recent updated_at
      const review1 = await reviewRepo.getReviewByPR(1, 'owner/repo');
      await reviewRepo.updateReview(review1.id, { status: 'pending' });

      const reviews = await reviewRepo.listByRepository('owner/repo');
      expect(reviews[0].pr_number).toBe(1); // Most recently updated
    });
  });

  describe('getLocalReviewById()', () => {
    it('should return null for non-existent ID', async () => {
      const review = await reviewRepo.getLocalReviewById(999);
      expect(review).toBeNull();
    });

    it('should return null for PR review (review_type != local)', async () => {
      // Create a standard PR review
      const created = await reviewRepo.createReview({
        prNumber: 123,
        repository: 'owner/repo'
      });

      // getLocalReviewById should not find it since it's a PR review
      const review = await reviewRepo.getLocalReviewById(created.id);
      expect(review).toBeNull();
    });

    it('should retrieve local review by ID', async () => {
      // Insert a local review directly
      await run(db, `
        INSERT INTO reviews (pr_number, repository, status, review_type, local_path, local_head_sha)
        VALUES (?, ?, ?, ?, ?, ?)
      `, [null, 'test-repo', 'draft', 'local', '/path/to/repo', 'abc123']);

      const inserted = await queryOne(db, 'SELECT id FROM reviews WHERE review_type = ?', ['local']);

      const review = await reviewRepo.getLocalReviewById(inserted.id);
      expect(review).not.toBeNull();
      expect(review.id).toBe(inserted.id);
      expect(review.review_type).toBe('local');
      expect(review.local_path).toBe('/path/to/repo');
      expect(review.local_head_sha).toBe('abc123');
    });

    it('should include all required fields', async () => {
      await run(db, `
        INSERT INTO reviews (pr_number, repository, status, review_type, local_path, local_head_sha, custom_instructions)
        VALUES (?, ?, ?, ?, ?, ?, ?)
      `, [null, 'test-repo', 'draft', 'local', '/path/to/repo', 'abc123', 'Focus on security']);

      const inserted = await queryOne(db, 'SELECT id FROM reviews WHERE review_type = ?', ['local']);

      const review = await reviewRepo.getLocalReviewById(inserted.id);

      // Check all fields are present
      expect(review.id).toBeDefined();
      expect(review.pr_number).toBeNull();
      expect(review.repository).toBe('test-repo');
      expect(review.status).toBe('draft');
      expect(review.review_type).toBe('local');
      expect(review.local_path).toBe('/path/to/repo');
      expect(review.local_head_sha).toBe('abc123');
      expect(review.custom_instructions).toBe('Focus on security');
      expect(review.created_at).toBeDefined();
      expect(review.updated_at).toBeDefined();
    });

    it('should parse review_data JSON', async () => {
      const reviewData = { key: 'value', nested: { data: true } };
      await run(db, `
        INSERT INTO reviews (pr_number, repository, status, review_type, local_path, review_data)
        VALUES (?, ?, ?, ?, ?, ?)
      `, [null, 'test-repo', 'draft', 'local', '/path/to/repo', JSON.stringify(reviewData)]);

      const inserted = await queryOne(db, 'SELECT id FROM reviews WHERE review_type = ?', ['local']);

      const review = await reviewRepo.getLocalReviewById(inserted.id);
      expect(review.review_data).toEqual(reviewData);
    });

    it('should handle null review_data', async () => {
      await run(db, `
        INSERT INTO reviews (pr_number, repository, status, review_type, local_path)
        VALUES (?, ?, ?, ?, ?)
      `, [null, 'test-repo', 'draft', 'local', '/path/to/repo']);

      const inserted = await queryOne(db, 'SELECT id FROM reviews WHERE review_type = ?', ['local']);

      const review = await reviewRepo.getLocalReviewById(inserted.id);
      expect(review.review_data).toBeNull();
    });

    it('should handle null local_path', async () => {
      await run(db, `
        INSERT INTO reviews (pr_number, repository, status, review_type, local_path)
        VALUES (?, ?, ?, ?, ?)
      `, [null, 'test-repo', 'draft', 'local', null]);

      const inserted = await queryOne(db, 'SELECT id FROM reviews WHERE review_type = ?', ['local']);

      const review = await reviewRepo.getLocalReviewById(inserted.id);
      expect(review).not.toBeNull();
      expect(review.local_path).toBeNull();
    });
  });
});

// ============================================================================
// WorktreeRepository Tests
// ============================================================================

describe('WorktreeRepository', () => {
  let db;
  let worktreeRepo;

  beforeEach(async () => {
    db = await createTestDatabase();
    worktreeRepo = new WorktreeRepository(db);
  });

  afterEach(async () => {
    if (db) {
      await closeTestDatabase(db);
    }
  });

  describe('create()', () => {
    it('should create a new worktree record', async () => {
      const worktree = await worktreeRepo.create({
        prNumber: 123,
        repository: 'owner/repo',
        branch: 'feature-branch',
        path: '/tmp/worktrees/abc'
      });

      expect(worktree.id).toBeDefined();
      expect(worktree.id).toMatch(/^pair-review--[0-9a-z]{3}$/); // pair-review-- prefix + 3-char random ID
      expect(worktree.pr_number).toBe(123);
      expect(worktree.repository).toBe('owner/repo');
      expect(worktree.branch).toBe('feature-branch');
      expect(worktree.path).toBe('/tmp/worktrees/abc');
      expect(worktree.created_at).toBeDefined();
      expect(worktree.last_accessed_at).toBeDefined();
    });

    it('should reject duplicate pr_number + repository', async () => {
      await worktreeRepo.create({
        prNumber: 123,
        repository: 'owner/repo',
        branch: 'branch1',
        path: '/tmp/path1'
      });

      await expect(worktreeRepo.create({
        prNumber: 123,
        repository: 'owner/repo',
        branch: 'branch2',
        path: '/tmp/path2'
      })).rejects.toThrow(/UNIQUE constraint failed/);
    });

    it('should allow same PR number in different repositories', async () => {
      const wt1 = await worktreeRepo.create({
        prNumber: 123,
        repository: 'owner/repo1',
        branch: 'branch',
        path: '/tmp/path1'
      });

      const wt2 = await worktreeRepo.create({
        prNumber: 123,
        repository: 'owner/repo2',
        branch: 'branch',
        path: '/tmp/path2'
      });

      expect(wt1.id).not.toBe(wt2.id);
    });
  });

  describe('findById()', () => {
    it('should return null for non-existent ID', async () => {
      const result = await worktreeRepo.findById('xyz');
      expect(result).toBeNull();
    });

    it('should find worktree by ID', async () => {
      const created = await worktreeRepo.create({
        prNumber: 123,
        repository: 'owner/repo',
        branch: 'feature',
        path: '/tmp/path'
      });

      const found = await worktreeRepo.findById(created.id);
      expect(found).not.toBeNull();
      expect(found.id).toBe(created.id);
      expect(found.pr_number).toBe(123);
    });
  });

  describe('findByPR()', () => {
    it('should return null for non-existent PR', async () => {
      const result = await worktreeRepo.findByPR(999, 'owner/repo');
      expect(result).toBeNull();
    });

    it('should find worktree by PR number and repository', async () => {
      await worktreeRepo.create({
        prNumber: 123,
        repository: 'owner/repo',
        branch: 'feature',
        path: '/tmp/path'
      });

      const found = await worktreeRepo.findByPR(123, 'owner/repo');
      expect(found).not.toBeNull();
      expect(found.pr_number).toBe(123);
      expect(found.repository).toBe('owner/repo');
    });

    it('should distinguish between repositories', async () => {
      await worktreeRepo.create({
        prNumber: 123,
        repository: 'owner/repo1',
        branch: 'feature',
        path: '/tmp/path1'
      });

      const found1 = await worktreeRepo.findByPR(123, 'owner/repo1');
      const found2 = await worktreeRepo.findByPR(123, 'owner/repo2');

      expect(found1).not.toBeNull();
      expect(found2).toBeNull();
    });
  });

  describe('updateLastAccessed()', () => {
    it('should return false for non-existent ID', async () => {
      const result = await worktreeRepo.updateLastAccessed('xyz');
      expect(result).toBe(false);
    });

    it('should update last_accessed_at timestamp', async () => {
      const created = await worktreeRepo.create({
        prNumber: 123,
        repository: 'owner/repo',
        branch: 'feature',
        path: '/tmp/path'
      });

      const originalTime = created.last_accessed_at;

      // Wait a tiny bit to ensure timestamp changes
      await new Promise(resolve => setTimeout(resolve, 10));

      const result = await worktreeRepo.updateLastAccessed(created.id);
      expect(result).toBe(true);

      const updated = await worktreeRepo.findById(created.id);
      expect(updated.last_accessed_at).not.toBe(originalTime);
    });
  });

  describe('updatePath()', () => {
    it('should return false for non-existent ID', async () => {
      const result = await worktreeRepo.updatePath('xyz', '/new/path');
      expect(result).toBe(false);
    });

    it('should update path and last_accessed_at', async () => {
      const created = await worktreeRepo.create({
        prNumber: 123,
        repository: 'owner/repo',
        branch: 'feature',
        path: '/tmp/old-path'
      });

      const result = await worktreeRepo.updatePath(created.id, '/tmp/new-path');
      expect(result).toBe(true);

      const updated = await worktreeRepo.findById(created.id);
      expect(updated.path).toBe('/tmp/new-path');
    });
  });

  describe('delete()', () => {
    it('should return false for non-existent ID', async () => {
      const result = await worktreeRepo.delete('xyz');
      expect(result).toBe(false);
    });

    it('should delete worktree and return true', async () => {
      const created = await worktreeRepo.create({
        prNumber: 123,
        repository: 'owner/repo',
        branch: 'feature',
        path: '/tmp/path'
      });

      const result = await worktreeRepo.delete(created.id);
      expect(result).toBe(true);

      const found = await worktreeRepo.findById(created.id);
      expect(found).toBeNull();
    });
  });

  describe('findStale()', () => {
    it('should return empty array when no stale worktrees', async () => {
      await worktreeRepo.create({
        prNumber: 123,
        repository: 'owner/repo',
        branch: 'feature',
        path: '/tmp/path'
      });

      // Use a date in the past
      const futureDate = new Date(Date.now() + 86400000); // Tomorrow
      const stale = await worktreeRepo.findStale(futureDate);
      expect(stale).toHaveLength(1);
    });

    it('should find worktrees older than threshold', async () => {
      const created = await worktreeRepo.create({
        prNumber: 123,
        repository: 'owner/repo',
        branch: 'feature',
        path: '/tmp/path'
      });

      // Set last_accessed_at to the past manually
      const pastDate = new Date(Date.now() - 86400000).toISOString(); // Yesterday
      await run(db, `UPDATE worktrees SET last_accessed_at = ? WHERE id = ?`, [pastDate, created.id]);

      const now = new Date();
      const stale = await worktreeRepo.findStale(now);
      expect(stale).toHaveLength(1);
      expect(stale[0].id).toBe(created.id);
    });

    it('should order by last_accessed_at ASC', async () => {
      // Create worktrees and manually set different timestamps
      const wt1 = await worktreeRepo.create({
        prNumber: 1,
        repository: 'owner/repo1',
        branch: 'b1',
        path: '/p1'
      });
      const wt2 = await worktreeRepo.create({
        prNumber: 2,
        repository: 'owner/repo2',
        branch: 'b2',
        path: '/p2'
      });

      const older = new Date(Date.now() - 172800000).toISOString(); // 2 days ago
      const newer = new Date(Date.now() - 86400000).toISOString(); // 1 day ago
      await run(db, `UPDATE worktrees SET last_accessed_at = ? WHERE id = ?`, [older, wt1.id]);
      await run(db, `UPDATE worktrees SET last_accessed_at = ? WHERE id = ?`, [newer, wt2.id]);

      const stale = await worktreeRepo.findStale(new Date());
      expect(stale).toHaveLength(2);
      expect(stale[0].id).toBe(wt1.id); // Older first
      expect(stale[1].id).toBe(wt2.id);
    });
  });

  describe('listRecent()', () => {
    it('should return empty array when no worktrees', async () => {
      const recent = await worktreeRepo.listRecent();
      expect(recent).toEqual([]);
    });

    it('should return worktrees ordered by last_accessed_at DESC', async () => {
      const wt1 = await worktreeRepo.create({
        prNumber: 1,
        repository: 'owner/repo1',
        branch: 'b1',
        path: '/p1'
      });
      const wt2 = await worktreeRepo.create({
        prNumber: 2,
        repository: 'owner/repo2',
        branch: 'b2',
        path: '/p2'
      });

      // Manually set different timestamps to ensure ordering
      const older = new Date(Date.now() - 86400000).toISOString(); // 1 day ago
      const newer = new Date(Date.now()).toISOString(); // Now
      await run(db, `UPDATE worktrees SET last_accessed_at = ? WHERE id = ?`, [older, wt2.id]);
      await run(db, `UPDATE worktrees SET last_accessed_at = ? WHERE id = ?`, [newer, wt1.id]);

      const recent = await worktreeRepo.listRecent();
      expect(recent[0].id).toBe(wt1.id); // Most recent first
      expect(recent[1].id).toBe(wt2.id);
    });

    it('should respect limit parameter', async () => {
      for (let i = 1; i <= 5; i++) {
        await worktreeRepo.create({
          prNumber: i,
          repository: `owner/repo${i}`,
          branch: `b${i}`,
          path: `/p${i}`
        });
      }

      const recent = await worktreeRepo.listRecent(3);
      expect(recent).toHaveLength(3);
    });
  });

  describe('getOrCreate()', () => {
    it('should create new worktree when none exists', async () => {
      const worktree = await worktreeRepo.getOrCreate({
        prNumber: 123,
        repository: 'owner/repo',
        branch: 'feature',
        path: '/tmp/path'
      });

      expect(worktree.pr_number).toBe(123);
      expect(worktree.path).toBe('/tmp/path');
    });

    it('should return and update existing worktree', async () => {
      const created = await worktreeRepo.create({
        prNumber: 123,
        repository: 'owner/repo',
        branch: 'old-branch',
        path: '/tmp/old-path'
      });

      const retrieved = await worktreeRepo.getOrCreate({
        prNumber: 123,
        repository: 'owner/repo',
        branch: 'new-branch',
        path: '/tmp/new-path'
      });

      expect(retrieved.id).toBe(created.id);
      expect(retrieved.branch).toBe('new-branch');
      expect(retrieved.path).toBe('/tmp/new-path');
    });
  });

  describe('count()', () => {
    it('should return 0 for empty table', async () => {
      const count = await worktreeRepo.count();
      expect(count).toBe(0);
    });

    it('should return correct count', async () => {
      await worktreeRepo.create({ prNumber: 1, repository: 'o/r1', branch: 'b', path: '/p1' });
      await worktreeRepo.create({ prNumber: 2, repository: 'o/r2', branch: 'b', path: '/p2' });
      await worktreeRepo.create({ prNumber: 3, repository: 'o/r3', branch: 'b', path: '/p3' });

      const count = await worktreeRepo.count();
      expect(count).toBe(3);
    });
  });
});

// ============================================================================
// RepoSettingsRepository Tests
// ============================================================================

describe('RepoSettingsRepository', () => {
  let db;
  let repoSettingsRepo;

  beforeEach(async () => {
    db = await createTestDatabase();
    repoSettingsRepo = new RepoSettingsRepository(db);
  });

  afterEach(async () => {
    if (db) {
      await closeTestDatabase(db);
    }
  });

  describe('getRepoSettings()', () => {
    it('should return null for non-existent repository', async () => {
      const settings = await repoSettingsRepo.getRepoSettings('owner/repo');
      expect(settings).toBeNull();
    });

    it('should retrieve settings for repository', async () => {
      await repoSettingsRepo.saveRepoSettings('owner/repo', {
        default_instructions: 'Test instructions',
        default_model: 'claude-3'
      });

      const settings = await repoSettingsRepo.getRepoSettings('owner/repo');
      expect(settings).not.toBeNull();
      expect(settings.repository).toBe('owner/repo');
      expect(settings.default_instructions).toBe('Test instructions');
      expect(settings.default_model).toBe('claude-3');
    });
  });

  describe('saveRepoSettings()', () => {
    it('should create new settings when none exist', async () => {
      const settings = await repoSettingsRepo.saveRepoSettings('owner/repo', {
        default_instructions: 'Instructions',
        default_model: 'sonnet'
      });

      expect(settings.id).toBe(1);
      expect(settings.repository).toBe('owner/repo');
      expect(settings.default_instructions).toBe('Instructions');
      expect(settings.default_model).toBe('sonnet');
      expect(settings.created_at).toBeDefined();
    });

    it('should update existing settings', async () => {
      await repoSettingsRepo.saveRepoSettings('owner/repo', {
        default_instructions: 'Original',
        default_model: 'model1'
      });

      const updated = await repoSettingsRepo.saveRepoSettings('owner/repo', {
        default_instructions: 'Updated',
        default_model: 'model2'
      });

      expect(updated.default_instructions).toBe('Updated');
      expect(updated.default_model).toBe('model2');

      // Verify only one record exists
      const count = await queryOne(db, 'SELECT COUNT(*) as count FROM repo_settings');
      expect(count.count).toBe(1);
    });

    it('should preserve existing fields when partial update', async () => {
      await repoSettingsRepo.saveRepoSettings('owner/repo', {
        default_instructions: 'Instructions',
        default_model: 'model1'
      });

      // Only update model
      const updated = await repoSettingsRepo.saveRepoSettings('owner/repo', {
        default_model: 'model2'
      });

      expect(updated.default_instructions).toBe('Instructions'); // Preserved
      expect(updated.default_model).toBe('model2');
    });

    it('should handle null values', async () => {
      const settings = await repoSettingsRepo.saveRepoSettings('owner/repo', {});

      expect(settings.default_instructions).toBeNull();
      expect(settings.default_model).toBeNull();
    });

    it('should save and retrieve default_tab', async () => {
      const settings = await repoSettingsRepo.saveRepoSettings('owner/repo', {
        default_tab: 'council'
      });

      expect(settings.default_tab).toBe('council');

      const retrieved = await repoSettingsRepo.getRepoSettings('owner/repo');
      expect(retrieved.default_tab).toBe('council');
    });

    it('should update default_tab on existing settings', async () => {
      await repoSettingsRepo.saveRepoSettings('owner/repo', {
        default_tab: 'single'
      });

      const updated = await repoSettingsRepo.saveRepoSettings('owner/repo', {
        default_tab: 'advanced'
      });

      expect(updated.default_tab).toBe('advanced');
    });

    it('should preserve default_tab when not specified in update', async () => {
      await repoSettingsRepo.saveRepoSettings('owner/repo', {
        default_tab: 'council'
      });

      const updated = await repoSettingsRepo.saveRepoSettings('owner/repo', {
        default_instructions: 'Updated instructions'
      });

      expect(updated.default_tab).toBe('council');
      expect(updated.default_instructions).toBe('Updated instructions');
    });

    it('should default default_tab to null', async () => {
      const settings = await repoSettingsRepo.saveRepoSettings('owner/repo', {});
      expect(settings.default_tab).toBeNull();
    });
  });

  describe('deleteRepoSettings()', () => {
    it('should return false for non-existent repository', async () => {
      const result = await repoSettingsRepo.deleteRepoSettings('owner/repo');
      expect(result).toBe(false);
    });

    it('should delete settings and return true', async () => {
      await repoSettingsRepo.saveRepoSettings('owner/repo', {
        default_instructions: 'Test'
      });

      const result = await repoSettingsRepo.deleteRepoSettings('owner/repo');
      expect(result).toBe(true);

      const settings = await repoSettingsRepo.getRepoSettings('owner/repo');
      expect(settings).toBeNull();
    });
  });
});

// ============================================================================
// Comments Table Operations (Direct SQL Tests)
// ============================================================================

describe('Comments Table Operations', () => {
  let db;

  beforeEach(async () => {
    db = await createTestDatabase();
  });

  afterEach(async () => {
    if (db) {
      await closeTestDatabase(db);
    }
  });

  describe('CRUD Operations', () => {
    it('should create a comment', async () => {
      const result = await run(db, `
        INSERT INTO comments (review_id, source, author, file, line_start, line_end, type, title, body, status)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `, [1, 'ai', 'claude', 'src/main.js', 10, 15, 'suggestion', 'Potential issue', 'Consider refactoring', 'active']);

      expect(result.lastID).toBe(1);

      const comment = await queryOne(db, 'SELECT * FROM comments WHERE id = ?', [result.lastID]);
      expect(comment.review_id).toBe(1);
      expect(comment.source).toBe('ai');
      expect(comment.file).toBe('src/main.js');
      expect(comment.line_start).toBe(10);
      expect(comment.line_end).toBe(15);
      expect(comment.status).toBe('active');
    });

    it('should read comments by PR', async () => {
      await run(db, `INSERT INTO comments (review_id, file, body, status) VALUES (1, 'a.js', 'Comment 1', 'active')`);
      await run(db, `INSERT INTO comments (review_id, file, body, status) VALUES (1, 'b.js', 'Comment 2', 'active')`);
      await run(db, `INSERT INTO comments (review_id, file, body, status) VALUES (2, 'c.js', 'Comment 3', 'active')`);

      const comments = await query(db, 'SELECT * FROM comments WHERE review_id = ?', [1]);
      expect(comments).toHaveLength(2);
    });

    it('should update comment status', async () => {
      const { lastID } = await run(db, `INSERT INTO comments (review_id, file, body, status) VALUES (1, 'a.js', 'Test', 'active')`);

      await run(db, `UPDATE comments SET status = ? WHERE id = ?`, ['dismissed', lastID]);

      const comment = await queryOne(db, 'SELECT * FROM comments WHERE id = ?', [lastID]);
      expect(comment.status).toBe('dismissed');
    });

    it('should delete comment', async () => {
      const { lastID } = await run(db, `INSERT INTO comments (review_id, file, body, status) VALUES (1, 'a.js', 'Test', 'active')`);

      const result = await run(db, `DELETE FROM comments WHERE id = ?`, [lastID]);
      expect(result.changes).toBe(1);

      const comment = await queryOne(db, 'SELECT * FROM comments WHERE id = ?', [lastID]);
      expect(comment).toBeUndefined();
    });
  });

  describe('AI Suggestion Fields', () => {
    it('should store AI-specific fields', async () => {
      const { lastID } = await run(db, `
        INSERT INTO comments (review_id, source, ai_run_id, ai_level, ai_confidence, file, body, status)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      `, [1, 'ai', 'run-123', 2, 0.85, 'src/app.js', 'AI suggestion', 'active']);

      const comment = await queryOne(db, 'SELECT * FROM comments WHERE id = ?', [lastID]);
      expect(comment.ai_run_id).toBe('run-123');
      expect(comment.ai_level).toBe(2);
      expect(comment.ai_confidence).toBeCloseTo(0.85);
    });

    it('should query by ai_run_id', async () => {
      await run(db, `INSERT INTO comments (review_id, ai_run_id, body, status) VALUES (1, 'run-a', 'C1', 'active')`);
      await run(db, `INSERT INTO comments (review_id, ai_run_id, body, status) VALUES (1, 'run-a', 'C2', 'active')`);
      await run(db, `INSERT INTO comments (review_id, ai_run_id, body, status) VALUES (1, 'run-b', 'C3', 'active')`);

      const comments = await query(db, 'SELECT * FROM comments WHERE ai_run_id = ?', ['run-a']);
      expect(comments).toHaveLength(2);
    });
  });

  describe('Status Constraints', () => {
    it('should accept valid status values', async () => {
      const validStatuses = ['active', 'dismissed', 'adopted', 'submitted', 'draft', 'inactive'];

      for (const status of validStatuses) {
        const { lastID } = await run(db, `INSERT INTO comments (review_id, body, status) VALUES (?, ?, ?)`, [1, 'Test', status]);
        const comment = await queryOne(db, 'SELECT status FROM comments WHERE id = ?', [lastID]);
        expect(comment.status).toBe(status);
      }
    });

    it('should reject invalid status values', async () => {
      await expect(
        run(db, `INSERT INTO comments (review_id, body, status) VALUES (?, ?, ?)`, [1, 'Test', 'invalid_status'])
      ).rejects.toThrow(/CHECK constraint failed/);
    });
  });

  describe('Side Constraints', () => {
    it('should accept valid side values', async () => {
      const { lastID: leftId } = await run(db, `INSERT INTO comments (review_id, body, side) VALUES (1, 'Test', 'LEFT')`);
      const { lastID: rightId } = await run(db, `INSERT INTO comments (review_id, body, side) VALUES (1, 'Test', 'RIGHT')`);

      const left = await queryOne(db, 'SELECT side FROM comments WHERE id = ?', [leftId]);
      const right = await queryOne(db, 'SELECT side FROM comments WHERE id = ?', [rightId]);

      expect(left.side).toBe('LEFT');
      expect(right.side).toBe('RIGHT');
    });

    it('should default to RIGHT', async () => {
      const { lastID } = await run(db, `INSERT INTO comments (review_id, body) VALUES (1, 'Test')`);
      const comment = await queryOne(db, 'SELECT side FROM comments WHERE id = ?', [lastID]);
      expect(comment.side).toBe('RIGHT');
    });

    it('should reject invalid side values', async () => {
      await expect(
        run(db, `INSERT INTO comments (review_id, body, side) VALUES (?, ?, ?)`, [1, 'Test', 'CENTER'])
      ).rejects.toThrow(/CHECK constraint failed/);
    });
  });

  describe('Foreign Key Relationships', () => {
    it('should support parent_id self-reference', async () => {
      const { lastID: parentId } = await run(db, `INSERT INTO comments (review_id, body) VALUES (1, 'Parent')`);
      const { lastID: childId } = await run(db, `INSERT INTO comments (review_id, body, parent_id) VALUES (1, 'Child', ?)`, [parentId]);

      const child = await queryOne(db, 'SELECT * FROM comments WHERE id = ?', [childId]);
      expect(child.parent_id).toBe(parentId);
    });

    it('should support adopted_as_id self-reference', async () => {
      const { lastID: aiId } = await run(db, `INSERT INTO comments (review_id, source, body, status) VALUES (1, 'ai', 'AI suggestion', 'active')`);
      const { lastID: adoptedId } = await run(db, `INSERT INTO comments (review_id, source, body, status) VALUES (1, 'user', 'Adopted version', 'draft')`);

      await run(db, `UPDATE comments SET status = 'adopted', adopted_as_id = ? WHERE id = ?`, [adoptedId, aiId]);

      const aiComment = await queryOne(db, 'SELECT * FROM comments WHERE id = ?', [aiId]);
      expect(aiComment.status).toBe('adopted');
      expect(aiComment.adopted_as_id).toBe(adoptedId);
    });
  });

  describe('Diff Position Fields', () => {
    it('should store diff_position and commit_sha', async () => {
      const { lastID } = await run(db, `
        INSERT INTO comments (review_id, file, body, diff_position, commit_sha)
        VALUES (1, 'src/app.js', 'Test', 42, 'abc123def456')
      `);

      const comment = await queryOne(db, 'SELECT * FROM comments WHERE id = ?', [lastID]);
      expect(comment.diff_position).toBe(42);
      expect(comment.commit_sha).toBe('abc123def456');
    });
  });
});

// ============================================================================
// PR Metadata Table Operations (Direct SQL Tests)
// ============================================================================

describe('PR Metadata Table Operations', () => {
  let db;

  beforeEach(async () => {
    db = await createTestDatabase();
  });

  afterEach(async () => {
    if (db) {
      await closeTestDatabase(db);
    }
  });

  it('should create PR metadata', async () => {
    const result = await run(db, `
      INSERT INTO pr_metadata (pr_number, repository, title, description, author, base_branch, head_branch)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `, [123, 'owner/repo', 'Fix bug', 'Fixes issue #456', 'johndoe', 'main', 'fix-bug-456']);

    expect(result.lastID).toBe(1);

    const metadata = await queryOne(db, 'SELECT * FROM pr_metadata WHERE id = ?', [result.lastID]);
    expect(metadata.pr_number).toBe(123);
    expect(metadata.repository).toBe('owner/repo');
    expect(metadata.title).toBe('Fix bug');
    expect(metadata.author).toBe('johndoe');
  });

  it('should enforce unique constraint on pr_number + repository', async () => {
    await run(db, `INSERT INTO pr_metadata (pr_number, repository, title) VALUES (123, 'owner/repo', 'Title 1')`);

    await expect(
      run(db, `INSERT INTO pr_metadata (pr_number, repository, title) VALUES (123, 'owner/repo', 'Title 2')`)
    ).rejects.toThrow(/UNIQUE constraint failed/);
  });

  it('should allow same PR number in different repositories', async () => {
    await run(db, `INSERT INTO pr_metadata (pr_number, repository, title) VALUES (123, 'owner/repo1', 'Title 1')`);
    await run(db, `INSERT INTO pr_metadata (pr_number, repository, title) VALUES (123, 'owner/repo2', 'Title 2')`);

    const count = await queryOne(db, 'SELECT COUNT(*) as count FROM pr_metadata');
    expect(count.count).toBe(2);
  });

  it('should store pr_data as JSON string', async () => {
    const prData = JSON.stringify({ labels: ['bug', 'priority-high'], assignees: ['alice'] });
    await run(db, `INSERT INTO pr_metadata (pr_number, repository, pr_data) VALUES (?, ?, ?)`, [123, 'owner/repo', prData]);

    const metadata = await queryOne(db, 'SELECT pr_data FROM pr_metadata WHERE pr_number = ?', [123]);
    const parsed = JSON.parse(metadata.pr_data);
    expect(parsed.labels).toContain('bug');
    expect(parsed.assignees).toContain('alice');
  });
});

// ============================================================================
// Database Status and Utilities Tests
// ============================================================================

describe('Database Utilities', () => {
  let db;

  beforeEach(async () => {
    db = await createTestDatabase();
  });

  afterEach(async () => {
    if (db) {
      await closeTestDatabase(db);
    }
  });

  describe('getDatabaseStatus()', () => {
    it('should return table counts', async () => {
      // Add some data
      await run(db, `INSERT INTO reviews (pr_number, repository) VALUES (1, 'o/r1')`);
      await run(db, `INSERT INTO reviews (pr_number, repository) VALUES (2, 'o/r2')`);
      await run(db, `INSERT INTO comments (review_id, body) VALUES (1, 'Test')`);

      const status = await getDatabaseStatus(db);

      expect(status.tables).toBeDefined();
      expect(status.tables.reviews).toBe(2);
      expect(status.tables.comments).toBe(1);
      expect(status.total_records).toBeGreaterThanOrEqual(3);
    });

    it('should return zero counts for empty tables', async () => {
      const status = await getDatabaseStatus(db);

      expect(status.tables.reviews).toBe(0);
      expect(status.tables.comments).toBe(0);
      expect(status.total_records).toBe(0);
    });
  });

  describe('generateWorktreeId()', () => {
    it('should generate ID with pair-review-- prefix and 3-character random part by default', () => {
      const id = generateWorktreeId();
      expect(id).toMatch(/^pair-review--[0-9a-z]{3}$/);
    });

    it('should generate ID with specified random part length', () => {
      const id = generateWorktreeId(5);
      expect(id).toMatch(/^pair-review--[0-9a-z]{5}$/);
    });

    it('should have pair-review-- prefix and alphanumeric random part', () => {
      const id = generateWorktreeId(10);
      expect(id).toMatch(/^pair-review--[0-9a-z]{10}$/);
    });

    it('should generate different IDs on each call', () => {
      const ids = new Set();
      for (let i = 0; i < 100; i++) {
        ids.add(generateWorktreeId(6)); // Use 6 chars for lower collision chance
      }
      // With 6 chars, we should get mostly unique IDs
      expect(ids.size).toBeGreaterThan(90);
    });
  });
});

// ============================================================================
// Edge Cases and Error Handling Tests
// ============================================================================

describe('Edge Cases and Error Handling', () => {
  let db;

  beforeEach(async () => {
    db = await createTestDatabase();
  });

  afterEach(async () => {
    if (db) {
      await closeTestDatabase(db);
    }
  });

  describe('Empty Results', () => {
    it('should handle empty query results gracefully', async () => {
      const rows = await query(db, 'SELECT * FROM reviews WHERE id = ?', [999]);
      expect(rows).toEqual([]);
    });

    it('should handle queryOne with no results', async () => {
      const row = await queryOne(db, 'SELECT * FROM reviews WHERE id = ?', [999]);
      expect(row).toBeUndefined();
    });
  });

  describe('Invalid Queries', () => {
    it('should reject invalid SQL syntax', async () => {
      await expect(query(db, 'INVALID SQL')).rejects.toThrow();
    });

    it('should reject queries on non-existent tables', async () => {
      await expect(query(db, 'SELECT * FROM nonexistent_table')).rejects.toThrow();
    });
  });

  describe('Constraint Violations', () => {
    it('should reject NOT NULL violations', async () => {
      await expect(
        run(db, `INSERT INTO reviews (pr_number) VALUES (?)`, [123])
      ).rejects.toThrow(/NOT NULL constraint failed/);
    });

    it('should reject invalid CHECK constraint values', async () => {
      await expect(
        run(db, `INSERT INTO reviews (pr_number, repository, status) VALUES (?, ?, ?)`, [1, 'o/r', 'invalid'])
      ).rejects.toThrow(/CHECK constraint failed/);
    });
  });

  describe('Large Data Handling', () => {
    it('should handle large text in review_data', async () => {
      const reviewRepo = new ReviewRepository(db);
      const largeData = { content: 'x'.repeat(100000) };

      const review = await reviewRepo.createReview({
        prNumber: 1,
        repository: 'owner/repo',
        reviewData: largeData
      });

      const retrieved = await reviewRepo.getReview(review.id);
      expect(retrieved.review_data.content).toHaveLength(100000);
    });

    it('should handle unicode characters', async () => {
      const reviewRepo = new ReviewRepository(db);
      const unicodeData = { emoji: '🚀', chinese: '中文', arabic: 'العربية' };

      const review = await reviewRepo.createReview({
        prNumber: 1,
        repository: 'owner/repo',
        reviewData: unicodeData
      });

      const retrieved = await reviewRepo.getReview(review.id);
      expect(retrieved.review_data).toEqual(unicodeData);
    });
  });

  describe('Special Characters in Repository Names', () => {
    it('should handle repository names with special characters', async () => {
      const reviewRepo = new ReviewRepository(db);
      const specialRepos = [
        'owner/my-repo',
        'owner/repo_name',
        'owner/repo.js',
        'my-org/my-repo-name'
      ];

      for (const repo of specialRepos) {
        const review = await reviewRepo.createReview({
          prNumber: 1,
          repository: repo
        });
        expect(review.repository).toBe(repo);

        const retrieved = await reviewRepo.getReviewByPR(1, repo);
        expect(retrieved).not.toBeNull();
        expect(retrieved.repository).toBe(repo);

        await reviewRepo.deleteReview(review.id);
      }
    });
  });
});

// ============================================================================
// AnalysisRunRepository Tests
// ============================================================================

describe('AnalysisRunRepository', () => {
  let db;
  let reviewRepo;
  let analysisRunRepo;
  let testReview;

  beforeEach(async () => {
    db = await createTestDatabase();
    reviewRepo = new ReviewRepository(db);
    analysisRunRepo = new AnalysisRunRepository(db);

    // Create a test review to associate analysis runs with
    testReview = await reviewRepo.createReview({
      prNumber: 42,
      repository: 'test/repo'
    });
  });

  afterEach(async () => {
    if (db) {
      await closeTestDatabase(db);
    }
  });

  describe('create()', () => {
    it('should create an analysis run with required fields', async () => {
      const runId = 'test-run-id-123';
      const result = await analysisRunRepo.create({
        id: runId,
        reviewId: testReview.id
      });

      expect(result.id).toBe(runId);
      expect(result.review_id).toBe(testReview.id);
      expect(result.status).toBe('running');
      expect(result.total_suggestions).toBe(0);
      expect(result.files_analyzed).toBe(0);
      expect(result.provider).toBeNull();
      expect(result.model).toBeNull();
    });

    it('should create an analysis run with all optional fields', async () => {
      const runId = 'test-run-id-456';
      const result = await analysisRunRepo.create({
        id: runId,
        reviewId: testReview.id,
        provider: 'claude',
        model: 'sonnet',
        customInstructions: 'Focus on security issues',
        tier: 'balanced'
      });

      expect(result.id).toBe(runId);
      expect(result.provider).toBe('claude');
      expect(result.model).toBe('sonnet');
      expect(result.custom_instructions).toBe('Focus on security issues');
      expect(result.tier).toBe('balanced');
    });

    it('should create an analysis run with head_sha for traceability', async () => {
      const runId = 'test-run-with-sha';
      const testSha = 'abc123def456789012345678901234567890abcd';
      const result = await analysisRunRepo.create({
        id: runId,
        reviewId: testReview.id,
        provider: 'claude',
        model: 'sonnet',
        headSha: testSha
      });

      expect(result.id).toBe(runId);
      expect(result.head_sha).toBe(testSha);
    });

    it('should create an analysis run without head_sha (nullable)', async () => {
      const runId = 'test-run-no-sha';
      const result = await analysisRunRepo.create({
        id: runId,
        reviewId: testReview.id
      });

      expect(result.id).toBe(runId);
      expect(result.head_sha).toBeNull();
    });

    it('should create an analysis run with tier field', async () => {
      const runId = 'test-run-with-tier';
      const result = await analysisRunRepo.create({
        id: runId,
        reviewId: testReview.id,
        provider: 'claude',
        model: 'opus',
        tier: 'thorough'
      });

      expect(result.id).toBe(runId);
      expect(result.tier).toBe('thorough');
    });

    it('should default tier to null when not provided', async () => {
      const runId = 'test-run-no-tier';
      const result = await analysisRunRepo.create({
        id: runId,
        reviewId: testReview.id,
        provider: 'claude',
        model: 'sonnet'
      });

      expect(result.id).toBe(runId);
      expect(result.tier).toBeNull();
    });
  });

  describe('update()', () => {
    it('should update status to completed and set completed_at', async () => {
      const runId = 'test-run-id-update';
      await analysisRunRepo.create({ id: runId, reviewId: testReview.id });

      const updated = await analysisRunRepo.update(runId, {
        status: 'completed',
        summary: 'Analysis complete with 5 issues found',
        totalSuggestions: 5,
        filesAnalyzed: 10
      });

      expect(updated).toBe(true);

      const retrieved = await analysisRunRepo.getById(runId);
      expect(retrieved.status).toBe('completed');
      expect(retrieved.summary).toBe('Analysis complete with 5 issues found');
      expect(retrieved.total_suggestions).toBe(5);
      expect(retrieved.files_analyzed).toBe(10);
      expect(retrieved.completed_at).not.toBeNull();
    });

    it('should update status to failed and set completed_at', async () => {
      const runId = 'test-run-id-failed';
      await analysisRunRepo.create({ id: runId, reviewId: testReview.id });

      await analysisRunRepo.update(runId, { status: 'failed' });

      const retrieved = await analysisRunRepo.getById(runId);
      expect(retrieved.status).toBe('failed');
      expect(retrieved.completed_at).not.toBeNull();
    });

    it('should update status to cancelled and set completed_at', async () => {
      const runId = 'test-run-id-cancelled';
      await analysisRunRepo.create({ id: runId, reviewId: testReview.id });

      await analysisRunRepo.update(runId, { status: 'cancelled' });

      const retrieved = await analysisRunRepo.getById(runId);
      expect(retrieved.status).toBe('cancelled');
      expect(retrieved.completed_at).not.toBeNull();
    });

    it('should return false when no fields to update', async () => {
      const runId = 'test-run-id-noop';
      await analysisRunRepo.create({ id: runId, reviewId: testReview.id });

      const updated = await analysisRunRepo.update(runId, {});
      expect(updated).toBe(false);
    });
  });

  describe('getById()', () => {
    it('should retrieve an analysis run by ID', async () => {
      const runId = 'test-run-id-get';
      await analysisRunRepo.create({
        id: runId,
        reviewId: testReview.id,
        provider: 'gemini',
        model: 'gemini-2.5-pro'
      });

      const retrieved = await analysisRunRepo.getById(runId);
      expect(retrieved).not.toBeNull();
      expect(retrieved.id).toBe(runId);
      expect(retrieved.provider).toBe('gemini');
      expect(retrieved.model).toBe('gemini-2.5-pro');
    });

    it('should return null for non-existent ID', async () => {
      const retrieved = await analysisRunRepo.getById('non-existent');
      expect(retrieved).toBeNull();
    });

    it('should include head_sha in retrieved record', async () => {
      const runId = 'test-run-id-sha-get';
      const testSha = 'def456abc789012345678901234567890abcdef12';
      await analysisRunRepo.create({
        id: runId,
        reviewId: testReview.id,
        headSha: testSha
      });

      const retrieved = await analysisRunRepo.getById(runId);
      expect(retrieved).not.toBeNull();
      expect(retrieved.head_sha).toBe(testSha);
    });
  });

  describe('getByReviewId()', () => {
    it('should retrieve all analysis runs for a review ordered by started_at DESC', async () => {
      // Create multiple runs
      await analysisRunRepo.create({ id: 'run-1', reviewId: testReview.id });
      await analysisRunRepo.create({ id: 'run-2', reviewId: testReview.id });
      await analysisRunRepo.create({ id: 'run-3', reviewId: testReview.id });

      const runs = await analysisRunRepo.getByReviewId(testReview.id);
      expect(runs).toHaveLength(3);
      // Most recent first (run-3 was created last)
      expect(runs[0].id).toBe('run-3');
      expect(runs[1].id).toBe('run-2');
      expect(runs[2].id).toBe('run-1');
    });

    it('should return empty array for review with no analysis runs', async () => {
      const runs = await analysisRunRepo.getByReviewId(9999);
      expect(runs).toEqual([]);
    });

    it('should include head_sha in all retrieved records', async () => {
      const sha1 = 'sha1111111111111111111111111111111111111';
      const sha2 = 'sha2222222222222222222222222222222222222';
      // Use IDs that sort correctly when timestamps are identical
      // (id DESC is used as tiebreaker, so 'run-sha-2' > 'run-sha-1')
      await analysisRunRepo.create({ id: 'run-sha-1', reviewId: testReview.id, headSha: sha1 });
      await analysisRunRepo.create({ id: 'run-sha-2', reviewId: testReview.id, headSha: sha2 });

      const runs = await analysisRunRepo.getByReviewId(testReview.id);
      expect(runs).toHaveLength(2);
      // Most recent first (id DESC tiebreaker makes 'run-sha-2' come first)
      expect(runs[0].head_sha).toBe(sha2);
      expect(runs[1].head_sha).toBe(sha1);
    });

    it('should order council parent run above child runs when parent completes last', async () => {
      // Simulate council workflow: parent created first, children created after,
      // parent completes LAST (after all children finish).
      // The parent should appear first (most recent) because it completed most recently.

      // Create parent council run with earlier started_at
      await analysisRunRepo.create({
        id: 'council-parent',
        reviewId: testReview.id,
        configType: 'council',
        provider: 'council'
      });

      // Create child runs with later started_at
      await analysisRunRepo.create({
        id: 'council-child-1',
        reviewId: testReview.id,
        parentRunId: 'council-parent',
        configType: 'council'
      });
      await analysisRunRepo.create({
        id: 'council-child-2',
        reviewId: testReview.id,
        parentRunId: 'council-parent',
        configType: 'council'
      });

      // Manually set timestamps to simulate real timing:
      // - Parent started first (T=0), completed last (T=30)
      // - Child 1 started at T=1, completed at T=15
      // - Child 2 started at T=2, completed at T=20
      await run(db, `UPDATE analysis_runs SET started_at = '2025-01-01 00:00:00', completed_at = '2025-01-01 00:00:30', status = 'completed' WHERE id = 'council-parent'`);
      await run(db, `UPDATE analysis_runs SET started_at = '2025-01-01 00:00:01', completed_at = '2025-01-01 00:00:15', status = 'completed' WHERE id = 'council-child-1'`);
      await run(db, `UPDATE analysis_runs SET started_at = '2025-01-01 00:00:02', completed_at = '2025-01-01 00:00:20', status = 'completed' WHERE id = 'council-child-2'`);

      const runs = await analysisRunRepo.getByReviewId(testReview.id);
      expect(runs).toHaveLength(3);
      // Parent should appear first because it has the latest completed_at
      expect(runs[0].id).toBe('council-parent');
      expect(runs[1].id).toBe('council-child-2');
      expect(runs[2].id).toBe('council-child-1');
    });

    it('should order council parent run above child runs when timestamps are identical (single-reviewer council)', async () => {
      // When a single-reviewer council skips consolidation, parent and child
      // complete at nearly the same second. The parent must still sort above its children.

      // Create parent council run
      await analysisRunRepo.create({
        id: 'council-parent-same-ts',
        reviewId: testReview.id,
        configType: 'council',
        provider: 'council'
      });

      // Create single child run
      await analysisRunRepo.create({
        id: 'council-child-same-ts',
        reviewId: testReview.id,
        parentRunId: 'council-parent-same-ts',
        configType: 'council'
      });

      // Set identical completed_at for parent and child (simulates single-reviewer council
      // where consolidation is skipped and both complete at the same second).
      // Child has a later started_at and higher ID, which would have caused it to sort first
      // before the fix.
      await run(db, `UPDATE analysis_runs SET started_at = '2025-06-01 15:16:00', completed_at = '2025-06-01 15:16:05', status = 'completed' WHERE id = 'council-parent-same-ts'`);
      await run(db, `UPDATE analysis_runs SET started_at = '2025-06-01 15:16:01', completed_at = '2025-06-01 15:16:05', status = 'completed' WHERE id = 'council-child-same-ts'`);

      const runs = await analysisRunRepo.getByReviewId(testReview.id);
      expect(runs).toHaveLength(2);
      // Parent (parent_run_id IS NULL) must sort above child even with identical completed_at
      expect(runs[0].id).toBe('council-parent-same-ts');
      expect(runs[1].id).toBe('council-child-same-ts');
    });

    it('should order running (incomplete) runs above completed runs when they started more recently', async () => {
      // A running run has no completed_at, so COALESCE falls back to started_at.
      // If a run started recently but hasn't completed, it should still appear near the top.
      await analysisRunRepo.create({
        id: 'old-completed',
        reviewId: testReview.id,
        status: 'completed'
      });
      await analysisRunRepo.create({
        id: 'new-running',
        reviewId: testReview.id
      });

      // Set the old run to have completed before the new run started
      await run(db, `UPDATE analysis_runs SET started_at = '2025-01-01 00:00:00', completed_at = '2025-01-01 00:00:10' WHERE id = 'old-completed'`);
      await run(db, `UPDATE analysis_runs SET started_at = '2025-01-01 00:01:00', completed_at = NULL WHERE id = 'new-running'`);

      const runs = await analysisRunRepo.getByReviewId(testReview.id);
      expect(runs).toHaveLength(2);
      // Running run (started_at 00:01:00) should appear above old completed run (completed_at 00:00:10)
      expect(runs[0].id).toBe('new-running');
      expect(runs[1].id).toBe('old-completed');
    });
  });

  describe('getLatestByReviewId()', () => {
    it('should retrieve the most recent analysis run', async () => {
      // Use IDs that sort correctly when timestamps are identical
      // (id DESC is used as tiebreaker, so 'run-2' > 'run-1')
      await analysisRunRepo.create({ id: 'run-1', reviewId: testReview.id });
      await analysisRunRepo.create({ id: 'run-2', reviewId: testReview.id });

      const latest = await analysisRunRepo.getLatestByReviewId(testReview.id);
      expect(latest).not.toBeNull();
      expect(latest.id).toBe('run-2');
    });

    it('should return null for review with no analysis runs', async () => {
      const latest = await analysisRunRepo.getLatestByReviewId(9999);
      expect(latest).toBeNull();
    });

    it('should include head_sha in the latest retrieved record', async () => {
      const latestSha = 'latestsha123456789012345678901234567890';
      // Use IDs that sort correctly when timestamps are identical
      // (id DESC is used as tiebreaker, so 'sha-run-2' > 'sha-run-1')
      await analysisRunRepo.create({ id: 'sha-run-1', reviewId: testReview.id, headSha: 'oldsha' });
      await analysisRunRepo.create({ id: 'sha-run-2', reviewId: testReview.id, headSha: latestSha });

      const latest = await analysisRunRepo.getLatestByReviewId(testReview.id);
      expect(latest).not.toBeNull();
      expect(latest.id).toBe('sha-run-2');
      expect(latest.head_sha).toBe(latestSha);
    });

    it('should return council parent run as latest when it completed most recently', async () => {
      // Council parent is created first but completes last
      await analysisRunRepo.create({
        id: 'latest-council-parent',
        reviewId: testReview.id,
        configType: 'council',
        provider: 'council'
      });
      await analysisRunRepo.create({
        id: 'latest-council-child',
        reviewId: testReview.id,
        parentRunId: 'latest-council-parent',
        configType: 'council'
      });

      // Parent started earlier but completed later
      await run(db, `UPDATE analysis_runs SET started_at = '2025-06-01 10:00:00', completed_at = '2025-06-01 10:02:00', status = 'completed' WHERE id = 'latest-council-parent'`);
      await run(db, `UPDATE analysis_runs SET started_at = '2025-06-01 10:00:01', completed_at = '2025-06-01 10:01:00', status = 'completed' WHERE id = 'latest-council-child'`);

      const latest = await analysisRunRepo.getLatestByReviewId(testReview.id);
      expect(latest).not.toBeNull();
      expect(latest.id).toBe('latest-council-parent');
    });
  });

  describe('delete()', () => {
    it('should delete an analysis run by ID', async () => {
      const runId = 'test-run-delete';
      await analysisRunRepo.create({ id: runId, reviewId: testReview.id });

      const deleted = await analysisRunRepo.delete(runId);
      expect(deleted).toBe(true);

      const retrieved = await analysisRunRepo.getById(runId);
      expect(retrieved).toBeNull();
    });

    it('should return false when deleting non-existent run', async () => {
      const deleted = await analysisRunRepo.delete('non-existent');
      expect(deleted).toBe(false);
    });
  });

  describe('deleteByReviewId()', () => {
    it('should delete all analysis runs for a review', async () => {
      await analysisRunRepo.create({ id: 'run-a', reviewId: testReview.id });
      await analysisRunRepo.create({ id: 'run-b', reviewId: testReview.id });
      await analysisRunRepo.create({ id: 'run-c', reviewId: testReview.id });

      const deleted = await analysisRunRepo.deleteByReviewId(testReview.id);
      expect(deleted).toBe(3);

      const runs = await analysisRunRepo.getByReviewId(testReview.id);
      expect(runs).toEqual([]);
    });

    it('should return 0 when no runs exist for review', async () => {
      const deleted = await analysisRunRepo.deleteByReviewId(9999);
      expect(deleted).toBe(0);
    });
  });

  describe('create() with voice-centric council columns', () => {
    it('should create a run with parentRunId, configType, and levelsConfig', async () => {
      // Create a parent council run first
      const parentRun = await analysisRunRepo.create({
        id: 'parent-council-run',
        reviewId: testReview.id,
        configType: 'council'
      });

      expect(parentRun.config_type).toBe('council');
      expect(parentRun.parent_run_id).toBeNull();

      // Create a child voice run
      const childRun = await analysisRunRepo.create({
        id: 'child-voice-run',
        reviewId: testReview.id,
        parentRunId: 'parent-council-run',
        configType: 'council',
        levelsConfig: { 1: true, 2: true, 3: false }
      });

      expect(childRun.parent_run_id).toBe('parent-council-run');
      expect(childRun.config_type).toBe('council');
      expect(childRun.levels_config).toBe('{"1":true,"2":true,"3":false}');
    });

    it('should default config_type to single', async () => {
      const result = await analysisRunRepo.create({
        id: 'default-config-run',
        reviewId: testReview.id
      });

      expect(result.config_type).toBe('single');
      expect(result.parent_run_id).toBeNull();
      expect(result.levels_config).toBeNull();
    });

    it('should store levelsConfig as JSON string', async () => {
      const levels = { 1: true, 2: false, 3: true };
      const result = await analysisRunRepo.create({
        id: 'levels-run',
        reviewId: testReview.id,
        levelsConfig: levels
      });

      expect(result.levels_config).toBe(JSON.stringify(levels));
    });

    it('should handle null levelsConfig', async () => {
      const result = await analysisRunRepo.create({
        id: 'null-levels-run',
        reviewId: testReview.id,
        levelsConfig: null
      });

      expect(result.levels_config).toBeNull();
    });
  });

  describe('getChildRuns()', () => {
    it('should return child runs for a parent council run ordered by started_at ASC', async () => {
      // Create parent run
      await analysisRunRepo.create({
        id: 'council-parent',
        reviewId: testReview.id,
        configType: 'council'
      });

      // Create child voice runs
      await analysisRunRepo.create({
        id: 'voice-1',
        reviewId: testReview.id,
        parentRunId: 'council-parent',
        configType: 'council'
      });
      await analysisRunRepo.create({
        id: 'voice-2',
        reviewId: testReview.id,
        parentRunId: 'council-parent',
        configType: 'council'
      });

      const children = await analysisRunRepo.getChildRuns('council-parent');
      expect(children).toHaveLength(2);
      expect(children[0].id).toBe('voice-1');
      expect(children[1].id).toBe('voice-2');
      expect(children[0].parent_run_id).toBe('council-parent');
      expect(children[1].parent_run_id).toBe('council-parent');
    });

    it('should return empty array when no child runs exist', async () => {
      const children = await analysisRunRepo.getChildRuns('non-existent-parent');
      expect(children).toEqual([]);
    });

    it('should not include runs from other parents', async () => {
      await analysisRunRepo.create({
        id: 'parent-a',
        reviewId: testReview.id,
        configType: 'council'
      });
      await analysisRunRepo.create({
        id: 'parent-b',
        reviewId: testReview.id,
        configType: 'council'
      });

      await analysisRunRepo.create({
        id: 'child-of-a',
        reviewId: testReview.id,
        parentRunId: 'parent-a'
      });
      await analysisRunRepo.create({
        id: 'child-of-b',
        reviewId: testReview.id,
        parentRunId: 'parent-b'
      });

      const childrenA = await analysisRunRepo.getChildRuns('parent-a');
      expect(childrenA).toHaveLength(1);
      expect(childrenA[0].id).toBe('child-of-a');
    });

    it('should include new columns in child run results', async () => {
      await analysisRunRepo.create({
        id: 'parent-run',
        reviewId: testReview.id,
        configType: 'council'
      });

      await analysisRunRepo.create({
        id: 'child-run',
        reviewId: testReview.id,
        parentRunId: 'parent-run',
        configType: 'council',
        levelsConfig: { 1: true, 2: true, 3: false }
      });

      const children = await analysisRunRepo.getChildRuns('parent-run');
      expect(children).toHaveLength(1);
      expect(children[0].config_type).toBe('council');
      expect(children[0].levels_config).toBe('{"1":true,"2":true,"3":false}');
      expect(children[0].parent_run_id).toBe('parent-run');
    });
  });
});
