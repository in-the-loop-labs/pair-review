// Copyright 2026 Tim Perkins (tjwp) | SPDX-License-Identifier: Apache-2.0
import { describe, it, expect, vi } from 'vitest';

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
const { syncPendingDraftFromGitHub } = prRoute._internals;

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
});
