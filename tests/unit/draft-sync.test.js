// Copyright 2026 Tim Perkins (tjwp) | SPDX-License-Identifier: Apache-2.0
import { describe, it, expect, vi } from 'vitest';

/**
 * Unit tests for `src/providers/draft-sync.js` — the pending-draft
 * reconciliation shared by PR mode's `github-drafts` GET and local mode's
 * `sync-drafts` POST (Phase 4 of plans/bridge-local-and-pr-modes.md).
 *
 * `syncPendingDraftFromGitHub` itself keeps its own regression suite in
 * tests/unit/routes-pr-sync-pending.test.js (it is still reachable through
 * `routes/pr.js`'s `_internals`, which is where it lived before extraction).
 * What is new here is the whole-flow wrapper and its deliberately asymmetric
 * error contract.
 */

const {
  syncPendingDraft,
  serializePendingDraft
} = require('../../src/providers/draft-sync');

/**
 * In-memory stand-in for GitHubReviewRepository, one review's rows.
 *
 * `enforceUnique` mirrors the partial unique indexes migration 57 adds, so a
 * test can exercise the conflict-adoption path the real database drives.
 */
function makeRepo(rows = [], { enforceUnique = false } = {}) {
  const state = { rows: rows.map(r => ({ ...r })), nextId: 100 };
  class FakeRepo {
    constructor() { this.state = state; }
    async findPendingByReviewId(reviewId) {
      return state.rows.filter(r => r.review_id === reviewId && r.state === 'pending');
    }
    async findByReviewId(reviewId) {
      return state.rows.filter(r => r.review_id === reviewId);
    }
    async getById(id) {
      return state.rows.find(r => r.id === id) || null;
    }
    async findByGitHubNodeId(reviewId, nodeId) {
      return state.rows.find(r => r.review_id === reviewId && r.github_node_id === nodeId) || null;
    }
    async findByGitHubReviewId(reviewId, githubReviewId) {
      return state.rows.find(r => r.review_id === reviewId && r.github_review_id === githubReviewId) || null;
    }
    async update(id, data) {
      const row = state.rows.find(r => r.id === id);
      if (row) Object.assign(row, data);
      return true;
    }
    async upsertFromGitHub(reviewId, data) {
      // Mirrors src/database.js — the real semantics are pinned against a real
      // SQLite database (with migration 57's indexes) in
      // tests/integration/database.test.js.
      const existing = (data.github_node_id ? await this.findByGitHubNodeId(reviewId, data.github_node_id) : null)
        || (data.github_review_id ? await this.findByGitHubReviewId(reviewId, data.github_review_id) : null);
      if (existing) {
        await this.update(existing.id, data);
        return this.getById(existing.id);
      }
      return this.create(reviewId, data);
    }
    async create(reviewId, data) {
      if (enforceUnique && state.rows.some(r =>
        r.review_id === reviewId
        && ((data.github_node_id && r.github_node_id === data.github_node_id)
          || (data.github_review_id && r.github_review_id === data.github_review_id)))) {
        const err = new Error('UNIQUE constraint failed: github_reviews.review_id, github_reviews.github_node_id');
        err.code = 'SQLITE_CONSTRAINT_UNIQUE';
        throw err;
      }
      const row = { id: state.nextId++, review_id: reviewId, created_at: '2026-01-01T00:00:00Z', ...data };
      state.rows.push(row);
      return row;
    }
  }
  return { FakeRepo, state };
}

const GH_PENDING = {
  id: 'PRR_node1',
  databaseId: 555,
  body: 'draft body',
  url: 'https://github.com/o/r/pull/9#pullrequestreview-555',
  state: 'PENDING',
  comments: { totalCount: 4 }
};

function makeLogger() {
  return { warn: vi.fn(), debug: vi.fn(), log: vi.fn(), error: vi.fn() };
}

describe('syncPendingDraft', () => {
  it('creates a mirror row for a draft started in the GitHub UI and reports it', async () => {
    const { FakeRepo, state } = makeRepo();
    const getPendingReviewForUser = vi.fn().mockResolvedValue(GH_PENDING);
    class FakeClient {
      constructor(credential) { this.credential = credential; }
      getPendingReviewForUser(...args) { return getPendingReviewForUser(...args); }
    }

    const result = await syncPendingDraft({
      db: {},
      reviewId: 42,
      owner: 'o',
      repo: 'r',
      prNumber: 9,
      credential: 'tok',
      _deps: { GitHubClient: FakeClient, GitHubReviewRepository: FakeRepo, logger: makeLogger() }
    });

    expect(getPendingReviewForUser).toHaveBeenCalledWith('o', 'r', 9);
    expect(result.pendingDraft.github_node_id).toBe('PRR_node1');
    expect(result.pendingDraft.github_review_id).toBe('555');
    expect(result.pendingDraft.comments_count).toBe(4);
    // The mirror row is what a later page load reads back.
    expect(state.rows).toHaveLength(1);
    expect(result.allGithubReviews).toHaveLength(1);
  });

  it('reports pendingDraft null (and the existing mirror) when GitHub has no draft', async () => {
    const { FakeRepo } = makeRepo([
      { id: 1, review_id: 42, state: 'submitted', github_review_id: '1' }
    ]);
    class FakeClient {
      async getPendingReviewForUser() { return null; }
    }

    const result = await syncPendingDraft({
      db: {},
      reviewId: 42,
      owner: 'o',
      repo: 'r',
      prNumber: 9,
      credential: 'tok',
      _deps: { GitHubClient: FakeClient, GitHubReviewRepository: FakeRepo, logger: makeLogger() }
    });

    expect(result.pendingDraft).toBeNull();
    expect(result.allGithubReviews).toHaveLength(1);
  });

  it('swallows a GitHub failure and still returns the local mirror', async () => {
    // Draft state is supplementary — a rate limit must not take down the page
    // that asked. This is the behaviour both PR-mode call sites had before
    // the extraction, so the regression it guards is a real one.
    const { FakeRepo } = makeRepo([
      { id: 1, review_id: 42, state: 'pending', github_review_id: '7' }
    ]);
    const logger = makeLogger();
    class FakeClient {
      async getPendingReviewForUser() { throw new Error('API rate limit exceeded'); }
    }

    const result = await syncPendingDraft({
      db: {},
      reviewId: 42,
      owner: 'o',
      repo: 'r',
      prNumber: 9,
      credential: 'tok',
      _deps: { GitHubClient: FakeClient, GitHubReviewRepository: FakeRepo, logger }
    });

    expect(result.pendingDraft).toBeNull();
    expect(result.allGithubReviews).toHaveLength(1);
    expect(logger.warn).toHaveBeenCalled();
    // The flag is what stops the client clearing a live indicator on an
    // outage: `pendingDraft: null` alone cannot tell the two cases apart.
    expect(result.syncSucceeded).toBe(false);
  });

  it('reports syncSucceeded on an answer GitHub actually gave', async () => {
    const { FakeRepo } = makeRepo();
    class FakeClient {
      async getPendingReviewForUser() { return null; }
    }

    const result = await syncPendingDraft({
      db: {}, reviewId: 42, owner: 'o', repo: 'r', prNumber: 9, credential: 'tok',
      _deps: { GitHubClient: FakeClient, GitHubReviewRepository: FakeRepo, logger: makeLogger() }
    });

    expect(result.syncSucceeded).toBe(true);
  });

  it('leaves pending rows alone when the fetch failed (never mass-dismisses)', async () => {
    // Reconciling on the swallowed-error path is how a rate limit would
    // dismiss every live draft in the mirror.
    const { FakeRepo, state } = makeRepo([
      { id: 1, review_id: 42, state: 'pending', github_node_id: 'PRR_old' }
    ]);
    const getReviewById = vi.fn();
    class FakeClient {
      async getPendingReviewForUser() { throw new Error('API rate limit exceeded'); }
      getReviewById(...args) { return getReviewById(...args); }
    }

    await syncPendingDraft({
      db: {}, reviewId: 42, owner: 'o', repo: 'r', prNumber: 9, credential: 'tok',
      _deps: { GitHubClient: FakeClient, GitHubReviewRepository: FakeRepo, logger: makeLogger() }
    });

    expect(getReviewById).not.toHaveBeenCalled();
    expect(state.rows[0].state).toBe('pending');
  });

  it('lets a DATABASE failure through instead of reporting it as a GitHub outage', async () => {
    // Persistence failures used to be swallowed by the same catch that covers
    // the GitHub round-trip, and answered 200 with "no draft".
    const { FakeRepo } = makeRepo();
    class BrokenRepo extends FakeRepo {
      async findByReviewId() { throw new Error('database is locked'); }
    }
    class FakeClient {
      async getPendingReviewForUser() { return null; }
    }

    await expect(syncPendingDraft({
      db: {}, reviewId: 42, owner: 'o', repo: 'r', prNumber: 9, credential: 'tok',
      _deps: { GitHubClient: FakeClient, GitHubReviewRepository: BrokenRepo, logger: makeLogger() }
    })).rejects.toThrow('database is locked');
  });

  it('joins a concurrent sync for the same review instead of racing it', async () => {
    // Two tabs, or a reload landing on a manual click: both used to insert a
    // row for the same GitHub draft, leaving a sibling pending forever.
    const { FakeRepo, state } = makeRepo([], { enforceUnique: true });
    const db = {};
    let release;
    const getPendingReviewForUser = vi.fn(() => new Promise((resolve) => {
      release = () => resolve(GH_PENDING);
    }));
    class FakeClient {
      getPendingReviewForUser(...args) { return getPendingReviewForUser(...args); }
    }
    const call = () => syncPendingDraft({
      db, reviewId: 42, owner: 'o', repo: 'r', prNumber: 9, credential: 'tok',
      _deps: { GitHubClient: FakeClient, GitHubReviewRepository: FakeRepo, logger: makeLogger() }
    });

    const first = call();
    const second = call();
    release();
    const [a, b] = await Promise.all([first, second]);

    expect(getPendingReviewForUser).toHaveBeenCalledTimes(1);
    expect(a.pendingDraft.id).toBe(b.pendingDraft.id);
    expect(state.rows).toHaveLength(1);
  });

  it('releases the join so a later sync still runs', async () => {
    const { FakeRepo } = makeRepo();
    const db = {};
    const getPendingReviewForUser = vi.fn().mockResolvedValue(null);
    class FakeClient {
      getPendingReviewForUser(...args) { return getPendingReviewForUser(...args); }
    }
    const call = () => syncPendingDraft({
      db, reviewId: 42, owner: 'o', repo: 'r', prNumber: 9, credential: 'tok',
      _deps: { GitHubClient: FakeClient, GitHubReviewRepository: FakeRepo, logger: makeLogger() }
    });

    await call();
    await call();

    expect(getPendingReviewForUser).toHaveBeenCalledTimes(2);
  });

  it('writes through the repository upsert so a concurrent insert is adopted', async () => {
    // The durable half of the guarantee lives in `upsertFromGitHub`: migration
    // 57's unique indexes reject a second row for one draft, and the loser
    // resolves the conflict into an update. What matters HERE is that the
    // provider goes through that writer rather than a bare insert — the same
    // writer the submit path uses, so a draft that is later submitted updates
    // this row instead of doubling up.
    const { FakeRepo, state } = makeRepo([], { enforceUnique: true });
    state.rows.push({
      id: 7, review_id: 42, state: 'pending', github_node_id: 'PRR_node1',
      github_review_id: '555', body: 'from the other tab', created_at: '2026-01-01T00:00:00Z'
    });
    class FakeRepoRacing extends FakeRepo {
      // The stale read that starts the race: "nothing pending here", while the
      // row the other writer inserted is already in the table.
      async findPendingByReviewId() { return []; }
    }
    class FakeClient {
      async getPendingReviewForUser() { return GH_PENDING; }
    }

    const result = await syncPendingDraft({
      db: {}, reviewId: 42, owner: 'o', repo: 'r', prNumber: 9, credential: 'tok',
      _deps: { GitHubClient: FakeClient, GitHubReviewRepository: FakeRepoRacing, logger: makeLogger() }
    });

    expect(state.rows).toHaveLength(1);
    expect(result.pendingDraft.id).toBe(7);
    expect(result.pendingDraft.body).toBe('draft body');
    expect(result.pendingDraft.comments_count).toBe(4);
  });

  it('propagates a client-construction failure — an unusable credential is a caller bug', async () => {
    const { FakeRepo } = makeRepo();
    class FakeClient {
      constructor() { throw new Error('GitHub token is required'); }
    }

    await expect(syncPendingDraft({
      db: {},
      reviewId: 42,
      owner: 'o',
      repo: 'r',
      prNumber: 9,
      credential: null,
      _deps: { GitHubClient: FakeClient, GitHubReviewRepository: FakeRepo, logger: makeLogger() }
    })).rejects.toThrow('GitHub token is required');
  });

  it('passes the resolved credential straight to the client (never re-resolves config)', async () => {
    const { FakeRepo } = makeRepo();
    const binding = { apiHost: 'https://ghe.example/api/v3', host: 'https://ghe.example/api/v3', token: 'ghe-tok' };
    const seen = [];
    class FakeClient {
      constructor(credential) { seen.push(credential); }
      async getPendingReviewForUser() { return null; }
    }

    await syncPendingDraft({
      db: {},
      reviewId: 1,
      owner: 'o',
      repo: 'r',
      prNumber: 3,
      credential: binding,
      _deps: { GitHubClient: FakeClient, GitHubReviewRepository: FakeRepo, logger: makeLogger() }
    });

    expect(seen).toEqual([binding]);
  });
});

/**
 * What became of the rows we still hold as 'pending' once GitHub stops
 * reporting them as the current draft. Two paths reach this — a NEW draft
 * appearing, and GitHub reporting no draft at all — and they now run the same
 * reconciliation, so the cases below are asserted through both.
 */
describe('reconciling superseded pending rows', () => {
  const OLD_ROW = { id: 1, review_id: 42, state: 'pending', github_node_id: 'PRR_old', github_review_id: '111' };

  /**
   * @param {Object} lookup - `{ resolves }` or `{ rejects }` for getReviewById
   * @param {Object|null} draft - what GitHub reports as the current draft
   */
  async function run(lookup, draft, { logger = makeLogger() } = {}) {
    const { FakeRepo, state } = makeRepo([{ ...OLD_ROW }]);
    const getReviewById = vi.fn(() => (
      lookup.rejects ? Promise.reject(lookup.rejects) : Promise.resolve(lookup.resolves)
    ));
    class FakeClient {
      async getPendingReviewForUser() { return draft; }
      getReviewById(...args) { return getReviewById(...args); }
    }
    const result = await syncPendingDraft({
      db: {}, reviewId: 42, owner: 'o', repo: 'r', prNumber: 9, credential: 'tok',
      _deps: { GitHubClient: FakeClient, GitHubReviewRepository: FakeRepo, logger }
    });
    return { state, getReviewById, result, logger };
  }

  const NEW_DRAFT = { ...GH_PENDING, id: 'PRR_node2', databaseId: 999 };

  it('maps an APPROVED review to submitted, with its timestamp', async () => {
    const { state } = await run(
      { resolves: { state: 'APPROVED', submittedAt: '2026-02-02T00:00:00Z' } }, NEW_DRAFT
    );
    const old = state.rows.find(r => r.id === 1);
    expect(old.state).toBe('submitted');
    expect(old.submitted_at).toBe('2026-02-02T00:00:00Z');
  });

  it('maps a DISMISSED review to dismissed', async () => {
    const { state } = await run({ resolves: { state: 'DISMISSED' } }, NEW_DRAFT);
    expect(state.rows.find(r => r.id === 1).state).toBe('dismissed');
  });

  it('treats an authoritative not-found as dismissed', async () => {
    const { state } = await run({ resolves: null }, NEW_DRAFT);
    expect(state.rows.find(r => r.id === 1).state).toBe('dismissed');
  });

  it('leaves the row untouched when the lookup itself failed', async () => {
    // A rate limit establishes NOTHING about the review's state. Writing
    // `dismissed` there durably rewrote the user's review history — a review
    // they had actually submitted, reported as thrown away.
    const { state, logger } = await run({ rejects: new Error('API rate limit exceeded') }, NEW_DRAFT);
    expect(state.rows.find(r => r.id === 1).state).toBe('pending');
    expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining('leaving its state unchanged'));
  });

  it('reconciles them when GitHub reports NO draft at all (scenario 3)', async () => {
    // Documented as the caller's job and implemented by nobody: the rows sat
    // at state='pending' forever and kept shipping in `allGithubReviews` as
    // live drafts, next to `pendingDraft: null`.
    const { state, getReviewById, result } = await run(
      { resolves: { state: 'COMMENTED', submittedAt: '2026-02-02T00:00:00Z' } }, null
    );
    expect(getReviewById).toHaveBeenCalledTimes(1);
    expect(state.rows.find(r => r.id === 1).state).toBe('submitted');
    expect(result.pendingDraft).toBeNull();
    expect(result.allGithubReviews.every(r => r.state !== 'pending')).toBe(true);
  });

  it('keeps a scenario-3 row pending when its lookup is indeterminate', async () => {
    const { state } = await run({ rejects: new Error('502 Bad Gateway') }, null);
    expect(state.rows.find(r => r.id === 1).state).toBe('pending');
  });

  it('dismisses a row with no identifier to look up', async () => {
    // Nothing to ask GitHub about, and leaving it pending would strand it.
    const { FakeRepo, state } = makeRepo([{ id: 1, review_id: 42, state: 'pending' }]);
    class FakeClient {
      async getPendingReviewForUser() { return null; }
      async getReviewById() { throw new Error('should not be called'); }
    }
    await syncPendingDraft({
      db: {}, reviewId: 42, owner: 'o', repo: 'r', prNumber: 9, credential: 'tok',
      _deps: { GitHubClient: FakeClient, GitHubReviewRepository: FakeRepo, logger: makeLogger() }
    });
    expect(state.rows[0].state).toBe('dismissed');
  });
});

/**
 * An ABSENT `databaseId` is SQL NULL, never the string "null" — the real
 * column semantics are pinned against SQLite (with migration 57's partial
 * indexes) in tests/integration/database.test.js.
 */
describe('a draft GitHub reports without a databaseId', () => {
  const NO_DB_ID = { ...GH_PENDING, databaseId: undefined };

  async function sync(rows, draft) {
    const { FakeRepo, state } = makeRepo(rows);
    class FakeClient {
      async getPendingReviewForUser() { return draft; }
      async getReviewById() { throw new Error('should not be called'); }
    }
    const result = await syncPendingDraft({
      db: {}, reviewId: 42, owner: 'o', repo: 'r', prNumber: 9, credential: 'tok',
      _deps: { GitHubClient: FakeClient, GitHubReviewRepository: FakeRepo, logger: makeLogger() }
    });
    return { state, result };
  }

  it('never mints the literal string "null" as an identity', async () => {
    // `String(undefined_databaseId)` stored a VALUE that two unrelated
    // reviews then shared, so `findByGitHubReviewId` matched the wrong row.
    const { state } = await sync([], NO_DB_ID);

    expect(state.rows).toHaveLength(1);
    expect(state.rows[0].github_review_id).not.toBe('null');
    expect(state.rows[0].github_review_id ?? null).toBeNull();
    expect(state.rows[0].github_node_id).toBe('PRR_node1');
  });

  it('does not blank a numeric id already recorded for that draft', async () => {
    // The matching-update path: this row was mirrored from a REST response
    // that DID carry the id. A later response that omits it must not erase it.
    const { state } = await sync(
      [{ id: 1, review_id: 42, state: 'pending', github_node_id: 'PRR_node1', github_review_id: '555' }],
      NO_DB_ID
    );

    expect(state.rows).toHaveLength(1);
    expect(state.rows[0].github_review_id).toBe('555');
  });
});

describe('serializePendingDraft', () => {
  it('returns null for no draft', () => {
    expect(serializePendingDraft(null)).toBeNull();
    expect(serializePendingDraft(undefined)).toBeNull();
  });

  it('emits exactly the wire shape both modes render, defaulting the count', () => {
    expect(serializePendingDraft({
      id: 3,
      review_id: 42,
      github_review_id: '555',
      github_node_id: 'PRR_node1',
      github_url: 'https://github.com/o/r/pull/9#pullrequestreview-555',
      body: 'not on the wire',
      state: 'pending',
      created_at: '2026-01-01T00:00:00Z'
    })).toEqual({
      id: 3,
      github_review_id: '555',
      github_node_id: 'PRR_node1',
      github_url: 'https://github.com/o/r/pull/9#pullrequestreview-555',
      comments_count: 0,
      created_at: '2026-01-01T00:00:00Z'
    });
  });
});
