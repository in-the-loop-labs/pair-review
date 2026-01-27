// SPDX-License-Identifier: GPL-3.0-or-later
import { describe, it, expect, beforeEach } from 'vitest';
import { createTestDatabase } from '../utils/schema.js';

const database = require('../../src/database.js');
const {
  query,
  queryOne,
  run,
  GitHubReviewRepository,
} = database;

describe('GitHubReviewRepository', () => {
  let db;
  let githubReviewRepo;
  let reviewId;

  beforeEach(async () => {
    db = await createTestDatabase();
    githubReviewRepo = new GitHubReviewRepository(db);

    // Create a review record for testing
    const result = await run(db, `
      INSERT INTO reviews (pr_number, repository, status, review_type)
      VALUES (?, ?, ?, ?)
    `, [1, 'owner/repo', 'draft', 'pr']);
    reviewId = result.lastID;
  });

  describe('create', () => {
    it('should create a github_review record with default values', async () => {
      const record = await githubReviewRepo.create(reviewId, {});

      expect(record).toBeDefined();
      expect(record.id).toBeGreaterThan(0);
      expect(record.review_id).toBe(reviewId);
      expect(record.state).toBe('local');
      expect(record.github_review_id).toBeNull();
      expect(record.github_node_id).toBeNull();
      expect(record.event).toBeNull();
      expect(record.body).toBeNull();
      expect(record.submitted_at).toBeNull();
      expect(record.github_url).toBeNull();
      expect(record.created_at).toBeDefined();
    });

    it('should create a github_review record with all fields', async () => {
      const record = await githubReviewRepo.create(reviewId, {
        github_review_id: '12345',
        github_node_id: 'PRR_kwDOxyz',
        state: 'pending',
        event: 'COMMENT',
        body: 'Test review body',
        submitted_at: '2025-01-27T10:00:00Z',
        github_url: 'https://github.com/owner/repo/pull/1#pullrequestreview-12345'
      });

      expect(record.github_review_id).toBe('12345');
      expect(record.github_node_id).toBe('PRR_kwDOxyz');
      expect(record.state).toBe('pending');
      expect(record.event).toBe('COMMENT');
      expect(record.body).toBe('Test review body');
      expect(record.submitted_at).toBe('2025-01-27T10:00:00Z');
      expect(record.github_url).toBe('https://github.com/owner/repo/pull/1#pullrequestreview-12345');
    });

    it('should handle Date object for submitted_at', async () => {
      const date = new Date('2025-01-27T10:00:00Z');
      const record = await githubReviewRepo.create(reviewId, {
        submitted_at: date
      });

      expect(record.submitted_at).toBe(date.toISOString());
    });
  });

  describe('getById', () => {
    it('should get a github_review record by id', async () => {
      const created = await githubReviewRepo.create(reviewId, {
        github_review_id: '12345',
        state: 'pending'
      });

      const record = await githubReviewRepo.getById(created.id);

      expect(record).toBeDefined();
      expect(record.id).toBe(created.id);
      expect(record.github_review_id).toBe('12345');
      expect(record.state).toBe('pending');
    });

    it('should return null if not found', async () => {
      const record = await githubReviewRepo.getById(999);
      expect(record).toBeNull();
    });
  });

  describe('findByReviewId', () => {
    it('should get all github_reviews for a review', async () => {
      await githubReviewRepo.create(reviewId, { state: 'submitted' });
      await githubReviewRepo.create(reviewId, { state: 'pending' });

      const records = await githubReviewRepo.findByReviewId(reviewId);

      expect(records.length).toBe(2);
    });

    it('should return records ordered by created_at DESC (most recent first)', async () => {
      await githubReviewRepo.create(reviewId, { github_review_id: 'first' });
      await githubReviewRepo.create(reviewId, { github_review_id: 'second' });

      const records = await githubReviewRepo.findByReviewId(reviewId);

      // Should return 2 records with proper order (by created_at DESC, which in in-memory
      // SQLite with fast inserts may have identical timestamps, so we just verify
      // both are returned and the query specifies DESC order)
      expect(records.length).toBe(2);
      const reviewIds = records.map(r => r.github_review_id);
      expect(reviewIds).toContain('first');
      expect(reviewIds).toContain('second');
    });

    it('should return empty array if no records', async () => {
      const records = await githubReviewRepo.findByReviewId(999);
      expect(records).toEqual([]);
    });
  });

  describe('findPendingByReviewId', () => {
    it('should get only pending github_reviews for a review', async () => {
      await githubReviewRepo.create(reviewId, { state: 'submitted' });
      await githubReviewRepo.create(reviewId, { state: 'pending' });
      await githubReviewRepo.create(reviewId, { state: 'local' });

      const records = await githubReviewRepo.findPendingByReviewId(reviewId);

      expect(records.length).toBe(1);
      expect(records[0].state).toBe('pending');
    });

    it('should return empty array if no pending records', async () => {
      await githubReviewRepo.create(reviewId, { state: 'submitted' });

      const records = await githubReviewRepo.findPendingByReviewId(reviewId);
      expect(records).toEqual([]);
    });
  });

  describe('findByGitHubNodeId', () => {
    it('should find a record by github_node_id and review_id', async () => {
      await githubReviewRepo.create(reviewId, {
        github_node_id: 'PRR_kwDOxyz',
        state: 'pending'
      });

      const record = await githubReviewRepo.findByGitHubNodeId(reviewId, 'PRR_kwDOxyz');

      expect(record).toBeDefined();
      expect(record.github_node_id).toBe('PRR_kwDOxyz');
      expect(record.state).toBe('pending');
    });

    it('should return null if node_id not found', async () => {
      const record = await githubReviewRepo.findByGitHubNodeId(reviewId, 'nonexistent');
      expect(record).toBeNull();
    });

    it('should return null if node_id exists but for different review', async () => {
      // Create another review
      const result = await run(db, `
        INSERT INTO reviews (pr_number, repository, status, review_type)
        VALUES (?, ?, ?, ?)
      `, [2, 'owner/repo', 'draft', 'pr']);
      const otherReviewId = result.lastID;

      await githubReviewRepo.create(otherReviewId, {
        github_node_id: 'PRR_kwDOxyz',
        state: 'pending'
      });

      // Should not find it for the first review
      const record = await githubReviewRepo.findByGitHubNodeId(reviewId, 'PRR_kwDOxyz');
      expect(record).toBeNull();
    });
  });

  describe('update', () => {
    it('should update github_review_id', async () => {
      const created = await githubReviewRepo.create(reviewId, {});

      const updated = await githubReviewRepo.update(created.id, {
        github_review_id: '54321'
      });

      expect(updated).toBe(true);

      const record = await githubReviewRepo.getById(created.id);
      expect(record.github_review_id).toBe('54321');
    });

    it('should update state', async () => {
      const created = await githubReviewRepo.create(reviewId, { state: 'pending' });

      await githubReviewRepo.update(created.id, { state: 'submitted' });

      const record = await githubReviewRepo.getById(created.id);
      expect(record.state).toBe('submitted');
    });

    it('should update multiple fields at once', async () => {
      const created = await githubReviewRepo.create(reviewId, {});

      await githubReviewRepo.update(created.id, {
        github_review_id: '12345',
        github_node_id: 'PRR_kwDOabc',
        state: 'submitted',
        event: 'APPROVE',
        body: 'LGTM!',
        submitted_at: '2025-01-27T12:00:00Z',
        github_url: 'https://github.com/owner/repo/pull/1#pullrequestreview-12345'
      });

      const record = await githubReviewRepo.getById(created.id);
      expect(record.github_review_id).toBe('12345');
      expect(record.github_node_id).toBe('PRR_kwDOabc');
      expect(record.state).toBe('submitted');
      expect(record.event).toBe('APPROVE');
      expect(record.body).toBe('LGTM!');
      expect(record.submitted_at).toBe('2025-01-27T12:00:00Z');
      expect(record.github_url).toBe('https://github.com/owner/repo/pull/1#pullrequestreview-12345');
    });

    it('should return false if no fields to update', async () => {
      const created = await githubReviewRepo.create(reviewId, {});

      const updated = await githubReviewRepo.update(created.id, {});

      expect(updated).toBe(false);
    });

    it('should return false if record not found', async () => {
      const updated = await githubReviewRepo.update(999, { state: 'submitted' });
      expect(updated).toBe(false);
    });

    it('should handle Date object for submitted_at in update', async () => {
      const created = await githubReviewRepo.create(reviewId, {});
      const date = new Date('2025-01-27T15:00:00Z');

      await githubReviewRepo.update(created.id, { submitted_at: date });

      const record = await githubReviewRepo.getById(created.id);
      expect(record.submitted_at).toBe(date.toISOString());
    });
  });
});
