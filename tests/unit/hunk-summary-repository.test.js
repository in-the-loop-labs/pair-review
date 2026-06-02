// Copyright 2026 Tim Perkins (tjwp) | SPDX-License-Identifier: Apache-2.0
import { describe, it, expect, beforeEach } from 'vitest';
import { createTestDatabase } from '../utils/schema.js';

const database = require('../../src/database.js');
const {
  run,
  query,
  HunkSummaryRepository,
} = database;

describe('HunkSummaryRepository', () => {
  let db;
  let repo;
  let reviewId;
  let otherReviewId;

  beforeEach(async () => {
    db = await createTestDatabase();
    repo = new HunkSummaryRepository(db);

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

  describe('upsertMany', () => {
    it('inserts new rows and returns the count', async () => {
      const rows = [
        {
          review_id: reviewId,
          file_path: 'src/a.js',
          content_hash: 'hash-a',
          summary_text: 'Adds helper',
          provider: 'claude',
          model: 'haiku',
        },
        {
          review_id: reviewId,
          file_path: 'src/b.js',
          content_hash: 'hash-b',
          summary_text: 'Removes dead code',
          provider: 'claude',
          model: 'haiku',
        },
      ];

      const count = await repo.upsertMany(rows);
      expect(count).toBe(2);

      const persisted = await query(db, 'SELECT * FROM hunk_summaries ORDER BY content_hash', []);
      expect(persisted).toHaveLength(2);
      expect(persisted[0].content_hash).toBe('hash-a');
      expect(persisted[0].summary_text).toBe('Adds helper');
      expect(persisted[0].provider).toBe('claude');
      expect(persisted[0].model).toBe('haiku');
      expect(persisted[0].trivial_reason).toBeNull();
    });

    it('updates existing rows on (review_id, content_hash) conflict', async () => {
      await repo.upsertMany([
        {
          review_id: reviewId,
          file_path: 'src/a.js',
          content_hash: 'hash-a',
          summary_text: 'Original summary',
          provider: 'claude',
          model: 'haiku',
        },
      ]);

      const count = await repo.upsertMany([
        {
          review_id: reviewId,
          file_path: 'src/a-renamed.js',
          content_hash: 'hash-a',
          summary_text: 'Updated summary',
          provider: 'gemini',
          model: 'flash',
        },
      ]);
      expect(count).toBe(1);

      const persisted = await query(db, 'SELECT * FROM hunk_summaries WHERE content_hash = ?', ['hash-a']);
      expect(persisted).toHaveLength(1);
      expect(persisted[0].summary_text).toBe('Updated summary');
      expect(persisted[0].file_path).toBe('src/a-renamed.js');
      expect(persisted[0].provider).toBe('gemini');
      expect(persisted[0].model).toBe('flash');
    });

    it('returns 0 and does not error on empty array', async () => {
      const count = await repo.upsertMany([]);
      expect(count).toBe(0);

      const persisted = await query(db, 'SELECT * FROM hunk_summaries', []);
      expect(persisted).toHaveLength(0);
    });

    it('returns 0 when given a non-array input', async () => {
      const count = await repo.upsertMany(null);
      expect(count).toBe(0);
    });

    it('persists trivial rows with summary_text=null and a trivial_reason', async () => {
      const count = await repo.upsertMany([
        {
          review_id: reviewId,
          file_path: 'src/whitespace.js',
          content_hash: 'hash-trivial',
          summary_text: null,
          trivial_reason: 'whitespace',
        },
      ]);
      expect(count).toBe(1);

      const persisted = await query(db, 'SELECT * FROM hunk_summaries WHERE content_hash = ?', ['hash-trivial']);
      expect(persisted).toHaveLength(1);
      expect(persisted[0].summary_text).toBeNull();
      expect(persisted[0].trivial_reason).toBe('whitespace');
      expect(persisted[0].provider).toBeNull();
      expect(persisted[0].model).toBeNull();
    });

    it('transitions a non-trivial row to trivial via upsert', async () => {
      await repo.upsertMany([
        {
          review_id: reviewId,
          file_path: 'src/a.js',
          content_hash: 'abc',
          summary_text: 'Adds X',
          trivial_reason: null,
          provider: 'claude',
          model: 'opus',
        },
      ]);

      await repo.upsertMany([
        {
          review_id: reviewId,
          file_path: 'src/a.js',
          content_hash: 'abc',
          summary_text: null,
          trivial_reason: 'whitespace',
          provider: null,
          model: null,
        },
      ]);

      const results = await repo.getByHashes(reviewId, ['abc']);
      expect(results).toHaveLength(1);
      expect(results[0].summary_text).toBeNull();
      expect(results[0].trivial_reason).toBe('whitespace');
    });

    it('transitions a trivial row to non-trivial via upsert', async () => {
      await repo.upsertMany([
        {
          review_id: reviewId,
          file_path: 'src/a.js',
          content_hash: 'def',
          summary_text: null,
          trivial_reason: 'tiny',
          provider: null,
          model: null,
        },
      ]);

      await repo.upsertMany([
        {
          review_id: reviewId,
          file_path: 'src/a.js',
          content_hash: 'def',
          summary_text: 'Adds Y',
          trivial_reason: null,
          provider: 'claude',
          model: 'haiku',
        },
      ]);

      const results = await repo.getByHashes(reviewId, ['def']);
      expect(results).toHaveLength(1);
      expect(results[0].summary_text).toBe('Adds Y');
      expect(results[0].trivial_reason).toBeNull();
    });

    it('rejects rows missing both summary_text and trivial_reason', async () => {
      await expect(
        repo.upsertMany([
          {
            review_id: reviewId,
            file_path: 'src/a.js',
            content_hash: 'bad',
            summary_text: null,
            trivial_reason: null,
          },
        ])
      ).rejects.toThrow(/summary_text or trivial_reason/);
    });

    it('allows the same content_hash across different reviews', async () => {
      await repo.upsertMany([
        {
          review_id: reviewId,
          file_path: 'src/a.js',
          content_hash: 'shared-hash',
          summary_text: 'Review 1 summary',
        },
        {
          review_id: otherReviewId,
          file_path: 'src/a.js',
          content_hash: 'shared-hash',
          summary_text: 'Review 2 summary',
        },
      ]);

      const persisted = await query(db, 'SELECT * FROM hunk_summaries WHERE content_hash = ? ORDER BY review_id', ['shared-hash']);
      expect(persisted).toHaveLength(2);
      expect(persisted[0].review_id).toBe(reviewId);
      expect(persisted[1].review_id).toBe(otherReviewId);
    });
  });

  describe('getByReview', () => {
    it('returns only rows for the given review_id, ordered by file_path', async () => {
      await repo.upsertMany([
        { review_id: reviewId, file_path: 'src/c.js', content_hash: 'hc', summary_text: 'c' },
        { review_id: reviewId, file_path: 'src/a.js', content_hash: 'ha', summary_text: 'a' },
        { review_id: reviewId, file_path: 'src/b.js', content_hash: 'hb', summary_text: 'b' },
        { review_id: otherReviewId, file_path: 'src/a.js', content_hash: 'ho', summary_text: 'other' },
      ]);

      const results = await repo.getByReview(reviewId);
      expect(results).toHaveLength(3);
      expect(results.map(r => r.file_path)).toEqual(['src/a.js', 'src/b.js', 'src/c.js']);
      expect(results.every(r => r.review_id === reviewId)).toBe(true);
    });

    it('returns an empty array when no rows exist', async () => {
      const results = await repo.getByReview(reviewId);
      expect(results).toEqual([]);
    });
  });

  describe('getByReviewAndFile', () => {
    it('returns only rows matching the requested file_path within the review', async () => {
      await repo.upsertMany([
        { review_id: reviewId, file_path: 'src/a.js', content_hash: 'a1', summary_text: 'a1' },
        { review_id: reviewId, file_path: 'src/a.js', content_hash: 'a2', summary_text: 'a2' },
        { review_id: reviewId, file_path: 'src/b.js', content_hash: 'b1', summary_text: 'b1' },
        { review_id: otherReviewId, file_path: 'src/a.js', content_hash: 'oa', summary_text: 'other' }
      ]);

      const results = await repo.getByReviewAndFile(reviewId, 'src/a.js');
      expect(results).toHaveLength(2);
      expect(results.every((r) => r.file_path === 'src/a.js')).toBe(true);
      expect(results.every((r) => r.review_id === reviewId)).toBe(true);
      expect(results.map((r) => r.content_hash).sort()).toEqual(['a1', 'a2']);
    });

    it('returns an empty array when no rows match', async () => {
      const results = await repo.getByReviewAndFile(reviewId, 'src/nope.js');
      expect(results).toEqual([]);
    });
  });

  describe('getByHashes', () => {
    beforeEach(async () => {
      await repo.upsertMany([
        { review_id: reviewId, file_path: 'src/a.js', content_hash: 'h1', summary_text: 's1' },
        { review_id: reviewId, file_path: 'src/b.js', content_hash: 'h2', summary_text: 's2' },
        { review_id: reviewId, file_path: 'src/c.js', content_hash: 'h3', summary_text: 's3' },
        { review_id: otherReviewId, file_path: 'src/a.js', content_hash: 'h1', summary_text: 'other-review' },
      ]);
    });

    it('returns only rows matching the given hashes within the review', async () => {
      const results = await repo.getByHashes(reviewId, ['h1', 'h3', 'missing-hash']);
      expect(results).toHaveLength(2);
      const hashes = results.map(r => r.content_hash).sort();
      expect(hashes).toEqual(['h1', 'h3']);
      expect(results.every(r => r.review_id === reviewId)).toBe(true);
    });

    it('returns an empty array when given an empty hashes array', async () => {
      const results = await repo.getByHashes(reviewId, []);
      expect(results).toEqual([]);
    });

    it('returns an empty array when given a non-array', async () => {
      const results = await repo.getByHashes(reviewId, null);
      expect(results).toEqual([]);
    });

    it('does not return rows from a different review even if hash matches', async () => {
      const results = await repo.getByHashes(otherReviewId, ['h1', 'h2']);
      expect(results).toHaveLength(1);
      expect(results[0].content_hash).toBe('h1');
      expect(results[0].review_id).toBe(otherReviewId);
      expect(results[0].summary_text).toBe('other-review');
    });
  });

  describe('deleteByReview', () => {
    it('removes only rows for the matching review', async () => {
      await repo.upsertMany([
        { review_id: reviewId, file_path: 'src/a.js', content_hash: 'h1', summary_text: 's1' },
        { review_id: reviewId, file_path: 'src/b.js', content_hash: 'h2', summary_text: 's2' },
        { review_id: otherReviewId, file_path: 'src/a.js', content_hash: 'h3', summary_text: 's3' },
      ]);

      const result = await repo.deleteByReview(reviewId);
      expect(result.changes).toBe(2);

      const remaining = await query(db, 'SELECT * FROM hunk_summaries', []);
      expect(remaining).toHaveLength(1);
      expect(remaining[0].review_id).toBe(otherReviewId);
    });

    it('returns 0 changes when no rows match', async () => {
      const result = await repo.deleteByReview(reviewId);
      expect(result.changes).toBe(0);
    });
  });

  describe('CASCADE delete from reviews', () => {
    it('removes hunk_summaries when the parent review is deleted', async () => {
      await repo.upsertMany([
        { review_id: reviewId, file_path: 'src/a.js', content_hash: 'h1', summary_text: 's1' },
      ]);

      await run(db, 'DELETE FROM reviews WHERE id = ?', [reviewId]);

      const remaining = await query(db, 'SELECT * FROM hunk_summaries WHERE review_id = ?', [reviewId]);
      expect(remaining).toHaveLength(0);
    });
  });
});
