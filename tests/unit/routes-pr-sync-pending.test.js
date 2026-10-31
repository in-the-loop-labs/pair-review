// Copyright 2026 Tim Perkins (tjwp) | SPDX-License-Identifier: Apache-2.0
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { createTestDatabase, closeTestDatabase, seedTestReview } from '../utils/schema';
import request from 'supertest';
const express = require('express');
const { listenOnLoopback, closeServer } = require('../utils/loopback-server');
const { GitHubClient } = require('../../src/github/client');

/**
 * Regression tests for `syncPendingDraftFromGitHub` in
 * src/routes/pr.js (Fix #10).
 *
 * Prior to Fix #10, the matching loop compared the GitHub pending
 * review only by `github_node_id`. On alt-hosts that do not surface a
 * node id consistently, the only identifier we have for an existing
 * record is the numeric `github_review_id` (as string). Without
 * matching on it, every refresh would create a new local pending
 * record instead of updating the existing one.
 */

const prRoute = require('../../src/routes/pr');
const { syncPendingDraftFromGitHub, reconcileStalePendingRecords } = prRoute._internals;
const { GitHubReviewRepository } = require('../../src/database');
const ws = require('../../src/ws');

/**
 * Build a minimal mock of the GitHubReviewRepository surface that
 * `syncPendingDraftFromGitHub` touches.
 */
function makeRepo(initialRecords = []) {
  const updates = [];
  const creates = [];
  const records = new Map();
  initialRecords.forEach((r, i) => {
    const id = r.id ?? (i + 1);
    records.set(id, { ...r, id });
  });
  return {
    db: { exec: vi.fn() },
    findPendingByReviewId: vi.fn(async () => Array.from(records.values())),
    update: vi.fn(async (id, data) => {
      updates.push({ id, data });
      const existing = records.get(id);
      if (existing) records.set(id, { ...existing, ...data });
    }),
    create: vi.fn(async (reviewId, data) => {
      const id = records.size + 100;
      const rec = { id, ...data };
      records.set(id, rec);
      creates.push({ reviewId, data, id });
      return rec;
    }),
    getById: vi.fn(async (id) => records.get(id) || null),
    _state: { updates, creates, records }
  };
}

describe('syncPendingDraftFromGitHub (Fix #10)', () => {
  it('matches an existing local record by numeric github_review_id when github_node_id is absent', async () => {
    // Existing local record from a REST-mode draft creation that
    // happened to be stored without a node id.
    const repo = makeRepo([
      { id: 7, github_node_id: null, github_review_id: '123', state: 'pending', body: 'old' }
    ]);

    // GitHub returns the same draft, identified by both node id and
    // numeric id. The numeric id matches our record.
    const ghPending = {
      id: 'PRR_xyz',
      databaseId: 123,
      url: 'https://althost.example/o/r/pull/1#pullrequestreview-123',
      body: 'updated',
      comments: { totalCount: 0 }
    };

    const result = await syncPendingDraftFromGitHub(repo, 99, ghPending);

    // Must have matched on numeric id and called UPDATE, not CREATE.
    expect(repo.update).toHaveBeenCalledTimes(1);
    expect(repo.update.mock.calls[0][0]).toBe(7);
    expect(repo.create).not.toHaveBeenCalled();
    expect(result.body).toBe('updated');
  });

  it('still matches by node_id (legacy behaviour preserved)', async () => {
    const repo = makeRepo([
      { id: 7, github_node_id: 'PRR_xyz', github_review_id: '123', state: 'pending', body: 'old' }
    ]);
    const ghPending = {
      id: 'PRR_xyz',
      databaseId: 123,
      url: 'u',
      body: 'updated',
      comments: { totalCount: 1 }
    };
    await syncPendingDraftFromGitHub(repo, 99, ghPending);
    expect(repo.update).toHaveBeenCalledTimes(1);
    expect(repo.create).not.toHaveBeenCalled();
  });

  it('reconciles an older draft even when the current draft matches a local record', async () => {
    const repo = makeRepo([
      { id: 1, review_id: 99, github_node_id: 'PRR_old', github_review_id: '111', state: 'pending' },
      { id: 2, review_id: 99, github_node_id: 'PRR_current', github_review_id: '222', state: 'pending' },
      { id: 3, review_id: 99, github_node_id: 'PRR_current', github_review_id: '222', state: 'pending' }
    ]);
    const client = { getReviewById: vi.fn().mockResolvedValue({ state: 'COMMENTED', submittedAt: '2026-01-01' }) };
    const broadcast = vi.spyOn(ws, 'broadcast').mockImplementation(() => {});
    try {
      const result = await syncPendingDraftFromGitHub(repo, 99, {
        id: 'PRR_current', databaseId: 222, url: 'u', body: 'current', comments: { totalCount: 2 }
      }, client, { owner: 'o', repo: 'r', prNumber: 1 });
      expect(result.state).toBe('pending');
      expect(repo._state.records.get(1).state).toBe('submitted');
      expect(repo._state.records.get(2).state).toBe('pending');
      expect(repo._state.records.get(3).state).toBe('pending');
      expect(client.getReviewById).toHaveBeenCalledTimes(1);
      expect(client.getReviewById.mock.calls[0][0]).toBe('PRR_old');
      expect(broadcast).toHaveBeenCalledTimes(1);
    } finally { broadcast.mockRestore(); }
  });

  it('creates a new record when neither node id nor numeric id matches', async () => {
    const repo = makeRepo([
      { id: 1, github_node_id: 'PRR_old', github_review_id: '111', state: 'pending', body: '' }
    ]);
    const ghPending = {
      id: 'PRR_brand_new',
      databaseId: 999,
      url: 'u',
      body: 'fresh',
      comments: { totalCount: 0 }
    };
    await syncPendingDraftFromGitHub(repo, 99, ghPending);
    expect(repo.create).toHaveBeenCalledTimes(1);
    // The old record's state was updated to dismissed by the loop.
    expect(repo.update).toHaveBeenCalled();
  });

  it('passes either node id OR numeric id to githubClient.getReviewById when reconciling old records (Fix #10)', async () => {
    // Old record has ONLY a numeric id (REST mode, no node_id).
    const repo = makeRepo([
      { id: 1, github_node_id: null, github_review_id: '777', state: 'pending', body: '' }
    ]);
    const githubClient = {
      getReviewById: vi.fn(async (id) => ({ state: 'COMMENTED', submittedAt: '2026-05-19T00:00:00Z' }))
    };
    const ghPending = {
      id: 'PRR_brand_new',
      databaseId: 999,
      url: 'u',
      body: 'fresh',
      comments: { totalCount: 0 }
    };
    await syncPendingDraftFromGitHub(repo, 99, ghPending, githubClient, { owner: 'o', repo: 'r', prNumber: 1 });
    // The lookup id passed in must be the numeric id (since node_id is
    // null), and prContext.reviewId must also be threaded.
    expect(githubClient.getReviewById).toHaveBeenCalled();
    const [lookupId, prCtx] = githubClient.getReviewById.mock.calls[0];
    expect(lookupId).toBe('777');
    expect(prCtx).toMatchObject({ owner: 'o', repo: 'r', prNumber: 1, reviewId: '777' });
  });

  it('preserves the new-draft branch fallback on lookup errors', async () => {
    const repo = makeRepo([{ id: 1, github_node_id: 'PRR_old', state: 'pending' }]);
    await syncPendingDraftFromGitHub(repo, 99, { id: 'PRR_new', databaseId: 999 }, {
      getReviewById: vi.fn().mockRejectedValue(new Error('offline'))
    });
    expect(repo._state.records.get(1).state).toBe('dismissed');
    expect(repo.create).toHaveBeenCalledOnce();
  });
});

describe('reconcileStalePendingRecords (no pending draft on GitHub)', () => {
  let db, repo, broadcast;
  const context = { owner: 'test', repo: 'repo', prNumber: 1 };
  beforeEach(() => {
    db = createTestDatabase();
    seedTestReview(db, { id: 1 });
    repo = new GitHubReviewRepository(db);
    broadcast = vi.spyOn(ws, 'broadcast').mockImplementation(() => {});
  });
  afterEach(() => {
    vi.restoreAllMocks();
    closeTestDatabase(db);
  });

  async function addDraft(commentId = 1) {
    const row = await repo.create(1, { github_review_id: '123', github_node_id: 'PRR_123', state: 'pending' });
    db.prepare('INSERT INTO comments (id, review_id, source, status, body) VALUES (?, 1, ?, ?, ?)')
      .run(commentId, 'user', 'active', 'snapshot');
    db.prepare('INSERT INTO comment_postings (comment_id, github_review_row_id, body) VALUES (?, ?, ?)')
      .run(commentId, row.id, 'snapshot');
    return row;
  }
  function linkedReviewStates() {
    return db.prepare(`SELECT gr.state
      FROM comment_postings cp JOIN github_reviews gr ON gr.id = cp.github_review_row_id ORDER BY cp.id`).all()
      .map(row => row.state);
  }
  async function reconcile(client) {
    return reconcileStalePendingRecords(repo, await repo.findPendingByReviewId(1), client, context);
  }

  it.each(['COMMENTED', 'not-found', 'error'])('wires a null draft through GET github-drafts (%s)', async outcome => {
    await addDraft();
    vi.spyOn(GitHubClient.prototype, 'getPendingReviewForUser').mockResolvedValue(null);
    const lookup = vi.spyOn(GitHubClient.prototype, 'getReviewById');
    if (outcome === 'error') lookup.mockRejectedValue(new Error('transient'));
    else lookup.mockResolvedValue(outcome === 'not-found' ? null : { state: outcome });
    const app = express();
    app.set('db', db);
    app.set('config', { github_token: 'test-token' });
    app.use(prRoute);
    const server = await listenOnLoopback(app);
    try {
      const response = await request(server).get('/api/pr/test/repo/1/github-drafts').expect(200);
      expect(response.body.pendingDraft).toBeNull();
      expect(response.body.allGithubReviews[0].state).toBe(
        outcome === 'error' ? 'pending' : outcome === 'not-found' ? 'dismissed' : 'submitted');
      expect(lookup).toHaveBeenCalledWith('PRR_123', { ...context, reviewId: '123' }, { strict: true });
      expect(broadcast).toHaveBeenCalledTimes(outcome === 'error' ? 0 : 1);
    } finally {
      await closeServer(server);
    }
  });

  it('updates submitted drafts, keeps postings, and broadcasts to all tabs after COMMIT', async () => {
    await addDraft();
    expect(linkedReviewStates()).toEqual(['pending']);
    const submittedAt = '2026-10-30T00:00:00Z';
    const client = { getReviewById: vi.fn(async () => {
      expect(db.inTransaction).toBe(false);
      return { state: 'COMMENTED', submittedAt };
    }) };
    broadcast.mockImplementation(() => {
      expect(db.inTransaction).toBe(false);
      expect(linkedReviewStates()).toEqual(['submitted']);
    });
    expect(await reconcile(client)).toBe(true);
    expect(client.getReviewById).toHaveBeenCalledWith('PRR_123', { ...context, reviewId: '123' }, { strict: true });
    expect((await repo.findByReviewId(1))[0]).toMatchObject({ state: 'submitted', submitted_at: submittedAt });
    expect(broadcast).toHaveBeenCalledExactlyOnceWith('review:1', { type: 'review:comments_changed', reviewId: 1 });
    expect(await reconcile(client)).toBe(false);
    expect(broadcast).toHaveBeenCalledTimes(1);
  });

  it('leaves drafts pending and does not broadcast on transient lookup errors', async () => {
    await addDraft();
    expect(await reconcile({ getReviewById: vi.fn().mockRejectedValue(new Error('offline')) })).toBe(false);
    expect(linkedReviewStates()).toEqual(['pending']);
    expect(broadcast).not.toHaveBeenCalled();
  });

  it('treats a confirmed missing draft as dismissed without requeuing its comments', async () => {
    await addDraft();
    await reconcile({ getReviewById: vi.fn().mockResolvedValue(null) });
    expect((await repo.findByReviewId(1))[0].state).toBe('dismissed');
    expect(linkedReviewStates()).toEqual(['dismissed']);
    expect(broadcast).toHaveBeenCalledOnce();
  });

  it('updates every legacy duplicate so every linked posting becomes posted', async () => {
    await addDraft(1);
    await addDraft(2);
    const client = { getReviewById: vi.fn().mockResolvedValue({ state: 'COMMENTED' }) };
    await reconcile(client);
    expect((await repo.findByReviewId(1)).map(row => row.state)).toEqual(['submitted', 'submitted']);
    expect(linkedReviewStates()).toEqual(['submitted', 'submitted']);
    expect(client.getReviewById).toHaveBeenCalledOnce();
    expect(broadcast).toHaveBeenCalledOnce();
  });

  it('does not broadcast or change a review still pending remotely', async () => {
    await addDraft();
    expect(await reconcile({ getReviewById: vi.fn().mockResolvedValue({ state: 'PENDING' }) })).toBe(false);
    expect(linkedReviewStates()).toEqual(['pending']);
    expect(broadcast).not.toHaveBeenCalled();
  });

  it('does not overwrite a submit that completed during the network lookup', async () => {
    const row = await addDraft();
    await reconcile({ getReviewById: vi.fn(async () => {
      await repo.update(row.id, { state: 'submitted' });
      return null;
    }) });
    expect((await repo.getById(row.id)).state).toBe('submitted');
    expect(broadcast).not.toHaveBeenCalled();
  });

  it('rolls back and sends no broadcast if an update fails', async () => {
    await addDraft(1);
    await addDraft(2);
    const original = repo.update.bind(repo);
    vi.spyOn(repo, 'update').mockImplementationOnce(original).mockRejectedValueOnce(new Error('write failed'));
    await expect(reconcile({ getReviewById: vi.fn().mockResolvedValue({ state: 'COMMENTED' }) }))
      .rejects.toThrow('write failed');
    expect(linkedReviewStates()).toEqual(['pending', 'pending']);
    expect(broadcast).not.toHaveBeenCalled();
    expect(db.inTransaction).toBe(false);
  });
});
