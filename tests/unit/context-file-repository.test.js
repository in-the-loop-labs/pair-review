// SPDX-License-Identifier: GPL-3.0-or-later
import { describe, it, expect, beforeEach } from 'vitest';
import { createTestDatabase } from '../utils/schema.js';

const database = require('../../src/database.js');
const {
  run,
  ContextFileRepository,
} = database;

describe('ContextFileRepository', () => {
  let db;
  let contextFileRepo;
  let reviewId;

  beforeEach(async () => {
    db = await createTestDatabase();
    contextFileRepo = new ContextFileRepository(db);

    // Insert a review record to satisfy foreign key constraints
    const result = await run(db, `
      INSERT INTO reviews (pr_number, repository, status)
      VALUES (?, ?, ?)
    `, [1, 'owner/repo', 'draft']);
    reviewId = result.lastID;
  });

  describe('add', () => {
    it('should create a context file record and return it with all fields', async () => {
      const record = await contextFileRepo.add(reviewId, 'src/utils.js', 10, 25, 'helper function');

      expect(record).toBeDefined();
      expect(record.id).toBeGreaterThan(0);
      expect(record.review_id).toBe(reviewId);
      expect(record.file).toBe('src/utils.js');
      expect(record.line_start).toBe(10);
      expect(record.line_end).toBe(25);
      expect(record.label).toBe('helper function');
      expect(record.created_at).toBeDefined();
    });

    it('should create a context file with optional label', async () => {
      const record = await contextFileRepo.add(reviewId, 'src/main.js', 1, 50, 'initialization logic');

      expect(record.label).toBe('initialization logic');
    });

    it('should create a context file without label (null)', async () => {
      const record = await contextFileRepo.add(reviewId, 'src/main.js', 1, 50);

      expect(record.label).toBeNull();
    });
  });

  describe('getByReviewId', () => {
    it('should return all context files for a review, ordered by id', async () => {
      await contextFileRepo.add(reviewId, 'src/a.js', 1, 10, 'first');
      await contextFileRepo.add(reviewId, 'src/b.js', 20, 30, 'second');
      await contextFileRepo.add(reviewId, 'src/c.js', 40, 50, 'third');

      const results = await contextFileRepo.getByReviewId(reviewId);

      expect(results).toHaveLength(3);
      expect(results[0].file).toBe('src/a.js');
      expect(results[1].file).toBe('src/b.js');
      expect(results[2].file).toBe('src/c.js');
      // Verify ordering by id (ascending)
      expect(results[0].id).toBeLessThan(results[1].id);
      expect(results[1].id).toBeLessThan(results[2].id);
    });

    it('should return empty array when no context files exist', async () => {
      const results = await contextFileRepo.getByReviewId(reviewId);

      expect(results).toEqual([]);
    });
  });

  describe('remove', () => {
    it('should delete by id and return true', async () => {
      const record1 = await contextFileRepo.add(reviewId, 'src/utils.js', 10, 25);
      const record2 = await contextFileRepo.add(reviewId, 'src/helpers.js', 30, 40);

      const deleted = await contextFileRepo.remove(record1.id, reviewId);

      expect(deleted).toBe(true);

      // Verify only the targeted record is removed
      const results = await contextFileRepo.getByReviewId(reviewId);
      expect(results).toHaveLength(1);
      expect(results[0].id).toBe(record2.id);
    });

    it('should return false for non-existent id', async () => {
      const deleted = await contextFileRepo.remove(99999, reviewId);

      expect(deleted).toBe(false);
    });

    it('should return false when id exists but belongs to different review', async () => {
      const result2 = await run(db, `
        INSERT INTO reviews (pr_number, repository, status)
        VALUES (?, ?, ?)
      `, [2, 'owner/other-repo', 'draft']);
      const otherReviewId = result2.lastID;

      const record = await contextFileRepo.add(otherReviewId, 'src/secret.js', 1, 10);

      // Try to remove it using the wrong reviewId
      const deleted = await contextFileRepo.remove(record.id, reviewId);

      expect(deleted).toBe(false);

      // Verify the record still exists
      const results = await contextFileRepo.getByReviewId(otherReviewId);
      expect(results).toHaveLength(1);
    });
  });

  describe('removeAll', () => {
    it('should delete all context files for a review and return count', async () => {
      // Create a second review
      const result2 = await run(db, `
        INSERT INTO reviews (pr_number, repository, status)
        VALUES (?, ?, ?)
      `, [2, 'owner/other-repo', 'draft']);
      const otherReviewId = result2.lastID;

      await contextFileRepo.add(reviewId, 'src/a.js', 1, 10);
      await contextFileRepo.add(reviewId, 'src/b.js', 20, 30);
      await contextFileRepo.add(reviewId, 'src/c.js', 40, 50);
      await contextFileRepo.add(otherReviewId, 'src/d.js', 1, 10);

      const count = await contextFileRepo.removeAll(reviewId);

      expect(count).toBe(3);

      // Verify the target review's files are gone
      const results = await contextFileRepo.getByReviewId(reviewId);
      expect(results).toHaveLength(0);

      // Verify the other review's files survived
      const otherResults = await contextFileRepo.getByReviewId(otherReviewId);
      expect(otherResults).toHaveLength(1);
      expect(otherResults[0].file).toBe('src/d.js');
    });

    it('should return 0 when no context files exist', async () => {
      const count = await contextFileRepo.removeAll(reviewId);

      expect(count).toBe(0);
    });
  });
});
