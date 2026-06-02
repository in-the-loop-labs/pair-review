// Copyright 2026 Tim Perkins (tjwp) | SPDX-License-Identifier: Apache-2.0
import { describe, it, expect, beforeEach } from 'vitest';
import { createTestDatabase } from '../utils/schema.js';

const database = require('../../src/database.js');
const {
  run,
  query,
  TourRepository,
} = database;

describe('TourRepository', () => {
  let db;
  let repo;
  let reviewId;
  let otherReviewId;

  beforeEach(async () => {
    db = await createTestDatabase();
    repo = new TourRepository(db);

    // Insert two review rows so we can verify per-review scoping
    const r1 = await run(db, `
      INSERT INTO reviews (pr_number, repository, status)
      VALUES (?, ?, ?)
    `, [1, 'owner/repo', 'draft']);
    reviewId = r1.lastID;

    const r2 = await run(db, `
      INSERT INTO reviews (pr_number, repository, status)
      VALUES (?, ?, ?)
    `, [2, 'owner/repo', 'draft']);
    otherReviewId = r2.lastID;
  });

  describe('upsert', () => {
    it('inserts a new row and returns { changes: 1 }', async () => {
      const stops = JSON.stringify([{ file: 'a.js', hash: 'h1', summary: 'first stop' }]);
      const diffHash = 'abc123def456';

      const result = await repo.upsert({
        review_id: reviewId,
        stops,
        diff_hash: diffHash,
        provider: 'claude',
        model: 'haiku',
      });

      expect(result.changes).toBe(1);

      const persisted = await query(db, 'SELECT * FROM tours WHERE review_id = ?', [reviewId]);
      expect(persisted).toHaveLength(1);
      expect(persisted[0].id).toEqual(expect.any(Number));
      expect(persisted[0].id).toBeGreaterThan(0);
      expect(persisted[0].review_id).toBe(reviewId);
      expect(persisted[0].stops).toBe(stops);
      expect(persisted[0].diff_hash).toBe(diffHash);
      expect(persisted[0].provider).toBe('claude');
      expect(persisted[0].model).toBe('haiku');
    });

    it('throws when review_id is null', async () => {
      const stops = JSON.stringify([{ file: 'a.js', hash: 'h1', summary: 's' }]);
      const diffHash = 'abc123';

      await expect(
        repo.upsert({ stops, diff_hash: diffHash })
      ).rejects.toThrow(/review_id/);

      const persisted = await query(db, 'SELECT * FROM tours', []);
      expect(persisted).toHaveLength(0);
    });

    it('replaces the existing row on (review_id) conflict', async () => {
      const originalStops = JSON.stringify([{ file: 'a.js', hash: 'h1', summary: 'original' }]);
      const originalDiffHash = 'orig-hash';

      await repo.upsert({
        review_id: reviewId,
        stops: originalStops,
        diff_hash: originalDiffHash,
        provider: 'claude',
        model: 'haiku',
      });

      const beforeRows = await query(db, 'SELECT * FROM tours WHERE review_id = ?', [reviewId]);
      const originalCreatedAt = beforeRows[0].created_at;
      const originalId = beforeRows[0].id;

      const newStops = JSON.stringify([
        { file: 'a.js', hash: 'h1', summary: 'updated' },
        { file: 'b.js', hash: 'h2', summary: 'second' },
      ]);
      const newDiffHash = 'new-hash';

      const result = await repo.upsert({
        review_id: reviewId,
        stops: newStops,
        diff_hash: newDiffHash,
        provider: 'gemini',
        model: 'flash',
      });

      expect(result.changes).toBe(1);

      const persisted = await query(db, 'SELECT * FROM tours WHERE review_id = ?', [reviewId]);
      expect(persisted).toHaveLength(1);
      expect(persisted[0].stops).toBe(newStops);
      expect(persisted[0].diff_hash).toBe(newDiffHash);
      expect(persisted[0].provider).toBe('gemini');
      expect(persisted[0].model).toBe('flash');
      expect(persisted[0].id).toBe(originalId);
      // SQLite CURRENT_TIMESTAMP has 1-second resolution; assert >= rather than strictly >.
      expect(persisted[0].created_at >= originalCreatedAt).toBe(true);
    });

    it('stores stops and diff_hash verbatim (no JSON re-stringification)', async () => {
      // A specific JSON string with whitespace and field order that round-tripping would change.
      const stops = '[{"file":"a.js","hash":"h1","summary":"verbatim test"}]';
      const diffHash = 'verbatim-hash-value';

      await repo.upsert({
        review_id: reviewId,
        stops,
        diff_hash: diffHash,
        provider: null,
        model: null,
      });

      const persisted = await query(db, 'SELECT stops, diff_hash FROM tours WHERE review_id = ?', [reviewId]);
      expect(persisted[0].stops).toBe(stops);
      expect(persisted[0].diff_hash).toBe(diffHash);
    });

    it('accepts null provider and model (optional fields default to null when omitted)', async () => {
      const stops = JSON.stringify([{ file: 'a.js', hash: 'h1', summary: 's' }]);
      const diffHash = 'h1';

      const result = await repo.upsert({
        review_id: reviewId,
        stops,
        diff_hash: diffHash,
      });
      expect(result.changes).toBe(1);

      const persisted = await query(db, 'SELECT * FROM tours WHERE review_id = ?', [reviewId]);
      expect(persisted).toHaveLength(1);
      expect(persisted[0].provider).toBeNull();
      expect(persisted[0].model).toBeNull();
    });

    it('allows two different review_ids to coexist', async () => {
      const stops1 = JSON.stringify([{ file: 'a.js', hash: 'h1', summary: 'review 1' }]);
      const stops2 = JSON.stringify([{ file: 'b.js', hash: 'h2', summary: 'review 2' }]);

      await repo.upsert({
        review_id: reviewId,
        stops: stops1,
        diff_hash: 'hash1',
        provider: 'claude',
        model: 'haiku',
      });

      await repo.upsert({
        review_id: otherReviewId,
        stops: stops2,
        diff_hash: 'hash2',
        provider: 'gemini',
        model: 'flash',
      });

      const persisted = await query(db, 'SELECT * FROM tours ORDER BY review_id', []);
      expect(persisted).toHaveLength(2);
      expect(persisted[0].review_id).toBe(reviewId);
      expect(persisted[0].stops).toBe(stops1);
      expect(persisted[1].review_id).toBe(otherReviewId);
      expect(persisted[1].stops).toBe(stops2);
    });
  });

  describe('get', () => {
    it('returns the row for a matching review_id, with stops/diff_hash as raw strings', async () => {
      const stops = JSON.stringify([{ file: 'a.js', hash: 'h1', summary: 's' }]);
      const diffHash = 'fetched-hash';

      await repo.upsert({
        review_id: reviewId,
        stops,
        diff_hash: diffHash,
        provider: 'claude',
        model: 'opus',
      });

      const result = await repo.get(reviewId);
      expect(result).toBeDefined();
      expect(result.review_id).toBe(reviewId);
      // Raw strings — repo does not parse.
      expect(typeof result.stops).toBe('string');
      expect(typeof result.diff_hash).toBe('string');
      expect(result.stops).toBe(stops);
      expect(result.diff_hash).toBe(diffHash);
      expect(result.provider).toBe('claude');
      expect(result.model).toBe('opus');
      expect(result.created_at).toBeDefined();
    });

    it('returns undefined when no row exists', async () => {
      const result = await repo.get(reviewId);
      expect(result).toBeUndefined();
    });

    it('does not return rows for a different review', async () => {
      const stops = JSON.stringify([{ file: 'a.js', hash: 'h1', summary: 'other' }]);
      await repo.upsert({
        review_id: otherReviewId,
        stops,
        diff_hash: 'hashX',
      });

      const result = await repo.get(reviewId);
      expect(result).toBeUndefined();
    });
  });

  describe('deleteByReview', () => {
    it('removes the row and returns { changes: 1 }', async () => {
      await repo.upsert({
        review_id: reviewId,
        stops: JSON.stringify([{ file: 'a.js', hash: 'h1', summary: 's' }]),
        diff_hash: 'h',
      });

      const result = await repo.deleteByReview(reviewId);
      expect(result.changes).toBe(1);

      const remaining = await query(db, 'SELECT * FROM tours WHERE review_id = ?', [reviewId]);
      expect(remaining).toHaveLength(0);
    });

    it('returns { changes: 0 } when no row exists', async () => {
      const result = await repo.deleteByReview(reviewId);
      expect(result.changes).toBe(0);
    });

    it('only removes the row for the matching review', async () => {
      await repo.upsert({
        review_id: reviewId,
        stops: JSON.stringify([{ file: 'a.js', hash: 'h1', summary: 'first' }]),
        diff_hash: 'h1',
      });
      await repo.upsert({
        review_id: otherReviewId,
        stops: JSON.stringify([{ file: 'b.js', hash: 'h2', summary: 'second' }]),
        diff_hash: 'h2',
      });

      const result = await repo.deleteByReview(reviewId);
      expect(result.changes).toBe(1);

      const remaining = await query(db, 'SELECT * FROM tours', []);
      expect(remaining).toHaveLength(1);
      expect(remaining[0].review_id).toBe(otherReviewId);
    });
  });

  describe('CASCADE delete from reviews', () => {
    it('removes the tour row when the parent review is deleted', async () => {
      await repo.upsert({
        review_id: reviewId,
        stops: JSON.stringify([{ file: 'a.js', hash: 'h1', summary: 's' }]),
        diff_hash: 'h',
      });

      await run(db, 'DELETE FROM reviews WHERE id = ?', [reviewId]);

      const remaining = await query(db, 'SELECT * FROM tours WHERE review_id = ?', [reviewId]);
      expect(remaining).toHaveLength(0);
    });
  });
});
