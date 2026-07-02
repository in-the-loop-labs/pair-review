// Copyright 2026 Tim Perkins (tjwp) | SPDX-License-Identifier: Apache-2.0
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import express from 'express';
import request from 'supertest';
import { createTestDatabase, closeTestDatabase, seedTestReview } from '../utils/schema.js';
import { listenOnLoopback, closeServer } from '../utils/loopback-server';

// Mock logger so test output stays clean and we can assert on error paths.
vi.mock('../../src/utils/logger', () => ({
  default: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
    success: vi.fn(),
    section: vi.fn()
  },
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
  debug: vi.fn(),
  success: vi.fn(),
  section: vi.fn()
}));

const externalCommentsRoutes = require('../../src/routes/external-comments');
const { ExternalCommentRepository } = require('../../src/database');

/**
 * Build a mappedRow object with sensible defaults for tests.
 * Mirrors the helper in external-comment-repository.test.js so seeding
 * stays familiar.
 */
function makeRow(overrides = {}) {
  return {
    external_id: '1',
    in_reply_to_id: null,
    external_url: 'https://github.com/owner/repo/pull/1#discussion_r1',
    author: 'octocat',
    author_url: 'https://github.com/octocat',
    file: 'src/app.js',
    side: 'RIGHT',
    line_start: 10,
    line_end: 10,
    diff_position: 5,
    commit_sha: 'abc1234',
    is_outdated: false,
    original_line_start: 10,
    original_line_end: 10,
    original_commit_sha: 'abc1234',
    body: 'Looks good!',
    external_created_at: '2026-01-01T00:00:00Z',
    ...overrides
  };
}

/**
 * Build an Express app wired with the external-comments router and the
 * given test database.
 */
function buildApp(db) {
  const app = express();
  app.use(express.json());
  app.set('db', db);
  app.use(externalCommentsRoutes);
  return app;
}

describe('GET /api/reviews/:reviewId/external-comments', () => {
  let db;
  let app;
  let server;
  let repo;
  let reviewId;

  beforeEach(async () => {
    db = createTestDatabase();
    repo = new ExternalCommentRepository(db);
    reviewId = seedTestReview(db);
    app = buildApp(db);
    server = await listenOnLoopback(app);
  });

  afterEach(async () => {
    await closeServer(server);
    closeTestDatabase(db);
  });

  it('returns empty threads array for a review with no external comments', async () => {
    const res = await request(server).get(`/api/reviews/${reviewId}/external-comments`);

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ threads: [] });
  });

  it('returns one thread with empty replies for a single root comment', async () => {
    await repo.upsert(reviewId, 'github', makeRow({
      external_id: 'root-1',
      body: 'standalone comment'
    }));
    await repo.resolveParents(reviewId, 'github');

    const res = await request(server).get(`/api/reviews/${reviewId}/external-comments`);

    expect(res.status).toBe(200);
    expect(res.body.threads).toHaveLength(1);
    expect(res.body.threads[0].external_id).toBe('root-1');
    expect(res.body.threads[0].body).toBe('standalone comment');
    expect(res.body.threads[0].source).toBe('github');
    expect(res.body.threads[0].replies).toEqual([]);
  });

  it('returns a thread with two replies ordered by external_created_at', async () => {
    await repo.upsert(reviewId, 'github', makeRow({
      external_id: 'root',
      external_created_at: '2026-01-01T00:00:00Z'
    }));
    // Insert reply-b first so we can verify ordering comes from created_at, not insert order.
    await repo.upsert(reviewId, 'github', makeRow({
      external_id: 'reply-b',
      in_reply_to_id: 'root',
      external_created_at: '2026-01-03T00:00:00Z',
      body: 'second reply'
    }));
    await repo.upsert(reviewId, 'github', makeRow({
      external_id: 'reply-a',
      in_reply_to_id: 'root',
      external_created_at: '2026-01-02T00:00:00Z',
      body: 'first reply'
    }));
    await repo.resolveParents(reviewId, 'github');

    const res = await request(server).get(`/api/reviews/${reviewId}/external-comments`);

    expect(res.status).toBe(200);
    expect(res.body.threads).toHaveLength(1);
    const thread = res.body.threads[0];
    expect(thread.external_id).toBe('root');
    expect(thread.replies).toHaveLength(2);
    expect(thread.replies[0].external_id).toBe('reply-a');
    expect(thread.replies[1].external_id).toBe('reply-b');
  });

  it('returns threads from multiple files in file/line order', async () => {
    await repo.upsert(reviewId, 'github', makeRow({
      external_id: 'b-5', file: 'b.js', line_end: 5,
      external_created_at: '2026-01-01T00:00:00Z'
    }));
    await repo.upsert(reviewId, 'github', makeRow({
      external_id: 'a-20', file: 'a.js', line_end: 20,
      external_created_at: '2026-01-01T00:00:00Z'
    }));
    await repo.upsert(reviewId, 'github', makeRow({
      external_id: 'a-3', file: 'a.js', line_end: 3,
      external_created_at: '2026-01-01T00:00:00Z'
    }));
    await repo.resolveParents(reviewId, 'github');

    const res = await request(server).get(`/api/reviews/${reviewId}/external-comments`);

    expect(res.status).toBe(200);
    const ids = res.body.threads.map(t => t.external_id);
    expect(ids).toEqual(['a-3', 'a-20', 'b-5']);
  });

  it('filters threads by source when ?source=github is provided', async () => {
    await repo.upsert(reviewId, 'github', makeRow({ external_id: 'gh-1' }));
    await repo.upsert(reviewId, 'github', makeRow({ external_id: 'gh-2', line_end: 20 }));
    await repo.resolveParents(reviewId, 'github');

    // Side-load a gitlab row directly into the table (no adapter registered
    // for gitlab, so repo upsert is fine — adapter validation only runs in
    // the route layer when the *query parameter* is set).
    await repo.upsert(reviewId, 'gitlab', makeRow({ external_id: 'gl-1' }));

    // No filter: all rows present
    const allRes = await request(server).get(`/api/reviews/${reviewId}/external-comments`);
    expect(allRes.status).toBe(200);
    expect(allRes.body.threads).toHaveLength(3);

    // Filtered to github
    const filteredRes = await request(server)
      .get(`/api/reviews/${reviewId}/external-comments`)
      .query({ source: 'github' });
    expect(filteredRes.status).toBe(200);
    expect(filteredRes.body.threads).toHaveLength(2);
    expect(filteredRes.body.threads.every(t => t.source === 'github')).toBe(true);
  });

  it('returns 400 with the source name when an unknown source is requested', async () => {
    const res = await request(server)
      .get(`/api/reviews/${reviewId}/external-comments`)
      .query({ source: 'mystery-tracker' });

    expect(res.status).toBe(400);
    expect(res.body.error).toBe('Unknown external comment source: mystery-tracker');
  });

  it('returns is_outdated and original_* fields for outdated comments', async () => {
    await repo.upsert(reviewId, 'github', makeRow({
      external_id: 'outdated-1',
      is_outdated: true,
      line_start: null,
      line_end: null,
      diff_position: null,
      original_line_start: 42,
      original_line_end: 44,
      original_commit_sha: 'oldsha'
    }));
    await repo.resolveParents(reviewId, 'github');

    const res = await request(server).get(`/api/reviews/${reviewId}/external-comments`);

    expect(res.status).toBe(200);
    expect(res.body.threads).toHaveLength(1);
    const thread = res.body.threads[0];
    expect(thread.is_outdated).toBe(1);
    expect(thread.line_start).toBeNull();
    expect(thread.line_end).toBeNull();
    expect(thread.original_line_start).toBe(42);
    expect(thread.original_line_end).toBe(44);
    expect(thread.original_commit_sha).toBe('oldsha');
  });

  it('returns 404 when the review does not exist', async () => {
    const res = await request(server).get('/api/reviews/999999/external-comments');

    expect(res.status).toBe(404);
    expect(res.body.error).toBe('Review not found');
  });

  it('returns 400 for an invalid (non-numeric) review id', async () => {
    const res = await request(server).get('/api/reviews/not-a-number/external-comments');

    expect(res.status).toBe(400);
    expect(res.body.error).toBe('Invalid review ID');
  });

  it('returns 400 for a zero or negative review id', async () => {
    const res = await request(server).get('/api/reviews/0/external-comments');

    expect(res.status).toBe(400);
    expect(res.body.error).toBe('Invalid review ID');
  });

  it('returns empty threads for a local-mode review even if rows were force-inserted', async () => {
    // Promote the seeded review to local mode.
    db.prepare(
      "UPDATE reviews SET review_type = 'local', local_path = '/tmp/repo', pr_number = NULL WHERE id = ?"
    ).run(reviewId);

    // Force a row in. The route should NOT surface it for a local review.
    await repo.upsert(reviewId, 'github', makeRow({ external_id: 'should-not-show' }));

    const res = await request(server).get(`/api/reviews/${reviewId}/external-comments`);

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ threads: [] });
  });
});
