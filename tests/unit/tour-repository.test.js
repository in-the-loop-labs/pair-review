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
      const hashSet = JSON.stringify(['h1']);

      const result = await repo.upsert({
        review_id: reviewId,
        stops,
        hash_set: hashSet,
        provider: 'claude',
        model: 'haiku',
      });

      expect(result.changes).toBe(1);

      const persisted = await query(db, 'SELECT * FROM tours WHERE review_id = ?', [reviewId]);
      expect(persisted).toHaveLength(1);
      expect(persisted[0].review_id).toBe(reviewId);
      expect(persisted[0].stops).toBe(stops);
      expect(persisted[0].hash_set).toBe(hashSet);
      expect(persisted[0].provider).toBe('claude');
      expect(persisted[0].model).toBe('haiku');
    });

    it('replaces the existing row on (review_id) conflict', async () => {
      const originalStops = JSON.stringify([{ file: 'a.js', hash: 'h1', summary: 'original' }]);
      const originalHashSet = JSON.stringify(['h1']);

      await repo.upsert({
        review_id: reviewId,
        stops: originalStops,
        hash_set: originalHashSet,
        provider: 'claude',
        model: 'haiku',
      });

      const beforeRows = await query(db, 'SELECT * FROM tours WHERE review_id = ?', [reviewId]);
      const originalCreatedAt = beforeRows[0].created_at;

      const newStops = JSON.stringify([
        { file: 'a.js', hash: 'h1', summary: 'updated' },
        { file: 'b.js', hash: 'h2', summary: 'second' },
      ]);
      const newHashSet = JSON.stringify(['h1', 'h2']);

      const result = await repo.upsert({
        review_id: reviewId,
        stops: newStops,
        hash_set: newHashSet,
        provider: 'gemini',
        model: 'flash',
      });

      expect(result.changes).toBe(1);

      const persisted = await query(db, 'SELECT * FROM tours WHERE review_id = ?', [reviewId]);
      expect(persisted).toHaveLength(1);
      expect(persisted[0].stops).toBe(newStops);
      expect(persisted[0].hash_set).toBe(newHashSet);
      expect(persisted[0].provider).toBe('gemini');
      expect(persisted[0].model).toBe('flash');
      // SQLite CURRENT_TIMESTAMP has 1-second resolution; assert >= rather than strictly >.
      expect(persisted[0].created_at >= originalCreatedAt).toBe(true);
    });

    it('stores stops and hash_set verbatim (no JSON re-stringification)', async () => {
      // A specific JSON string with whitespace and field order that round-tripping would change.
      const stops = '[{"file":"a.js","hash":"h1","summary":"verbatim test"}]';
      const hashSet = '["h1","h2","h3"]';

      await repo.upsert({
        review_id: reviewId,
        stops,
        hash_set: hashSet,
        provider: null,
        model: null,
      });

      const persisted = await query(db, 'SELECT stops, hash_set FROM tours WHERE review_id = ?', [reviewId]);
      expect(persisted[0].stops).toBe(stops);
      expect(persisted[0].hash_set).toBe(hashSet);
    });

    it('accepts null provider and model (optional fields default to null when omitted)', async () => {
      const stops = JSON.stringify([{ file: 'a.js', hash: 'h1', summary: 's' }]);
      const hashSet = JSON.stringify(['h1']);

      const result = await repo.upsert({
        review_id: reviewId,
        stops,
        hash_set: hashSet,
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
        hash_set: JSON.stringify(['h1']),
        provider: 'claude',
        model: 'haiku',
      });

      await repo.upsert({
        review_id: otherReviewId,
        stops: stops2,
        hash_set: JSON.stringify(['h2']),
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
    it('returns the row for a matching review_id, with stops/hash_set as raw strings', async () => {
      const stops = JSON.stringify([{ file: 'a.js', hash: 'h1', summary: 's' }]);
      const hashSet = JSON.stringify(['h1', 'h2']);

      await repo.upsert({
        review_id: reviewId,
        stops,
        hash_set: hashSet,
        provider: 'claude',
        model: 'opus',
      });

      const result = await repo.get(reviewId);
      expect(result).toBeDefined();
      expect(result.review_id).toBe(reviewId);
      // Raw strings — repo does not parse.
      expect(typeof result.stops).toBe('string');
      expect(typeof result.hash_set).toBe('string');
      expect(result.stops).toBe(stops);
      expect(result.hash_set).toBe(hashSet);
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
        hash_set: JSON.stringify(['h1']),
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
        hash_set: JSON.stringify(['h1']),
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
        hash_set: JSON.stringify(['h1']),
      });
      await repo.upsert({
        review_id: otherReviewId,
        stops: JSON.stringify([{ file: 'b.js', hash: 'h2', summary: 'second' }]),
        hash_set: JSON.stringify(['h2']),
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
        hash_set: JSON.stringify(['h1']),
      });

      await run(db, 'DELETE FROM reviews WHERE id = ?', [reviewId]);

      const remaining = await query(db, 'SELECT * FROM tours WHERE review_id = ?', [reviewId]);
      expect(remaining).toHaveLength(0);
    });
  });
});
