// Copyright 2026 Tim Perkins (tjwp) | SPDX-License-Identifier: Apache-2.0
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import express from 'express';
import request from 'supertest';
import { createTestDatabase, closeTestDatabase } from '../utils/schema';
import { listenOnLoopback, closeServer } from '../utils/loopback-server';

/**
 * `POST /api/local/:reviewId/sync-drafts` — Phase 4 of
 * plans/bridge-local-and-pr-modes.md.
 *
 * Pulls the pending draft review the user started in the GitHub UI into a
 * LOCAL session's `github_reviews` mirror, when that session's branch has an
 * associated PR.
 *
 * GitHub is reached through `GitHubClient.prototype`, so spying the prototype
 * intercepts every call without a module-level `vi.mock` — the provider
 * captures the class at require time and therefore sees this same prototype.
 * No test here touches the network: `getReviewById` is stubbed alongside
 * `getPendingReviewForUser` because the supersede path calls it too, and an
 * unstubbed call would reach the network and then be hidden by the provider's
 * fail-soft handling.
 */

const localRoutes = require('../../src/routes/local');
const { GitHubClient } = require('../../src/github/client');
const { run, queryOne, query } = require('../../src/database');

const GH_PENDING = {
  id: 'PRR_localnode',
  databaseId: 987654,
  body: 'Draft started on GitHub',
  url: 'https://github.com/owner/repo/pull/77#pullrequestreview-987654',
  state: 'PENDING',
  createdAt: '2026-01-01T00:00:00Z',
  comments: { totalCount: 2 }
};

function createTestApp(db, { token = 'test-token', config } = {}) {
  const app = express();
  app.use(express.json());
  app.set('db', db);
  app.set('githubToken', token);
  app.set('config', config || {
    github_token: token,
    port: 7247,
    theme: 'light',
    model: 'sonnet',
    external_comments: false
  });
  app.use('/', localRoutes);
  return app;
}

/**
 * Insert a LOCAL review row, optionally with a persisted PR association.
 * `pr_number` / `repository` on the row are deliberately NOT the association —
 * the PR natural key stays exclusive to review_type='pr' rows.
 */
async function insertLocal(db, {
  associatedPrNumber = null,
  // Deliberately DIFFERENT from the checkout's own repository below, so a
  // test that asserts which repo GitHub was asked about is discriminating:
  // with both the same, targeting the review's row instead of the
  // association would pass.
  associatedPrRepository = 'owner/repo',
  localRepository = 'owner/checkout',
  localPath = '/checkout/local'
} = {}) {
  const result = await run(db, `
    INSERT INTO reviews (
      repository, status, review_type, local_path, local_head_sha,
      associated_pr_number, associated_pr_repository
    )
    VALUES (?, 'draft', 'local', ?, 'deadbeef', ?, ?)
  `, [localRepository, localPath, associatedPrNumber, associatedPrNumber ? associatedPrRepository : null]);
  return result.lastID;
}

describe('POST /api/local/:reviewId/sync-drafts', () => {
  let db;
  let app;
  let server;
  let savedToken;
  let pendingSpy;
  let reviewByIdSpy;

  beforeEach(async () => {
    db = await createTestDatabase();
    app = createTestApp(db);
    server = await listenOnLoopback(app);
    // `resolveHostBinding` consults process.env.GITHUB_TOKEN first, so an
    // exported token in the developer's shell would change what the
    // "no credential" case resolves. Control it explicitly.
    savedToken = process.env.GITHUB_TOKEN;
    delete process.env.GITHUB_TOKEN;
    // No real network, ever (tests/CONVENTIONS.md).
    pendingSpy = vi.spyOn(GitHubClient.prototype, 'getPendingReviewForUser')
      .mockResolvedValue(null);
    // Reached whenever a draft is superseded (scenario 2) or disappears
    // (scenario 3). Default: the old review was submitted.
    reviewByIdSpy = vi.spyOn(GitHubClient.prototype, 'getReviewById')
      .mockResolvedValue({ state: 'APPROVED', submittedAt: '2026-02-02T00:00:00Z' });
    localRoutes._hostBindingCache.clear();
  });

  afterEach(async () => {
    if (savedToken !== undefined) process.env.GITHUB_TOKEN = savedToken;
    else delete process.env.GITHUB_TOKEN;
    vi.restoreAllMocks();
    localRoutes._hostBindingCache.clear();
    await closeServer(server);
    if (db) await closeTestDatabase(db);
  });

  it('400s on a malformed review id', async () => {
    const response = await request(server).post('/api/local/not-a-number/sync-drafts');
    expect(response.status).toBe(400);
    expect(response.body.error).toContain('Invalid review ID');
  });

  it('404s when the local review does not exist', async () => {
    const response = await request(server).post('/api/local/4242/sync-drafts');
    expect(response.status).toBe(404);
  });

  it('403s when the local review has no associated PR', async () => {
    const reviewId = await insertLocal(db, { associatedPrNumber: null });

    const response = await request(server).post(`/api/local/${reviewId}/sync-drafts`);

    expect(response.status).toBe(403);
    expect(response.body.error).toContain('no associated pull request');
    expect(pendingSpy).not.toHaveBeenCalled();
  });

  it('403s on an association that is not a usable target (non-integer PR number)', async () => {
    // Same predicate `buildCapabilities` uses for hasAssociatedPR, so the gate
    // and the capability the client read can never disagree.
    const reviewId = await insertLocal(db, { associatedPrNumber: null });
    // A genuinely non-numeric value: '77' lands in an INTEGER-affinity column
    // as the integer 77, so the refusal would come from the repository
    // instead and a route that accepted non-integer PR numbers would pass.
    await run(db, `
      UPDATE reviews SET associated_pr_number = 'not-a-number', associated_pr_repository = 'owner/repo'
      WHERE id = ?
    `, [reviewId]);

    const response = await request(server).post(`/api/local/${reviewId}/sync-drafts`);

    expect(response.status).toBe(403);
    expect(pendingSpy).not.toHaveBeenCalled();
  });

  it('401s when no credential resolves for the association repository', async () => {
    app.set('githubToken', '');
    app.set('config', { port: 7247, theme: 'light', model: 'sonnet', external_comments: false });
    const reviewId = await insertLocal(db, { associatedPrNumber: 77 });

    const response = await request(server).post(`/api/local/${reviewId}/sync-drafts`);

    expect(response.status).toBe(401);
    expect(response.body.error).toContain('owner/repo');
    expect(pendingSpy).not.toHaveBeenCalled();
  });

  it('409s on a dual-host repository whose PR host cannot be resolved', async () => {
    // Asking the wrong host for "my pending review on PR #77" answers about a
    // DIFFERENT PR that merely shares a number — refuse before any network.
    app.set('config', {
      github_token: 'test-token',
      port: 7247,
      theme: 'light',
      model: 'sonnet',
      external_comments: false,
      repos: {
        'owner/repo': {
          exclusive: false,
          api_host: 'https://ghe.example/api/v3',
          token: 'ghe-token'
        }
      }
    });
    // No git remote at this path, so the dual repo's host stays a guess.
    const reviewId = await insertLocal(db, {
      associatedPrNumber: 77,
      localPath: '/definitely/not/a/checkout'
    });

    const response = await request(server).post(`/api/local/${reviewId}/sync-drafts`);

    expect(response.status).toBe(409);
    expect(response.body.error).toContain('dual-host');
    expect(pendingSpy).not.toHaveBeenCalled();
  });

  it('409s when the stored host no longer matches config, without touching GitHub', async () => {
    // Explicit-host resolution used to FAIL OPEN: `resolveHostBinding` throws
    // on the mismatch, the local wrapper swallows it and answers `null`, and
    // `resolveFetchCredential(null, globalToken)` read that as "plain
    // github.com" — so the sync targeted api.github.com for a PR the route had
    // just proved lives on a GHE host. A same-named github.com repo answers
    // about a DIFFERENT PR #77, and its drafts get reconciled into these rows.
    app.set('config', {
      github_token: 'test-token',
      port: 7247,
      theme: 'light',
      model: 'sonnet',
      external_comments: false,
      repos: {
        'owner/repo': {
          exclusive: false,
          // The stamp below names the OLD host; config has since been renamed.
          api_host: 'https://new-ghe.example/api/v3',
          token: 'ghe-token'
        }
      }
    });
    await run(db, `
      INSERT INTO pr_metadata (pr_number, repository, title, host)
      VALUES (77, 'owner/repo', 'Stamped', 'https://ghe.example/api/v3')
    `);
    const reviewId = await insertLocal(db, {
      associatedPrNumber: 77,
      localPath: '/definitely/not/a/checkout'
    });

    const response = await request(server).post(`/api/local/${reviewId}/sync-drafts`);

    expect(response.status).toBe(409);
    expect(response.body.error).toContain('no longer matches your configuration');
    expect(pendingSpy).not.toHaveBeenCalled();
    expect(reviewByIdSpy).not.toHaveBeenCalled();
  });

  it('syncs a draft started in the GitHub UI into the local session', async () => {
    pendingSpy.mockResolvedValue(GH_PENDING);
    const reviewId = await insertLocal(db, { associatedPrNumber: 77 });

    const response = await request(server).post(`/api/local/${reviewId}/sync-drafts`);

    expect(response.status).toBe(200);
    // Targets the ASSOCIATION's PR, not the review's own (null) natural key.
    expect(pendingSpy).toHaveBeenCalledWith('owner', 'repo', 77);
    expect(response.body.pendingDraft).toEqual({
      id: expect.any(Number),
      github_review_id: '987654',
      github_node_id: 'PRR_localnode',
      github_url: 'https://github.com/owner/repo/pull/77#pullrequestreview-987654',
      comments_count: 2,
      created_at: expect.any(String)
    });
    expect(response.body.allGithubReviews).toHaveLength(1);

    // The mirror row is attached to the LOCAL review.
    const row = await queryOne(db, 'SELECT * FROM github_reviews WHERE review_id = ?', [reviewId]);
    expect(row.state).toBe('pending');
    expect(row.github_node_id).toBe('PRR_localnode');
  });

  it('is idempotent — a second sync updates the same mirror row', async () => {
    pendingSpy.mockResolvedValue(GH_PENDING);
    const reviewId = await insertLocal(db, { associatedPrNumber: 77 });

    await request(server).post(`/api/local/${reviewId}/sync-drafts`);
    pendingSpy.mockResolvedValue({ ...GH_PENDING, body: 'edited', comments: { totalCount: 5 } });
    const second = await request(server).post(`/api/local/${reviewId}/sync-drafts`);

    expect(second.status).toBe(200);
    expect(second.body.pendingDraft.comments_count).toBe(5);
    const rows = await query(db, 'SELECT * FROM github_reviews WHERE review_id = ?', [reviewId]);
    expect(rows).toHaveLength(1);
    expect(rows[0].body).toBe('edited');
  });

  it('reports pendingDraft null when GitHub has no draft', async () => {
    const reviewId = await insertLocal(db, { associatedPrNumber: 77 });

    const response = await request(server).post(`/api/local/${reviewId}/sync-drafts`);

    expect(response.status).toBe(200);
    expect(response.body.pendingDraft).toBeNull();
    expect(response.body.allGithubReviews).toEqual([]);
    expect(response.body.syncSucceeded).toBe(true);
  });

  it('supersedes an old draft with a new one, leaving exactly one pending row', async () => {
    // The user submitted the draft pair-review knew about and started another
    // in the GitHub UI. Two pending rows for one PR is contradictory state
    // that later submission code reads.
    pendingSpy.mockResolvedValue(GH_PENDING);
    const reviewId = await insertLocal(db, { associatedPrNumber: 77 });
    await run(db, `
      INSERT INTO github_reviews (review_id, github_review_id, github_node_id, state)
      VALUES (?, '111', 'PRR_older', 'pending')
    `, [reviewId]);

    const response = await request(server).post(`/api/local/${reviewId}/sync-drafts`);

    expect(response.status).toBe(200);
    expect(response.body.pendingDraft.github_node_id).toBe('PRR_localnode');
    expect(reviewByIdSpy).toHaveBeenCalledWith('PRR_older', expect.objectContaining({
      owner: 'owner', repo: 'repo', prNumber: 77
    }));

    const rows = await query(db, 'SELECT * FROM github_reviews WHERE review_id = ? ORDER BY id', [reviewId]);
    expect(rows).toHaveLength(2);
    expect(rows.filter(r => r.state === 'pending')).toHaveLength(1);
    const older = rows.find(r => r.github_node_id === 'PRR_older');
    expect(older.state).toBe('submitted');
    expect(older.submitted_at).toBe('2026-02-02T00:00:00Z');
  });

  it('keeps a superseded row pending when GitHub could not say what became of it', async () => {
    // An indeterminate lookup is not evidence of dismissal — writing one
    // would rewrite the user's review history from a rate limit.
    pendingSpy.mockResolvedValue(GH_PENDING);
    reviewByIdSpy.mockRejectedValue(new Error('API rate limit exceeded'));
    const reviewId = await insertLocal(db, { associatedPrNumber: 77 });
    await run(db, `
      INSERT INTO github_reviews (review_id, github_review_id, github_node_id, state)
      VALUES (?, '111', 'PRR_older', 'pending')
    `, [reviewId]);

    const response = await request(server).post(`/api/local/${reviewId}/sync-drafts`);

    expect(response.status).toBe(200);
    const older = await queryOne(db, 'SELECT * FROM github_reviews WHERE github_node_id = ?', ['PRR_older']);
    expect(older.state).toBe('pending');
  });

  it('reconciles rows GitHub no longer reports as a draft at all', async () => {
    // Scenario 3: the draft was submitted or discarded on GitHub with no
    // replacement. Left alone, the row keeps shipping as a live draft.
    reviewByIdSpy.mockResolvedValue({ state: 'DISMISSED' });
    const reviewId = await insertLocal(db, { associatedPrNumber: 77 });
    await run(db, `
      INSERT INTO github_reviews (review_id, github_review_id, github_node_id, state)
      VALUES (?, '111', 'PRR_older', 'pending')
    `, [reviewId]);

    const response = await request(server).post(`/api/local/${reviewId}/sync-drafts`);

    expect(response.status).toBe(200);
    expect(response.body.pendingDraft).toBeNull();
    expect(response.body.allGithubReviews.every(r => r.state !== 'pending')).toBe(true);
  });

  it('creates ONE pending row under concurrent syncs, and the schema enforces it', async () => {
    // Two tabs, or a reload landing on a manual click. `github_reviews` had no
    // uniqueness before migration 57, so two syncs that both read the mirror
    // before either wrote it each inserted a row for the same GitHub draft —
    // and a later sync updated only one, leaving the sibling pending forever.
    //
    // The interleaving itself is pinned where it can be forced deterministically
    // (tests/unit/draft-sync.test.js: the in-flight join and the
    // conflict-adoption path). What this asserts is the end state over the real
    // endpoint plus the durable boundary underneath it.
    pendingSpy.mockResolvedValue(GH_PENDING);
    const reviewId = await insertLocal(db, { associatedPrNumber: 77 });

    const responses = await Promise.all([
      request(server).post(`/api/local/${reviewId}/sync-drafts`),
      request(server).post(`/api/local/${reviewId}/sync-drafts`),
      request(server).post(`/api/local/${reviewId}/sync-drafts`)
    ]);

    expect(responses.map(r => r.status)).toEqual([200, 200, 200]);
    const rows = await query(db, 'SELECT * FROM github_reviews WHERE review_id = ?', [reviewId]);
    expect(rows).toHaveLength(1);

    // No writer, however it got here, can add a second row for this draft.
    await expect(run(db, `
      INSERT INTO github_reviews (review_id, github_review_id, github_node_id, state)
      VALUES (?, '987654', 'PRR_localnode', 'pending')
    `, [reviewId])).rejects.toThrow(/UNIQUE constraint failed/);
  });

  it('syncs a dual-host repo whose PR host is already stamped in pr_metadata', async () => {
    // A stored host is authoritative evidence — the same tier-1 short-circuit
    // the external-comment sync applies. Refusing here left a permanently
    // visible button that 409'd on every click with the correct host sitting
    // in the database.
    app.set('config', {
      github_token: 'test-token',
      port: 7247,
      theme: 'light',
      model: 'sonnet',
      external_comments: false,
      repos: {
        'owner/repo': {
          exclusive: false,
          api_host: 'https://ghe.example/api/v3',
          token: 'ghe-token'
        }
      }
    });
    await run(db, `
      INSERT INTO pr_metadata (pr_number, repository, title, host)
      VALUES (77, 'owner/repo', 'Stamped', 'https://ghe.example/api/v3')
    `);
    pendingSpy.mockResolvedValue(GH_PENDING);
    const reviewId = await insertLocal(db, {
      associatedPrNumber: 77,
      localPath: '/definitely/not/a/checkout'
    });

    const response = await request(server).post(`/api/local/${reviewId}/sync-drafts`);

    expect(response.status).toBe(200);
    // …and asked the host the stamp names, not the guessed one.
    expect(pendingSpy.mock.instances[0].apiHost).toBe('https://ghe.example/api/v3');
  });

  it('still 200s with the local mirror when the GitHub call fails', async () => {
    // Draft state is supplementary: an outage must not fail the request.
    pendingSpy.mockRejectedValue(new Error('API rate limit exceeded'));
    const reviewId = await insertLocal(db, { associatedPrNumber: 77 });
    await run(db, `
      INSERT INTO github_reviews (review_id, github_review_id, state)
      VALUES (?, '1', 'submitted')
    `, [reviewId]);

    const response = await request(server).post(`/api/local/${reviewId}/sync-drafts`);

    expect(response.status).toBe(200);
    expect(response.body.pendingDraft).toBeNull();
    expect(response.body.allGithubReviews).toHaveLength(1);
    // The flag is how the client tells "no draft" from "could not ask" — the
    // difference between leaving a live indicator alone and wiping it.
    expect(response.body.syncSucceeded).toBe(false);
    // …and nothing was reconciled on the back of a failed fetch.
    const row = await queryOne(db, 'SELECT * FROM github_reviews WHERE review_id = ?', [reviewId]);
    expect(row.state).toBe('submitted');
    expect(reviewByIdSpy).not.toHaveBeenCalled();
  });
});
