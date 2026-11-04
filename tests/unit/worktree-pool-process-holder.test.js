// Copyright 2026 Tim Perkins (tjwp) | SPDX-License-Identifier: Apache-2.0
//
// Two pair-review processes sharing one database (#632). Each "process" is a
// real WorktreePoolLifecycle with its own pid, its own in-memory usage tracker
// and a real WorktreePoolRepository on one shared test database. Only git and
// the filesystem are mocked. Every process runs resetAndRehydrate() before it
// acquires anything, as src/main.js and src/server.js do.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const { WorktreePoolLifecycle } = require('../../src/git/worktree-pool-lifecycle');
const { GRACE_PERIOD_MS } = require('../../src/git/worktree-pool-usage');
const { WorktreePoolRepository } = require('../../src/database');
const { createTestDatabase, closeTestDatabase } = require('../utils/schema');

const PID_A = 1111;
const PID_B = 2222;
const PEER_PID = 3333;
const BOOT_MS = Date.parse('2020-01-01T00:00:00.000Z');
const REPOSITORY = 'owner/repo';
const POOL_OPTIONS = { poolSize: 1, worktreeConfig: {}, checkoutTimeout: 1000 };
const prData = { head: { sha: 'head-sha', ref: 'feature' }, base: { sha: 'base-sha', ref: 'main' } };

function prInfo(prNumber) {
  return { owner: 'owner', repo: 'repo', prNumber, repository: REPOSITORY };
}

/** A promise plus a signal that fires when the gated call is reached. */
function gate() {
  let release;
  let fail;
  let reach;
  const released = new Promise((res, rej) => { release = res; fail = rej; });
  const reached = new Promise((res) => { reach = res; });
  return {
    reached,
    release,
    fail,
    /** Use as a mock implementation: signal arrival, then wait for release. */
    impl: () => { reach(); return released; },
  };
}

describe('pool worktrees across two processes sharing one database', () => {
  let db;
  let livePids;
  const processes = [];

  beforeEach(() => {
    db = createTestDatabase();
    livePids = new Set([PID_A, PID_B, PEER_PID]);
  });

  afterEach(() => {
    for (const p of processes.splice(0)) {
      p.lifecycle._usageTracker.reset();
    }
    closeTestDatabase(db);
  });

  /** Build one pair-review "process": a real lifecycle with mocked git/fs. */
  function makeProcess(pid) {
    const git = {
      revparse: vi.fn().mockResolvedValue('some-other-sha'),
      reset: vi.fn().mockResolvedValue(undefined),
      clean: vi.fn().mockResolvedValue(undefined),
      checkout: vi.fn().mockResolvedValue(undefined),
    };
    const manager = {
      createWorktreeForPR: vi.fn(async (info, _data, _repoPath, opts = {}) => {
        const id = opts.explicitId || `nonpool-${pid}-${info.number}`;
        return { path: `/tmp/${id}`, id };
      }),
      refreshWorktree: vi.fn().mockResolvedValue(undefined),
      resolveRemoteForPR: vi.fn().mockResolvedValue('origin'),
      fetchPRHead: vi.fn().mockResolvedValue({ remote: 'origin', checkoutTarget: 'head-sha' }),
      ensureBaseShaAvailable: vi.fn().mockResolvedValue(undefined),
      getPRHeadSha: vi.fn((data) => data?.head?.sha || ''),
      getPRBaseSha: vi.fn((data) => data?.base?.sha || ''),
      executeCheckoutScript: vi.fn().mockResolvedValue(undefined),
      cleanupWorktree: vi.fn().mockResolvedValue(undefined),
    };
    function GitWorktreeManager() { Object.assign(this, manager); }
    const lifecycle = new WorktreePoolLifecycle(db, {}, {
      fs: { existsSync: () => true },
      simpleGit: () => git,
      GitWorktreeManager,
      pid,
      isProcessAlive: (p) => livePids.has(p),
      getBootTimeMs: () => BOOT_MS,
    });
    const proc = { lifecycle, git, manager };
    processes.push(proc);
    return proc;
  }

  /** Seed an existing pool worktree, available and carrying `prNumber`. */
  function seedAvailablePoolWorktree(id, prNumber) {
    const now = new Date().toISOString();
    db.prepare(`INSERT INTO worktrees (id, pr_number, repository, branch, path, created_at, last_accessed_at)
      VALUES (?, ?, ?, 'old-branch', ?, ?, ?)`).run(id, prNumber, REPOSITORY, `/tmp/${id}`, now, now);
    db.prepare(`INSERT INTO worktree_pool (id, repository, path, status, current_pr_number, created_at)
      VALUES (?, ?, ?, 'available', ?, ?)`).run(id, REPOSITORY, `/tmp/${id}`, prNumber, now);
  }

  function seedReview(prNumber) {
    return db.prepare(`INSERT INTO reviews (pr_number, repository, status, review_type) VALUES (?, ?, 'draft', 'pr')`)
      .run(prNumber, REPOSITORY).lastInsertRowid;
  }

  function poolRows() {
    return db.prepare('SELECT * FROM worktree_pool ORDER BY id').all();
  }

  function poolRow(id) {
    return db.prepare('SELECT * FROM worktree_pool WHERE id = ?').get(id);
  }

  /** B cannot get A's row for any of these PRs: it falls back to a non-pool worktree and the row is untouched. */
  async function expectBCannotClaim(b, prNumbers) {
    const before = poolRows();
    for (const prNumber of prNumbers) {
      const result = await b.lifecycle.acquireForPR(prInfo(prNumber), prData, '/repo', POOL_OPTIONS);
      expect(result.worktreeId).toBe(`nonpool-${PID_B}-${prNumber}`);
      expect(poolRows()).toEqual(before);
    }
  }

  describe('B starts up while A holds a row it has not yet given a review owner', () => {
    it('creating: B keeps A\'s placeholder and cannot claim the slot', async () => {
      const a = makeProcess(PID_A);
      await a.lifecycle.resetAndRehydrate();
      const create = gate();
      a.manager.createWorktreeForPR.mockImplementation(create.impl);
      const aAcquire = a.lifecycle.acquireForPR(prInfo(1), prData, '/repo', POOL_OPTIONS);
      await create.reached;

      const [placeholder] = poolRows();
      expect(placeholder.status).toBe('creating');
      expect(placeholder.holder_pid).toBe(PID_A);
      const before = poolRows();

      const b = makeProcess(PID_B);
      await expect(b.lifecycle.resetAndRehydrate()).resolves.toEqual([]);
      expect(poolRows()).toEqual(before);
      await expectBCannotClaim(b, [2]);

      create.release({ path: '/tmp/pool-a', id: placeholder.id });
      await expect(aAcquire).resolves.toEqual({ worktreePath: '/tmp/pool-a', worktreeId: placeholder.id });
      const row = poolRow(placeholder.id);
      expect(row.status).toBe('in_use');
      expect(row.current_pr_number).toBe(1);
      expect(row.path).toBe('/tmp/pool-a');
      expect(row.holder_pid).toBe(PID_A);
    });

    it('switching: B leaves the row switching and cannot claim it, even for the PR the row still carries', async () => {
      seedAvailablePoolWorktree('pool-1', 7);
      const a = makeProcess(PID_A);
      await a.lifecycle.resetAndRehydrate();
      const fetch = gate();
      a.manager.fetchPRHead.mockImplementation(fetch.impl);
      const aAcquire = a.lifecycle.acquireForPR(prInfo(1), prData, '/repo', POOL_OPTIONS);
      await fetch.reached;

      expect(poolRow('pool-1').status).toBe('switching');
      expect(poolRow('pool-1').holder_pid).toBe(PID_A);
      expect(poolRow('pool-1').current_pr_number).toBe(7);
      const before = poolRows();

      const b = makeProcess(PID_B);
      await expect(b.lifecycle.resetAndRehydrate()).resolves.toEqual([]);
      expect(poolRows()).toEqual(before);
      // PR 7 is what the row still carries: claimByPR's status filter must refuse it
      await expectBCannotClaim(b, [7, 2]);

      fetch.release({ remote: 'origin', checkoutTarget: 'head-sha' });
      await expect(aAcquire).resolves.toEqual({ worktreePath: '/tmp/pool-1', worktreeId: 'pool-1' });
      const row = poolRow('pool-1');
      expect(row.status).toBe('in_use');
      expect(row.current_pr_number).toBe(1);
      expect(row.holder_pid).toBe(PID_A);
    });

    it('in_use before setReviewOwner: B does not reset the row and cannot claim it for a different PR', async () => {
      seedAvailablePoolWorktree('pool-1', 7);
      const a = makeProcess(PID_A);
      await a.lifecycle.resetAndRehydrate();
      await a.lifecycle.acquireForPR(prInfo(1), prData, '/repo', POOL_OPTIONS);

      const acquired = poolRow('pool-1');
      expect(acquired.status).toBe('in_use');
      expect(acquired.current_review_id === null).toBe(true);
      expect(acquired.holder_pid).toBe(PID_A);
      const before = poolRows();

      const b = makeProcess(PID_B);
      await expect(b.lifecycle.resetAndRehydrate()).resolves.toEqual([]);
      expect(poolRows()).toEqual(before);
      await expectBCannotClaim(b, [2, 7]);
    });
  });

  it('B starts after A set the review owner: B\'s idle timer cannot free A\'s row', async () => {
    vi.useFakeTimers();
    try {
      seedAvailablePoolWorktree('pool-1', 7);
      const reviewId = seedReview(1);
      const a = makeProcess(PID_A);
      await a.lifecycle.resetAndRehydrate();
      await a.lifecycle.acquireForPR(prInfo(1), prData, '/repo', POOL_OPTIONS);
      await a.lifecycle.setReviewOwner('pool-1', reviewId);
      const before = poolRow('pool-1');

      const b = makeProcess(PID_B);
      // A is alive: B neither resets nor preserves (so arms no timer for) A's row
      await expect(b.lifecycle.resetAndRehydrate()).resolves.toEqual([]);
      expect(poolRow('pool-1')).toEqual(before);

      // B has a real browser session on the review, then it closes: B arms a grace timer
      const markAvailable = vi.spyOn(b.lifecycle.poolRepo, 'markAvailable');
      await expect(b.lifecycle.startSession(reviewId, 'ws-b')).resolves.toEqual({ worktreeId: 'pool-1' });
      b.lifecycle.endSession('pool-1', 'ws-b');
      expect(b.lifecycle._usageTracker.isInUse('pool-1')).toBe(true);

      await vi.advanceTimersByTimeAsync(GRACE_PERIOD_MS * 2);

      // B's onIdle ran and was refused
      expect(markAvailable).toHaveBeenCalledWith('pool-1', PID_B);
      await expect(markAvailable.mock.results[0].value).resolves.toBe(false);
      const row = poolRow('pool-1');
      expect(row).toEqual(before);
      expect(row.status).toBe('in_use');
      expect(row.holder_pid).toBe(PID_A);
      expect(row.current_review_id).toBe(Number(reviewId));
    } finally {
      vi.useRealTimers();
    }
  });

  describe('acquire-time races in one process', () => {
    /** A acquires pool-1 for PR 1 (switching it from PR 7) and owns the review. */
    async function aHoldsPR1() {
      seedAvailablePoolWorktree('pool-1', 7);
      const reviewId = seedReview(1);
      const a = makeProcess(PID_A);
      await a.lifecycle.resetAndRehydrate();
      await a.lifecycle.acquireForPR(prInfo(1), prData, '/repo', POOL_OPTIONS);
      await a.lifecycle.setReviewOwner('pool-1', reviewId);
      return { a, reviewId };
    }

    it('a claim cancels the pending grace timer, so it cannot fire during a held refresh', async () => {
      vi.useFakeTimers();
      try {
        const { a, reviewId } = await aHoldsPR1();
        // The browser tab closed: a grace timer is pending for pool-1
        await a.lifecycle.startSession(reviewId, 'ws-a');
        a.lifecycle.endSession('pool-1', 'ws-a');
        const markAvailable = vi.spyOn(a.lifecycle.poolRepo, 'markAvailable');

        const refresh = gate();
        a.manager.refreshWorktree.mockImplementation(refresh.impl);
        const reacquire = a.lifecycle.acquireForPR(prInfo(1), prData, '/repo', POOL_OPTIONS);
        await refresh.reached;

        await vi.advanceTimersByTimeAsync(GRACE_PERIOD_MS * 2);

        expect(markAvailable).not.toHaveBeenCalled();
        expect(poolRow('pool-1').status).toBe('in_use');
        expect(poolRow('pool-1').holder_pid).toBe(PID_A);

        refresh.release(undefined);
        await expect(reacquire).resolves.toEqual({ worktreePath: '/tmp/pool-1', worktreeId: 'pool-1' });
        const row = poolRow('pool-1');
        expect(row.status).toBe('in_use');
        expect(row.current_pr_number).toBe(1);
        expect(row.holder_pid).toBe(PID_A);
      } finally {
        vi.useRealTimers();
      }
    });

    it('throws when the row is taken over during the refresh, and leaves the new holder\'s row alone', async () => {
      const { a } = await aHoldsPR1();
      const refresh = gate();
      a.manager.refreshWorktree.mockImplementation(refresh.impl);
      const reacquire = a.lifecycle.acquireForPR(prInfo(1), prData, '/repo', POOL_OPTIONS);
      await refresh.reached;

      // Mid-refresh the row is freed (a user delete) and a peer claims it to switch to another PR
      const peerRepo = new WorktreePoolRepository(db);
      await peerRepo.forceMarkAvailable('pool-1');
      const peerClaim = await peerRepo.claimAvailable(REPOSITORY, PEER_PID);
      expect(peerClaim.id).toBe('pool-1');
      const peerRow = poolRow('pool-1');

      refresh.release(undefined);
      await expect(reacquire).rejects.toThrow('pool worktree pool-1 was taken over during refresh');

      expect(poolRow('pool-1')).toEqual(peerRow);
      expect(poolRow('pool-1').status).toBe('switching');
      expect(poolRow('pool-1').holder_pid).toBe(PEER_PID);
    });

    it('frees the row when the refresh throws and this process is not using it', async () => {
      const { a } = await aHoldsPR1();
      a.manager.refreshWorktree.mockRejectedValue(new Error('fetch exploded'));

      await expect(a.lifecycle.acquireForPR(prInfo(1), prData, '/repo', POOL_OPTIONS)).rejects.toThrow('fetch exploded');

      const row = poolRow('pool-1');
      expect(row.status).toBe('available');
      expect(row.holder_pid === null).toBe(true);
      expect(row.holder_claimed_at === null).toBe(true);
    });

    it('keeps the row when the refresh throws but this process still has a session on it', async () => {
      const { a, reviewId } = await aHoldsPR1();
      await a.lifecycle.startSession(reviewId, 'ws-a');
      a.manager.refreshWorktree.mockRejectedValue(new Error('fetch exploded'));

      await expect(a.lifecycle.acquireForPR(prInfo(1), prData, '/repo', POOL_OPTIONS)).rejects.toThrow('fetch exploded');

      const row = poolRow('pool-1');
      expect(row.status).toBe('in_use');
      expect(row.current_pr_number).toBe(1);
      expect(row.holder_pid).toBe(PID_A);
    });
  });
});
