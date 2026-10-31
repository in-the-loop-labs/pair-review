// Copyright 2026 Tim Perkins (tjwp) | SPDX-License-Identifier: Apache-2.0
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
const Database = require('better-sqlite3');
const { createTestDatabase, seedTestReview } = require('../utils/schema');
const { MIGRATIONS, runVersionedMigrations, GitHubReviewRepository, CommentPostingRepository } = require('../../src/database');

describe('comment posting storage and legacy upgrade', () => {
  let db;
  beforeEach(async () => { db = await createTestDatabase(); });
  afterEach(() => { db.close(); });

  it('backfills by status and time, with unknown-review fallback and idempotence', async () => {
    const review = await seedTestReview(db);
    const other = await seedTestReview(db, { prNumber: 999 });
    db.prepare(`INSERT INTO github_reviews (id, review_id, state, created_at) VALUES
      (1, ?, 'submitted', '2026-01-01 00:00:00'),
      (2, ?, 'submitted', '2026-01-02 00:00:00'),
      (3, ?, 'pending', '2026-01-03 00:00:00')`).run(review, review, review);
    const insert = db.prepare(`INSERT INTO comments
      (id, review_id, source, body, status, updated_at) VALUES (?, ?, 'user', 'snapshot', ?, ?)`);
    insert.run(1, review, 'submitted', '2026-01-01 00:00:01');
    insert.run(2, review, 'submitted', '2026-01-02 00:00:01');
    insert.run(3, review, 'draft', '2026-01-03 00:00:01');
    insert.run(4, review, 'inactive', '2026-01-03 00:00:01');
    insert.run(5, other, 'submitted', '2026-01-03 00:00:01');
    MIGRATIONS[56](db);
    MIGRATIONS[56](db);
    expect(db.prepare('SELECT comment_id, github_review_row_id FROM comment_postings ORDER BY comment_id').all()).toEqual([
      { comment_id: 1, github_review_row_id: 1 },
      { comment_id: 2, github_review_row_id: 2 },
      { comment_id: 3, github_review_row_id: 3 },
      { comment_id: 5, github_review_row_id: null }
    ]);
    expect(db.prepare('SELECT * FROM comment_postings').all().every(p => p.backfilled === 1 && p.body === p.comment_body)).toBe(true);
  });

  it('upserts one GitHub identity, preserves draft body/url, and propagates state to legacy duplicates', async () => {
    const review = await seedTestReview(db);
    const repo = new GitHubReviewRepository(db);
    const a = await repo.create(review, { github_node_id: 'NODE', state: 'pending', body: 'original', github_url: 'https://example.test/review' });
    const b = await repo.create(review, { github_node_id: 'NODE', state: 'pending', body: 'original', github_url: 'https://example.test/review' });
    const draft = await repo.upsertForSubmission(review, { github_node_id: 'NODE', state: 'pending', body: 'ignored', github_url: null });
    expect(draft.id).toBe(b.id);
    expect(draft.body).toBe('original');
    expect(draft.github_url).toBe('https://example.test/review');
    await repo.upsertForSubmission(review, { github_node_id: 'NODE', state: 'submitted', event: 'APPROVE', submitted_at: '2026-01-04' });
    expect((await repo.getById(a.id)).state).toBe('submitted');
    expect((await repo.findByReviewId(review))).toHaveLength(2);
  });

  it('cascades comment deletion and retains history when a GitHub row is deleted', async () => {
    const review = await seedTestReview(db);
    const github = await new GitHubReviewRepository(db).create(review);
    db.prepare(`INSERT INTO comments (id, review_id, source, body) VALUES (1, ?, 'user', 'body')`).run(review);
    const postings = new CommentPostingRepository(db);
    await postings.insertMany([{ comment_id: 1, github_review_row_id: github.id, body: 'sent' }]);
    db.prepare('DELETE FROM github_reviews WHERE id = ?').run(github.id);
    expect((await postings.listByComment(1))[0].github_review_row_id).toBeNull();
    db.prepare('DELETE FROM comments WHERE id = 1').run();
    expect(await postings.listByComment(1)).toEqual([]);
  });
});
