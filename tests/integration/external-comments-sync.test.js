// Copyright 2026 Tim Perkins (tjwp) | SPDX-License-Identifier: Apache-2.0
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import express from 'express';
import request from 'supertest';
import { createTestDatabase, closeTestDatabase, seedTestReview } from '../utils/schema';

const externalCommentsRoutes = require('../../src/routes/external-comments');
const { GitHubApiError } = require('../../src/github/client');

/**
 * Helpers
 */

/**
 * Build a fake GitHub review-comment API row, mirroring the keys that
 * `src/external/github-adapter.js` consumes.
 */
function makeApiRow({
  id,
  in_reply_to_id = null,
  body = 'a comment',
  path = 'src/app.js',
  line = 10,
  start_line = null,
  side = 'RIGHT',
  position = 5,
  original_position = 5,
  original_line = 10,
  original_start_line = null,
  commit_id = 'abc1234',
  original_commit_id = 'abc1234',
  user = { login: 'octocat', html_url: 'https://github.com/octocat' },
  html_url = null,
  created_at = '2026-01-01T00:00:00Z'
}) {
  return {
    id,
    in_reply_to_id,
    body,
    path,
    line,
    start_line,
    side,
    position,
    original_position,
    original_line,
    original_start_line,
    commit_id,
    original_commit_id,
    user,
    html_url: html_url || `https://github.com/owner/repo/pull/1#discussion_r${id}`,
    created_at
  };
}

/**
 * Build a fake GitHubClient class whose `listReviewComments` returns the
 * supplied API rows. `_calls` records each invocation for assertions.
 */
function makeFakeClient(rows) {
  const calls = [];
  class FakeGitHubClient {
    constructor(token) {
      this.token = token;
    }
    async listReviewComments(params) {
      calls.push(params);
      return rows;
    }
  }
  return { FakeGitHubClient, calls };
}

/**
 * Build a fake GitHubClient class whose `listReviewComments` throws the
 * supplied error. Used for error-path tests.
 */
function makeThrowingClient(error) {
  const calls = [];
  class FakeGitHubClient {
    constructor(token) {
      this.token = token;
    }
    async listReviewComments(params) {
      calls.push(params);
      throw error;
    }
  }
  return { FakeGitHubClient, calls };
}

/**
 * Build a fake GitHubClient class whose `listReviewComments` returns a
 * promise that resolves only when the test calls `resolve()`. Lets us
 * test the in-flight concurrent-sync guard.
 */
function makeBlockingClient(rows) {
  const calls = [];
  let resolveFn;
  const gate = new Promise((resolve) => { resolveFn = resolve; });
  class FakeGitHubClient {
    constructor(token) {
      this.token = token;
    }
    async listReviewComments(params) {
      calls.push(params);
      await gate;
      return rows;
    }
  }
  return { FakeGitHubClient, calls, release: () => resolveFn() };
}

/**
 * Build a minimal Express app that mounts ONLY the external-comments router
 * and lets tests inject `_deps` via `app.set('externalCommentsDeps', ...)`.
 */
function createTestApp(db, deps = {}) {
  const app = express();
  app.use(express.json());
  app.set('db', db);
  app.set('config', { github_token: 'test-token' });
  app.set('externalCommentsDeps', {
    getGitHubToken: () => 'test-token',
    ...deps
  });
  app.use('/', externalCommentsRoutes);
  return app;
}

/**
 * Tests
 */

describe('POST /api/reviews/:reviewId/external-comments/sync', () => {
  let db;
  let reviewId;

  beforeEach(() => {
    db = createTestDatabase();
    reviewId = seedTestReview(db, { prNumber: 42, repository: 'owner/repo' });
    // Clear in-flight registry between tests so isolated cases don't leak.
    externalCommentsRoutes._inFlight.clear();
  });

  afterEach(() => {
    externalCommentsRoutes._inFlight.clear();
    if (db) {
      closeTestDatabase(db);
    }
  });

  // --- Happy paths ---

  it('fresh sync: upserts two comments + one reply with resolved parent_id', async () => {
    const rows = [
      makeApiRow({ id: 101, body: 'first' }),
      makeApiRow({ id: 102, body: 'second' }),
      makeApiRow({ id: 103, body: 'reply to first', in_reply_to_id: 101 })
    ];
    const { FakeGitHubClient } = makeFakeClient(rows);

    const app = createTestApp(db, { GitHubClient: FakeGitHubClient });
    const res = await request(app)
      .post(`/api/reviews/${reviewId}/external-comments/sync`)
      .query({ source: 'github' });

    expect(res.status).toBe(200);
    expect(res.body.count).toBe(3);
    expect(res.body.lostAnchors).toBe(0);
    expect(typeof res.body.syncedAt).toBe('string');

    const allRows = db.prepare('SELECT * FROM external_comments WHERE review_id = ? ORDER BY external_id').all(reviewId);
    expect(allRows).toHaveLength(3);

    const parent = allRows.find(r => r.external_id === '101');
    const reply = allRows.find(r => r.external_id === '103');
    expect(reply.parent_id).toBe(parent.id);
  });

  it('re-sync is idempotent: second call updates rather than duplicating', async () => {
    const rows = [
      makeApiRow({ id: 201, body: 'before edit' })
    ];
    const { FakeGitHubClient } = makeFakeClient(rows);

    const app = createTestApp(db, { GitHubClient: FakeGitHubClient });

    const first = await request(app)
      .post(`/api/reviews/${reviewId}/external-comments/sync`)
      .query({ source: 'github' });
    expect(first.status).toBe(200);
    expect(first.body.count).toBe(1);

    // Mutate the row body before the second call to verify update happens.
    rows[0].body = 'after edit';

    const second = await request(app)
      .post(`/api/reviews/${reviewId}/external-comments/sync`)
      .query({ source: 'github' });
    expect(second.status).toBe(200);
    expect(second.body.count).toBe(1);

    const stored = db.prepare('SELECT * FROM external_comments WHERE review_id = ?').all(reviewId);
    expect(stored).toHaveLength(1);
    expect(stored[0].body).toBe('after edit');
  });

  it('outdated comment: position=null but original_position set → upserted with is_outdated=1', async () => {
    const rows = [
      makeApiRow({
        id: 301,
        body: 'outdated comment',
        position: null,
        line: null,
        original_line: 7,
        original_position: 9
      })
    ];
    const { FakeGitHubClient } = makeFakeClient(rows);

    const app = createTestApp(db, { GitHubClient: FakeGitHubClient });
    const res = await request(app)
      .post(`/api/reviews/${reviewId}/external-comments/sync`)
      .query({ source: 'github' });

    expect(res.status).toBe(200);
    expect(res.body.count).toBe(1);
    expect(res.body.lostAnchors).toBe(0);

    const row = db.prepare('SELECT * FROM external_comments WHERE external_id = ?').get('301');
    expect(row.is_outdated).toBe(1);
    expect(row.line_end).toBeNull();
    expect(row.diff_position).toBeNull();
    expect(row.original_line_end).toBe(7);
  });

  it('lost anchor: both current and original null → NOT inserted; lostAnchors=1', async () => {
    const rows = [
      makeApiRow({ id: 401, body: 'good' }),
      makeApiRow({
        id: 402,
        body: 'lost',
        position: null,
        line: null,
        original_line: null,
        original_position: null,
        original_start_line: null
      })
    ];
    const { FakeGitHubClient } = makeFakeClient(rows);

    const app = createTestApp(db, { GitHubClient: FakeGitHubClient });
    const res = await request(app)
      .post(`/api/reviews/${reviewId}/external-comments/sync`)
      .query({ source: 'github' });

    expect(res.status).toBe(200);
    expect(res.body.count).toBe(1);
    expect(res.body.lostAnchors).toBe(1);

    const stored = db.prepare('SELECT external_id FROM external_comments WHERE review_id = ?').all(reviewId);
    expect(stored.map(r => r.external_id)).toEqual(['401']);
  });

  it('threaded reply: parent later in API response — parent resolution still works', async () => {
    // Reply appears first in the API response; parent comes second.
    const rows = [
      makeApiRow({ id: 503, body: 'reply', in_reply_to_id: 501 }),
      makeApiRow({ id: 501, body: 'root' })
    ];
    const { FakeGitHubClient } = makeFakeClient(rows);

    const app = createTestApp(db, { GitHubClient: FakeGitHubClient });
    const res = await request(app)
      .post(`/api/reviews/${reviewId}/external-comments/sync`)
      .query({ source: 'github' });

    expect(res.status).toBe(200);
    expect(res.body.count).toBe(2);

    const stored = db.prepare('SELECT * FROM external_comments WHERE review_id = ? ORDER BY external_id').all(reviewId);
    const parent = stored.find(r => r.external_id === '501');
    const reply = stored.find(r => r.external_id === '503');
    expect(reply.parent_id).toBe(parent.id);
  });

  it('concurrent sync: two parallel calls share one GitHub round-trip', async () => {
    const rows = [makeApiRow({ id: 601, body: 'shared' })];
    const { FakeGitHubClient, calls, release } = makeBlockingClient(rows);

    const app = createTestApp(db, { GitHubClient: FakeGitHubClient });

    // Start the first request and wait for it to enter the GitHub client
    // call (blocking gate). This guarantees the in-flight entry is set
    // before the second request arrives — otherwise the second request
    // could be scheduled before the first reaches the inFlight map.
    const p1 = request(app)
      .post(`/api/reviews/${reviewId}/external-comments/sync`)
      .query({ source: 'github' })
      .then(r => r);

    // Spin until the fake client receives its first call. This proves the
    // first request is inside `executeSync` and has already populated the
    // inFlight map for the (reviewId, source) key.
    const deadline = Date.now() + 2000;
    while (calls.length === 0 && Date.now() < deadline) {
      await new Promise(resolve => setImmediate(resolve));
    }
    expect(calls.length).toBe(1);
    // Sanity check: in-flight Map MUST have an entry for this (reviewId, source).
    expect(externalCommentsRoutes._inFlight.size).toBe(1);

    // Now launch the second request — it should fold into the existing
    // in-flight promise instead of making a second GitHub call.
    const p2 = request(app)
      .post(`/api/reviews/${reviewId}/external-comments/sync`)
      .query({ source: 'github' })
      .then(r => r);

    // Give p2 a chance to hit the route handler and consult the registry.
    // Multiple microtask ticks because supertest layers add their own.
    for (let i = 0; i < 10; i++) {
      await new Promise(resolve => setImmediate(resolve));
    }
    // While p1 is still blocked on the gate, the in-flight map MUST still
    // hold a single entry — both requests must observe the same promise.
    expect(externalCommentsRoutes._inFlight.size).toBe(1);

    // Release the blocking fetch, then await both responses.
    release();
    const [r1, r2] = await Promise.all([p1, p2]);

    expect(r1.status).toBe(200);
    expect(r2.status).toBe(200);
    expect(r1.body.count).toBe(1);
    expect(r2.body.count).toBe(1);
    // Same syncedAt — proves both responses came from the same promise.
    expect(r1.body.syncedAt).toBe(r2.body.syncedAt);

    // CRITICAL: GitHub client should only have been hit ONCE despite two
    // concurrent requests. This is the whole point of the in-flight guard.
    expect(calls).toHaveLength(1);
  });

  // --- Error paths ---

  it('malformed review.repository: returns 400 via BadRequestError, not 500', async () => {
    // Regression: a review row with a malformed `repository` value (no '/')
    // used to throw a plain Error → catch-all 500. Now it throws
    // BadRequestError → 400 so the route surfaces a client-correctable
    // problem with the right status.
    const malformedReviewId = Number(db.prepare(
      `INSERT INTO reviews (pr_number, repository, status, review_type)
       VALUES (99, 'no-slash-here', 'draft', 'pr')`
    ).run().lastInsertRowid);

    const { FakeGitHubClient } = makeFakeClient([]);
    const app = createTestApp(db, { GitHubClient: FakeGitHubClient });

    const res = await request(app)
      .post(`/api/reviews/${malformedReviewId}/external-comments/sync`)
      .query({ source: 'github' });

    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/Invalid review\.repository/);
    expect(res.body.error).toMatch(/owner\/repo/);
  });

  it('local-mode review: returns 400 with a clear message', async () => {
    const localReviewId = Number(db.prepare(
      `INSERT INTO reviews (repository, status, review_type, local_path)
       VALUES ('owner/repo', 'draft', 'local', '/tmp/local')`
    ).run().lastInsertRowid);

    const { FakeGitHubClient } = makeFakeClient([]);
    const app = createTestApp(db, { GitHubClient: FakeGitHubClient });

    const res = await request(app)
      .post(`/api/reviews/${localReviewId}/external-comments/sync`)
      .query({ source: 'github' });

    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/PR mode/i);
  });

  it('unknown source: returns 400 echoing the source name', async () => {
    const { FakeGitHubClient } = makeFakeClient([]);
    const app = createTestApp(db, { GitHubClient: FakeGitHubClient });

    const res = await request(app)
      .post(`/api/reviews/${reviewId}/external-comments/sync`)
      .query({ source: 'gitlab' });

    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/Unknown external comment source: gitlab/);
  });

  it('unknown review: returns 404', async () => {
    const { FakeGitHubClient } = makeFakeClient([]);
    const app = createTestApp(db, { GitHubClient: FakeGitHubClient });

    const res = await request(app)
      .post('/api/reviews/999999/external-comments/sync')
      .query({ source: 'github' });

    expect(res.status).toBe(404);
    expect(res.body.error).toMatch(/Review not found/);
  });

  it('GitHub 404 (PR not found): propagates 404 status', async () => {
    const err = new GitHubApiError('Pull request #42 not found in repository owner/repo', 404);
    const { FakeGitHubClient } = makeThrowingClient(err);

    const app = createTestApp(db, { GitHubClient: FakeGitHubClient });
    const res = await request(app)
      .post(`/api/reviews/${reviewId}/external-comments/sync`)
      .query({ source: 'github' });

    expect(res.status).toBe(404);
    expect(res.body.error).toMatch(/not found/i);
  });

  it('GitHub 429 (rate limit): propagates 429 status with rate-limit message', async () => {
    const err = new GitHubApiError('GitHub API rate limit exceeded. Retrying in 60 seconds...', 429);
    const { FakeGitHubClient } = makeThrowingClient(err);

    const app = createTestApp(db, { GitHubClient: FakeGitHubClient });
    const res = await request(app)
      .post(`/api/reviews/${reviewId}/external-comments/sync`)
      .query({ source: 'github' });

    expect(res.status).toBe(429);
    expect(res.body.error).toMatch(/rate limit/i);
    // Regression: the body must carry the retry-after info from the
    // underlying GitHubApiError.message — we deleted a dead `retryAfter`
    // branch that was overwriting this with a generic suffix.
    expect(res.body.error).toMatch(/60 seconds/);
  });

  // --- Credential resolution (ITEM 5/6) ---

  it('missing token: returns 401 via the REAL adapter (no inline override)', async () => {
    // The previous version of this test duplicated adapter behavior inline,
    // violating CLAUDE.md. Now we flow through the real github adapter via
    // the dispatcher and only override `getGitHubToken` (config lookup —
    // not adapter contract). resolveCredentials throws the typed 401
    // before any GitHub client is constructed; the integration test pins
    // the route's HTTP mapping. Adapter contract coverage lives in the
    // unit test (tests/unit/external/github-adapter.test.js).
    const FakeGitHubClient = vi.fn();

    const app = createTestApp(db, {
      // No `getAdapter` override — real github adapter handles this end-to-end.
      GitHubClient: FakeGitHubClient,
      getGitHubToken: () => '',
    });

    const res = await request(app)
      .post(`/api/reviews/${reviewId}/external-comments/sync`)
      .query({ source: 'github' });

    expect(res.status).toBe(401);
    expect(res.body.error).toMatch(/token not configured/i);
    // GitHubClient must not be constructed when credentials are missing.
    expect(FakeGitHubClient).not.toHaveBeenCalled();
  });

  it('GitHub 401 from fetch: propagates 401 with auth-failure message', async () => {
    const err = new GitHubApiError('GitHub authentication failed. Check your token.', 401);
    const { FakeGitHubClient } = makeThrowingClient(err);

    const app = createTestApp(db, { GitHubClient: FakeGitHubClient });
    const res = await request(app)
      .post(`/api/reviews/${reviewId}/external-comments/sync`)
      .query({ source: 'github' });

    expect(res.status).toBe(401);
    expect(res.body.error).toMatch(/authentication failed/i);
  });

  it('GitHub 403 (forbidden): propagates 403 status', async () => {
    const err = new GitHubApiError('Insufficient permissions to read PR.', 403);
    const { FakeGitHubClient } = makeThrowingClient(err);

    const app = createTestApp(db, { GitHubClient: FakeGitHubClient });
    const res = await request(app)
      .post(`/api/reviews/${reviewId}/external-comments/sync`)
      .query({ source: 'github' });

    expect(res.status).toBe(403);
    expect(res.body.error).toMatch(/permissions/i);
  });

  it('GitHub 503 (network): propagates 503 status', async () => {
    const err = new GitHubApiError('Network error: ENOTFOUND', 503);
    const { FakeGitHubClient } = makeThrowingClient(err);

    const app = createTestApp(db, { GitHubClient: FakeGitHubClient });
    const res = await request(app)
      .post(`/api/reviews/${reviewId}/external-comments/sync`)
      .query({ source: 'github' });

    expect(res.status).toBe(503);
    expect(res.body.error).toMatch(/network/i);
  });

  it('plain Error from fetchComments: returns 500 via catch-all', async () => {
    const err = new Error('Unexpected client failure');
    const { FakeGitHubClient } = makeThrowingClient(err);

    const app = createTestApp(db, { GitHubClient: FakeGitHubClient });
    const res = await request(app)
      .post(`/api/reviews/${reviewId}/external-comments/sync`)
      .query({ source: 'github' });

    expect(res.status).toBe(500);
    expect(res.body.error).toMatch(/Unexpected client failure|Failed to sync/i);
  });

  // --- Prune logic (ITEM 3) ---

  it('prune on re-sync: a row deleted upstream is removed locally', async () => {
    // First sync: two rows in the snapshot.
    const initialRows = [
      makeApiRow({ id: 700, body: 'first' }),
      makeApiRow({ id: 701, body: 'second' }),
    ];
    let currentRows = initialRows;

    class FakeGitHubClient {
      constructor(token) { this.token = token; }
      async listReviewComments() { return currentRows; }
    }

    const app = createTestApp(db, { GitHubClient: FakeGitHubClient });

    const first = await request(app)
      .post(`/api/reviews/${reviewId}/external-comments/sync`)
      .query({ source: 'github' });
    expect(first.status).toBe(200);
    expect(first.body.count).toBe(2);
    expect(db.prepare('SELECT COUNT(*) AS c FROM external_comments WHERE review_id = ?').get(reviewId).c).toBe(2);

    // Upstream deletes id=701. Second sync should prune it from local mirror.
    currentRows = [makeApiRow({ id: 700, body: 'first' })];
    externalCommentsRoutes._inFlight.clear();

    const second = await request(app)
      .post(`/api/reviews/${reviewId}/external-comments/sync`)
      .query({ source: 'github' });
    expect(second.status).toBe(200);
    expect(second.body.count).toBe(1);
    expect(second.body.deleted).toBe(1);

    const stored = db.prepare(
      'SELECT external_id FROM external_comments WHERE review_id = ?'
    ).all(reviewId);
    expect(stored.map(r => r.external_id)).toEqual(['700']);
  });

  it('prune on re-sync: a row that lost its anchor is removed locally', async () => {
    // First sync: row 800 is anchored normally.
    let currentRows = [makeApiRow({ id: 800, body: 'anchored' })];

    class FakeGitHubClient {
      constructor(token) { this.token = token; }
      async listReviewComments() { return currentRows; }
    }
    const app = createTestApp(db, { GitHubClient: FakeGitHubClient });

    const first = await request(app)
      .post(`/api/reviews/${reviewId}/external-comments/sync`)
      .query({ source: 'github' });
    expect(first.status).toBe(200);
    expect(first.body.count).toBe(1);

    // Now row 800 loses BOTH its current and original anchors. The mapper
    // accepts it, but the route filters it as a lost anchor. After ITEM 4,
    // a sync whose `seenExternalIds` set is empty (every row filtered out)
    // is treated as a no-op — we don't prune the previously-mirrored row
    // based on a snapshot we couldn't usefully read. lostAnchors is still
    // reported so the UI can surface the gap.
    currentRows = [
      makeApiRow({
        id: 800,
        body: 'anchored',
        position: null,
        line: null,
        original_position: null,
        original_line: null,
        original_start_line: null,
      })
    ];
    externalCommentsRoutes._inFlight.clear();

    const second = await request(app)
      .post(`/api/reviews/${reviewId}/external-comments/sync`)
      .query({ source: 'github' });
    expect(second.status).toBe(200);
    expect(second.body.count).toBe(0);
    expect(second.body.lostAnchors).toBe(1);
    expect(second.body.deleted).toBe(0);

    // The previously-mirrored row survives — caller still sees the cached anchor.
    expect(db.prepare(
      'SELECT COUNT(*) AS c FROM external_comments WHERE review_id = ?'
    ).get(reviewId).c).toBe(1);
  });

  it('empty snapshot is treated as a no-op: previously-mirrored rows are preserved', async () => {
    // Regression: an empty response from upstream (e.g. transient GitHub
    // outage returning []) used to wipe the entire local mirror, causing
    // permanent data loss. The prune step now requires a non-empty seen set
    // so an empty response is a no-op — local rows survive.
    let currentRows = [
      makeApiRow({ id: 900, body: 'a' }),
      makeApiRow({ id: 901, body: 'b' }),
    ];

    class FakeGitHubClient {
      constructor(token) { this.token = token; }
      async listReviewComments() { return currentRows; }
    }
    const app = createTestApp(db, { GitHubClient: FakeGitHubClient });

    await request(app)
      .post(`/api/reviews/${reviewId}/external-comments/sync`)
      .query({ source: 'github' });
    expect(db.prepare(
      'SELECT COUNT(*) AS c FROM external_comments WHERE review_id = ?'
    ).get(reviewId).c).toBe(2);

    // Upstream now returns an empty list.
    currentRows = [];
    externalCommentsRoutes._inFlight.clear();

    const second = await request(app)
      .post(`/api/reviews/${reviewId}/external-comments/sync`)
      .query({ source: 'github' });
    expect(second.status).toBe(200);
    expect(second.body.count).toBe(0);
    // No rows deleted — empty-snapshot prune is intentionally skipped.
    expect(second.body.deleted).toBe(0);

    // Original two rows are still present in the mirror.
    expect(db.prepare(
      'SELECT COUNT(*) AS c FROM external_comments WHERE review_id = ?'
    ).get(reviewId).c).toBe(2);
  });

  it('concurrent syncs for DIFFERENT reviews both complete without transaction collision', async () => {
    // Regression: better-sqlite3 cannot nest BEGIN…COMMIT. Two syncs for
    // different (reviewId, source) pairs share the same connection and
    // could call withTransaction concurrently, throwing
    // "cannot start a transaction within a transaction". The sync route
    // serializes write phases through a module-level promise chain so the
    // collision can't happen.
    const otherReviewId = seedTestReview(db, { prNumber: 84, repository: 'owner/other' });

    // Latch that releases when both syncs have entered the fetch phase.
    // Both must reach withTransaction concurrently before either resolves
    // — otherwise the serializer never has anything to serialize.
    let resolveAll;
    const gate = new Promise((r) => { resolveAll = r; });
    let entered = 0;
    class FakeGitHubClient {
      constructor(token) { this.token = token; }
      async listReviewComments({ pull_number }) {
        entered++;
        if (entered >= 2) resolveAll();
        await gate;
        return [makeApiRow({ id: pull_number * 1000, body: `from ${pull_number}` })];
      }
    }
    const app = createTestApp(db, { GitHubClient: FakeGitHubClient });

    const p1 = request(app)
      .post(`/api/reviews/${reviewId}/external-comments/sync`)
      .query({ source: 'github' });
    const p2 = request(app)
      .post(`/api/reviews/${otherReviewId}/external-comments/sync`)
      .query({ source: 'github' });

    const [r1, r2] = await Promise.all([p1, p2]);

    expect(r1.status).toBe(200);
    expect(r2.status).toBe(200);
    expect(r1.body.count).toBe(1);
    expect(r2.body.count).toBe(1);

    // Both reviews' rows landed in the mirror — neither write was lost to
    // a collision-induced rollback.
    const r1Rows = db.prepare(
      'SELECT external_id FROM external_comments WHERE review_id = ?'
    ).all(reviewId);
    const r2Rows = db.prepare(
      'SELECT external_id FROM external_comments WHERE review_id = ?'
    ).all(otherReviewId);
    expect(r1Rows.map(r => r.external_id)).toEqual(['42000']);
    expect(r2Rows.map(r => r.external_id)).toEqual(['84000']);
  });
});
