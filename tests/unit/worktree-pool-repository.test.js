// Copyright 2026 Tim Perkins (tjwp) | SPDX-License-Identifier: Apache-2.0
import { describe, it, expect, beforeEach, afterEach } from 'vitest';

const { WorktreePoolRepository, WorktreeRepository } = require('../../src/database');
const { createTestDatabase, closeTestDatabase } = require('../utils/schema');

describe('WorktreePoolRepository', () => {
  let db;
  let repo;

  /** Insert a worktree row (needed as context for pool entries). */
  function seedWorktree(id, { prNumber = 1, repository = 'owner/repo', branch = 'main', path } = {}) {
    const now = new Date().toISOString();
    db.prepare(`INSERT INTO worktrees (id, pr_number, repository, branch, path, created_at, last_accessed_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)`).run(id, prNumber, repository, branch, path || `/tmp/${id}`, now, now);
  }

  /** Read a pool row directly for assertions. */
  function getPoolRow(id) {
    return db.prepare('SELECT * FROM worktree_pool WHERE id = ?').get(id);
  }

  beforeEach(() => {
    db = createTestDatabase();
    repo = new WorktreePoolRepository(db);
  });

  afterEach(() => {
    closeTestDatabase(db);
  });

  // ── create ──────────────────────────────────────────────────────────────
  describe('create', () => {
    it('inserts a pool entry with available status when no prNumber', async () => {
      await repo.create({ id: 'pool-abc', repository: 'owner/repo', path: '/tmp/pool-abc' });

      const row = getPoolRow('pool-abc');
      expect(row).toBeTruthy();
      expect(row.status).toBe('available');
      expect(row.repository).toBe('owner/repo');
      expect(row.path).toBe('/tmp/pool-abc');
      expect(row.current_pr_number).toBeNull();
      expect(row.created_at).toBeTruthy();
    });

    it('inserts as in_use with PR number when prNumber is provided', async () => {
      await repo.create({ id: 'pool-abc', repository: 'owner/repo', path: '/tmp/pool-abc', prNumber: 42 });

      const row = getPoolRow('pool-abc');
      expect(row).toBeTruthy();
      expect(row.status).toBe('in_use');
      expect(row.current_pr_number).toBe(42);
      expect(row.last_switched_at).toBeTruthy();
      expect(row.created_at).toBeTruthy();
    });

    it('creates as available when prNumber is explicitly null', async () => {
      await repo.create({ id: 'pool-abc', repository: 'owner/repo', path: '/tmp/pool-abc', prNumber: null });

      const row = getPoolRow('pool-abc');
      expect(row.status).toBe('available');
      expect(row.current_pr_number).toBeNull();
    });
  });

  // ── findAvailable ───────────────────────────────────────────────────────
  describe('findAvailable', () => {
    it('returns the LRU entry (NULL last_switched_at first)', async () => {
      await repo.create({ id: 'pool-a', repository: 'owner/repo', path: '/tmp/a' });
      await repo.create({ id: 'pool-b', repository: 'owner/repo', path: '/tmp/b' });

      // Give pool-b a last_switched_at so pool-a (NULL) should come first
      db.prepare("UPDATE worktree_pool SET last_switched_at = '2026-01-01T00:00:00Z' WHERE id = 'pool-b'").run();

      const result = await repo.findAvailable('owner/repo');
      expect(result).toBeTruthy();
      expect(result.id).toBe('pool-a');
    });

    it('returns the oldest last_switched_at when no NULLs', async () => {
      await repo.create({ id: 'pool-a', repository: 'owner/repo', path: '/tmp/a' });
      await repo.create({ id: 'pool-b', repository: 'owner/repo', path: '/tmp/b' });

      db.prepare("UPDATE worktree_pool SET last_switched_at = '2026-01-02T00:00:00Z' WHERE id = 'pool-a'").run();
      db.prepare("UPDATE worktree_pool SET last_switched_at = '2026-01-01T00:00:00Z' WHERE id = 'pool-b'").run();

      const result = await repo.findAvailable('owner/repo');
      expect(result.id).toBe('pool-b');
    });

    it('returns null when no available entries', async () => {
      await repo.create({ id: 'pool-a', repository: 'owner/repo', path: '/tmp/a' });
      await repo.markInUse('pool-a', 42);

      const result = await repo.findAvailable('owner/repo');
      expect(result).toBeUndefined();
    });
  });

  // ── findByPR ────────────────────────────────────────────────────────────
  describe('findByPR', () => {
    it('finds a pool entry by PR number and repository', async () => {
      await repo.create({ id: 'pool-x', repository: 'owner/repo', path: '/tmp/x' });
      await repo.markInUse('pool-x', 77);

      const result = await repo.findByPR(77, 'owner/repo');
      expect(result).toBeTruthy();
      expect(result.id).toBe('pool-x');
      expect(result.current_pr_number).toBe(77);
    });

    it('returns undefined when not found', async () => {
      const result = await repo.findByPR(999, 'owner/repo');
      expect(result).toBeUndefined();
    });
  });

  // ── countForRepo ────────────────────────────────────────────────────────
  describe('countForRepo', () => {
    it('returns accurate count', async () => {
      await repo.create({ id: 'pool-a', repository: 'owner/repo', path: '/tmp/a' });
      await repo.create({ id: 'pool-b', repository: 'owner/repo', path: '/tmp/b' });
      await repo.create({ id: 'pool-c', repository: 'other/repo', path: '/tmp/c' });

      const count = await repo.countForRepo('owner/repo');
      expect(count).toBe(2);
    });
  });

  // ── markInUse ───────────────────────────────────────────────────────────
  describe('markInUse', () => {
    it('changes status to in_use and sets PR number and last_switched_at', async () => {
      await repo.create({ id: 'pool-a', repository: 'owner/repo', path: '/tmp/a' });

      await repo.markInUse('pool-a', 42);

      const row = getPoolRow('pool-a');
      expect(row.status).toBe('in_use');
      expect(row.current_pr_number).toBe(42);
      expect(row.last_switched_at).toBeTruthy();
    });
  });

  // ── markAvailable ───────────────────────────────────────────────────────
  describe('markAvailable', () => {
    it('changes status back to available', async () => {
      await repo.create({ id: 'pool-a', repository: 'owner/repo', path: '/tmp/a' });
      await repo.markInUse('pool-a', 42);

      await repo.markAvailable('pool-a');

      const row = getPoolRow('pool-a');
      expect(row.status).toBe('available');
    });

    it('clears current_review_id when marking available', async () => {
      await repo.create({ id: 'pool-a', repository: 'owner/repo', path: '/tmp/a' });
      await repo.markInUse('pool-a', 42);
      await repo.setCurrentReviewId('pool-a', 100);

      await repo.markAvailable('pool-a');

      const row = getPoolRow('pool-a');
      expect(row.status).toBe('available');
      expect(row.current_review_id).toBeNull();
    });
  });

  // ── markSwitching ───────────────────────────────────────────────────────
  describe('markSwitching', () => {
    it('changes status to switching', async () => {
      await repo.create({ id: 'pool-a', repository: 'owner/repo', path: '/tmp/a' });

      await repo.markSwitching('pool-a');

      const row = getPoolRow('pool-a');
      expect(row.status).toBe('switching');
    });
  });

  // ── updateLastFetched ───────────────────────────────────────────────────
  describe('updateLastFetched', () => {
    it('updates the last_fetched_at timestamp', async () => {
      await repo.create({ id: 'pool-a', repository: 'owner/repo', path: '/tmp/a' });
      const before = getPoolRow('pool-a');
      expect(before.last_fetched_at).toBeNull();

      await repo.updateLastFetched('pool-a');

      const after = getPoolRow('pool-a');
      expect(after.last_fetched_at).toBeTruthy();
    });
  });

  // ── findIdleForRepo ─────────────────────────────────────────────────────
  describe('findIdleForRepo', () => {
    it('returns only available entries for the repository', async () => {
      await repo.create({ id: 'pool-a', repository: 'owner/repo', path: '/tmp/a' });
      await repo.create({ id: 'pool-b', repository: 'owner/repo', path: '/tmp/b' });
      await repo.markInUse('pool-b', 10);

      const idle = await repo.findIdleForRepo('owner/repo');
      expect(idle).toHaveLength(1);
      expect(idle[0].id).toBe('pool-a');
    });
  });

  // ── findAllForRepo ──────────────────────────────────────────────────────
  describe('findAllForRepo', () => {
    it('returns all entries regardless of status', async () => {
      await repo.create({ id: 'pool-a', repository: 'owner/repo', path: '/tmp/a' });
      await repo.create({ id: 'pool-b', repository: 'owner/repo', path: '/tmp/b' });
      await repo.markInUse('pool-b', 10);

      const all = await repo.findAllForRepo('owner/repo');
      expect(all).toHaveLength(2);
    });
  });

  // ── findAllForFetch ─────────────────────────────────────────────────────
  describe('findAllForFetch', () => {
    it('excludes switching entries and orders by last_fetched_at ASC NULLS FIRST', async () => {
      await repo.create({ id: 'pool-a', repository: 'owner/repo', path: '/tmp/a' });
      await repo.create({ id: 'pool-b', repository: 'owner/repo', path: '/tmp/b' });
      await repo.create({ id: 'pool-c', repository: 'owner/repo', path: '/tmp/c' });
      await repo.markSwitching('pool-c');

      // Give pool-b a fetched_at so pool-a (NULL) comes first
      await repo.updateLastFetched('pool-b');

      const result = await repo.findAllForFetch('owner/repo');
      expect(result).toHaveLength(2); // pool-c excluded (switching)
      expect(result[0].id).toBe('pool-a'); // NULL last_fetched_at first
      expect(result[1].id).toBe('pool-b');
    });
  });

  // ── isPoolWorktree ──────────────────────────────────────────────────────
  describe('isPoolWorktree', () => {
    it('returns true for pool entries', async () => {
      await repo.create({ id: 'pool-a', repository: 'owner/repo', path: '/tmp/a' });

      const result = await repo.isPoolWorktree('pool-a');
      expect(result).toBe(true);
    });

    it('returns false for non-existent entries', async () => {
      const result = await repo.isPoolWorktree('nonexistent');
      expect(result).toBe(false);
    });
  });

  // ── getPoolEntry ────────────────────────────────────────────────────────
  describe('getPoolEntry', () => {
    it('returns the full pool entry row', async () => {
      await repo.create({ id: 'pool-a', repository: 'owner/repo', path: '/tmp/a' });
      await repo.markInUse('pool-a', 42);

      const entry = await repo.getPoolEntry('pool-a');
      expect(entry).toBeTruthy();
      expect(entry.id).toBe('pool-a');
      expect(entry.repository).toBe('owner/repo');
      expect(entry.path).toBe('/tmp/a');
      expect(entry.status).toBe('in_use');
      expect(entry.current_pr_number).toBe(42);
    });

    it('returns undefined for non-existent entries', async () => {
      const entry = await repo.getPoolEntry('nonexistent');
      expect(entry).toBeUndefined();
    });

    it('reflects available status after release', async () => {
      await repo.create({ id: 'pool-a', repository: 'owner/repo', path: '/tmp/a' });
      await repo.markInUse('pool-a', 42);
      await repo.markAvailable('pool-a');

      const entry = await repo.getPoolEntry('pool-a');
      expect(entry.status).toBe('available');
    });
  });

  // ── delete ──────────────────────────────────────────────────────────────
  describe('delete', () => {
    it('removes the pool entry', async () => {
      await repo.create({ id: 'pool-a', repository: 'owner/repo', path: '/tmp/a' });

      await repo.delete('pool-a');

      const row = getPoolRow('pool-a');
      expect(row).toBeUndefined();
    });
  });

  // ── findByReviewId ──────────────────────────────────────────────────────
  describe('findByReviewId', () => {
    it('finds a pool entry by review ID when in_use', async () => {
      await repo.create({ id: 'pool-a', repository: 'owner/repo', path: '/tmp/a' });
      await repo.markInUse('pool-a', 42);
      await repo.setCurrentReviewId('pool-a', 100);

      const result = await repo.findByReviewId(100);
      expect(result).toBeTruthy();
      expect(result.id).toBe('pool-a');
    });

    it('returns undefined when review ID not found', async () => {
      const result = await repo.findByReviewId(999);
      expect(result).toBeUndefined();
    });

    it('returns undefined when worktree is available (not in_use)', async () => {
      await repo.create({ id: 'pool-a', repository: 'owner/repo', path: '/tmp/a' });
      await repo.markInUse('pool-a', 42);
      await repo.setCurrentReviewId('pool-a', 100);
      await repo.markAvailable('pool-a');

      const result = await repo.findByReviewId(100);
      // markAvailable clears current_review_id, so this should be undefined
      expect(result).toBeUndefined();
    });

    it('returns undefined when worktree is switching', async () => {
      await repo.create({ id: 'pool-a', repository: 'owner/repo', path: '/tmp/a' });
      await repo.markInUse('pool-a', 42);
      await repo.setCurrentReviewId('pool-a', 100);
      await repo.markSwitching('pool-a');

      const result = await repo.findByReviewId(100);
      // status is 'switching', not 'in_use'
      expect(result).toBeUndefined();
    });
  });

  // ── setCurrentReviewId ──────────────────────────────────────────────────
  describe('setCurrentReviewId', () => {
    it('sets the current_review_id on a pool entry', async () => {
      await repo.create({ id: 'pool-a', repository: 'owner/repo', path: '/tmp/a' });

      await repo.setCurrentReviewId('pool-a', 42);

      const row = getPoolRow('pool-a');
      expect(row.current_review_id).toBe(42);
    });

    it('clears the current_review_id when set to null', async () => {
      await repo.create({ id: 'pool-a', repository: 'owner/repo', path: '/tmp/a' });
      await repo.setCurrentReviewId('pool-a', 42);

      await repo.setCurrentReviewId('pool-a', null);

      const row = getPoolRow('pool-a');
      expect(row.current_review_id).toBeNull();
    });
  });

  // ── reserveSlot ──────────────────────────────────────────────────────────
  describe('reserveSlot', () => {
    it('inserts a placeholder row with status creating when under capacity', async () => {
      const result = await repo.reserveSlot('pool-new', 'owner/repo', 3);

      expect(result).toBe(true);
      const row = getPoolRow('pool-new');
      expect(row).toBeTruthy();
      expect(row.status).toBe('creating');
      expect(row.repository).toBe('owner/repo');
      expect(row.path).toBe('__creating__pool-new');
      expect(row.current_pr_number).toBeNull();
      expect(row.created_at).toBeTruthy();
    });

    it('returns false when at capacity', async () => {
      await repo.create({ id: 'pool-a', repository: 'owner/repo', path: '/tmp/a' });
      await repo.create({ id: 'pool-b', repository: 'owner/repo', path: '/tmp/b' });
      await repo.create({ id: 'pool-c', repository: 'owner/repo', path: '/tmp/c' });

      const result = await repo.reserveSlot('pool-new', 'owner/repo', 3);

      expect(result).toBe(false);
      const row = getPoolRow('pool-new');
      expect(row).toBeUndefined();
    });

    it('counts creating entries toward capacity', async () => {
      await repo.create({ id: 'pool-a', repository: 'owner/repo', path: '/tmp/a' });
      await repo.create({ id: 'pool-b', repository: 'owner/repo', path: '/tmp/b' });
      // Reserve a third slot (creating status)
      await repo.reserveSlot('pool-c', 'owner/repo', 3);

      // Fourth slot should be rejected
      const result = await repo.reserveSlot('pool-d', 'owner/repo', 3);

      expect(result).toBe(false);
    });

    it('is case-insensitive on repository', async () => {
      await repo.create({ id: 'pool-a', repository: 'Owner/Repo', path: '/tmp/a' });

      const result = await repo.reserveSlot('pool-new', 'owner/repo', 2);

      expect(result).toBe(true);
    });

    it('does not count entries from other repositories', async () => {
      await repo.create({ id: 'pool-a', repository: 'other/repo', path: '/tmp/a' });
      await repo.create({ id: 'pool-b', repository: 'other/repo', path: '/tmp/b' });
      await repo.create({ id: 'pool-c', repository: 'other/repo', path: '/tmp/c' });

      const result = await repo.reserveSlot('pool-new', 'owner/repo', 2);

      expect(result).toBe(true);
    });
  });

  // ── finalizeReservation ─────────────────────────────────────────────────
  describe('finalizeReservation', () => {
    it('updates placeholder to in_use with path and PR number', async () => {
      await repo.reserveSlot('pool-new', 'owner/repo', 3);

      await repo.finalizeReservation('pool-new', '/tmp/pool-new', 42);

      const row = getPoolRow('pool-new');
      expect(row.status).toBe('in_use');
      expect(row.path).toBe('/tmp/pool-new');
      expect(row.current_pr_number).toBe(42);
      expect(row.last_switched_at).toBeTruthy();
    });

    it('does not update non-creating entries', async () => {
      await repo.create({ id: 'pool-a', repository: 'owner/repo', path: '/tmp/a' });

      await repo.finalizeReservation('pool-a', '/tmp/new-path', 99);

      // Should not have changed — status was 'available', not 'creating'
      const row = getPoolRow('pool-a');
      expect(row.status).toBe('available');
      expect(row.path).toBe('/tmp/a');
    });
  });

  // ── deleteReservation ───────────────────────────────────────────────────
  describe('deleteReservation', () => {
    it('removes a creating placeholder', async () => {
      await repo.reserveSlot('pool-new', 'owner/repo', 3);

      await repo.deleteReservation('pool-new');

      const row = getPoolRow('pool-new');
      expect(row).toBeUndefined();
    });

    it('does not delete non-creating entries', async () => {
      await repo.create({ id: 'pool-a', repository: 'owner/repo', path: '/tmp/a' });

      await repo.deleteReservation('pool-a');

      // Should still exist — status was 'available', not 'creating'
      const row = getPoolRow('pool-a');
      expect(row).toBeTruthy();
      expect(row.status).toBe('available');
    });
  });

  // ── claimByPR ────────────────────────────────────────────────────────────
  describe('claimByPR', () => {
    it('atomically finds and marks an existing PR assignment as in_use', async () => {
      await repo.create({ id: 'pool-a', repository: 'owner/repo', path: '/tmp/a' });
      await repo.markInUse('pool-a', 42);
      // Simulate it was released then re-claimed
      await repo.markAvailable('pool-a');
      // markAvailable clears current_review_id but preserves current_pr_number? No — let's set it up properly
      // Actually markAvailable only clears current_review_id, not current_pr_number.
      // To have a valid findByPR, we need current_pr_number set.
      db.prepare("UPDATE worktree_pool SET current_pr_number = 42 WHERE id = 'pool-a'").run();

      const result = await repo.claimByPR(42, 'owner/repo');

      expect(result).toBeTruthy();
      expect(result.id).toBe('pool-a');
      // After claim, should be marked in_use
      const row = getPoolRow('pool-a');
      expect(row.status).toBe('in_use');
      expect(row.current_pr_number).toBe(42);
      expect(row.last_switched_at).toBeTruthy();
      expect(row.current_review_id).toBeNull();
    });

    it('returns null when no entry matches the PR', async () => {
      await repo.create({ id: 'pool-a', repository: 'owner/repo', path: '/tmp/a' });

      const result = await repo.claimByPR(999, 'owner/repo');

      expect(result).toBeNull();
    });

    it('claims entry even if it was already in_use for same PR', async () => {
      await repo.create({ id: 'pool-a', repository: 'owner/repo', path: '/tmp/a' });
      await repo.markInUse('pool-a', 77);

      const result = await repo.claimByPR(77, 'owner/repo');

      expect(result).toBeTruthy();
      expect(result.id).toBe('pool-a');
      const row = getPoolRow('pool-a');
      expect(row.status).toBe('in_use');
    });

    it('is case-insensitive on repository', async () => {
      await repo.create({ id: 'pool-a', repository: 'Owner/Repo', path: '/tmp/a' });
      await repo.markInUse('pool-a', 10);

      const result = await repo.claimByPR(10, 'owner/repo');

      expect(result).toBeTruthy();
      expect(result.id).toBe('pool-a');
    });

    it('does not claim a worktree in switching state', async () => {
      await repo.create({ id: 'pool-a', repository: 'owner/repo', path: '/tmp/a' });
      await repo.markInUse('pool-a', 42);
      await repo.markSwitching('pool-a');

      const result = await repo.claimByPR(42, 'owner/repo');

      expect(result).toBeNull();
      // Entry should remain in switching state, not reclaimed
      const row = getPoolRow('pool-a');
      expect(row.status).toBe('switching');
    });

    it('claims available worktree with matching PR over switching one', async () => {
      // Two entries for the same PR: one switching, one available
      await repo.create({ id: 'pool-a', repository: 'owner/repo', path: '/tmp/a' });
      await repo.markInUse('pool-a', 55);
      await repo.markSwitching('pool-a');

      await repo.create({ id: 'pool-b', repository: 'owner/repo', path: '/tmp/b' });
      await repo.markInUse('pool-b', 55);
      await repo.markAvailable('pool-b');
      // Restore PR number (markAvailable doesn't clear it)
      db.prepare("UPDATE worktree_pool SET current_pr_number = 55 WHERE id = 'pool-b'").run();

      const result = await repo.claimByPR(55, 'owner/repo');

      expect(result).toBeTruthy();
      expect(result.id).toBe('pool-b');
      // pool-a should still be switching
      expect(getPoolRow('pool-a').status).toBe('switching');
    });
  });

  // ── claimAvailable ──────────────────────────────────────────────────────
  describe('claimAvailable', () => {
    it('atomically finds LRU available entry and marks it switching', async () => {
      await repo.create({ id: 'pool-a', repository: 'owner/repo', path: '/tmp/a' });
      await repo.create({ id: 'pool-b', repository: 'owner/repo', path: '/tmp/b' });
      db.prepare("UPDATE worktree_pool SET last_switched_at = '2026-01-02T00:00:00Z' WHERE id = 'pool-a'").run();
      db.prepare("UPDATE worktree_pool SET last_switched_at = '2026-01-01T00:00:00Z' WHERE id = 'pool-b'").run();

      const result = await repo.claimAvailable('owner/repo');

      expect(result).toBeTruthy();
      // Should pick pool-b (oldest last_switched_at)
      expect(result.id).toBe('pool-b');
      // After claim, pool-b should be switching
      const row = getPoolRow('pool-b');
      expect(row.status).toBe('switching');
      // pool-a should still be available
      const rowA = getPoolRow('pool-a');
      expect(rowA.status).toBe('available');
    });

    it('prefers NULL last_switched_at (never used) over oldest', async () => {
      await repo.create({ id: 'pool-a', repository: 'owner/repo', path: '/tmp/a' });
      await repo.create({ id: 'pool-b', repository: 'owner/repo', path: '/tmp/b' });
      db.prepare("UPDATE worktree_pool SET last_switched_at = '2026-01-01T00:00:00Z' WHERE id = 'pool-b'").run();

      const result = await repo.claimAvailable('owner/repo');

      expect(result).toBeTruthy();
      expect(result.id).toBe('pool-a'); // NULL comes first
    });

    it('returns null when no available entries', async () => {
      await repo.create({ id: 'pool-a', repository: 'owner/repo', path: '/tmp/a' });
      await repo.markInUse('pool-a', 10);

      const result = await repo.claimAvailable('owner/repo');

      expect(result).toBeNull();
    });

    it('does not claim entries from other repositories', async () => {
      await repo.create({ id: 'pool-a', repository: 'other/repo', path: '/tmp/a' });

      const result = await repo.claimAvailable('owner/repo');

      expect(result).toBeNull();
      // other/repo entry should remain available
      const row = getPoolRow('pool-a');
      expect(row.status).toBe('available');
    });

    it('is case-insensitive on repository', async () => {
      await repo.create({ id: 'pool-a', repository: 'Owner/Repo', path: '/tmp/a' });

      const result = await repo.claimAvailable('owner/repo');

      expect(result).toBeTruthy();
      expect(result.id).toBe('pool-a');
    });

    it('second concurrent claim gets null when only one slot is available', async () => {
      await repo.create({ id: 'pool-a', repository: 'owner/repo', path: '/tmp/a' });

      // First claim succeeds
      const first = await repo.claimAvailable('owner/repo');
      expect(first).toBeTruthy();
      expect(first.id).toBe('pool-a');

      // Second claim finds nothing (pool-a is now switching)
      const second = await repo.claimAvailable('owner/repo');
      expect(second).toBeNull();
    });
  });

  // ── WorktreeRepository.switchPR ─────────────────────────────────────────
  // These tests exercise the pool-transition path in the WorktreeRepository
  // where non-pool worktree records are deleted to avoid UNIQUE violations.
  describe('WorktreeRepository.switchPR (deleted path return)', () => {
    let worktreeRepo;

    beforeEach(() => {
      worktreeRepo = new WorktreeRepository(db);
    });

    it('returns paths of deleted non-pool worktree records', async () => {
      // Create a pool worktree via seedWorktree + pool entry
      seedWorktree('pool-a', { prNumber: 1, repository: 'owner/repo', path: '/tmp/pool-a' });
      await repo.create({ id: 'pool-a', repository: 'owner/repo', path: '/tmp/pool-a' });

      // Create a non-pool worktree for PR #2 (the target PR)
      seedWorktree('legacy-wt', { prNumber: 2, repository: 'owner/repo', path: '/tmp/legacy-wt' });

      // Switch pool worktree from PR #1 to PR #2
      const deletedPaths = await worktreeRepo.switchPR('pool-a', 2, 'feature-branch');

      expect(deletedPaths).toEqual(['/tmp/legacy-wt']);
    });

    it('returns empty array when no conflicting non-pool worktrees exist', async () => {
      seedWorktree('pool-a', { prNumber: 1, repository: 'owner/repo', path: '/tmp/pool-a' });
      await repo.create({ id: 'pool-a', repository: 'owner/repo', path: '/tmp/pool-a' });

      // No conflicting worktree for PR #5
      const deletedPaths = await worktreeRepo.switchPR('pool-a', 5, 'other-branch');

      expect(deletedPaths).toEqual([]);
    });

    it('does not delete or return paths of pool worktrees', async () => {
      // Pool worktree A currently on PR #1
      seedWorktree('pool-a', { prNumber: 1, repository: 'owner/repo', path: '/tmp/pool-a' });
      await repo.create({ id: 'pool-a', repository: 'owner/repo', path: '/tmp/pool-a' });

      // Non-pool worktree for PR #3 and a pool worktree for PR #3 on a different repo.
      // We want to verify that only non-pool records are deleted.
      seedWorktree('legacy-wt', { prNumber: 3, repository: 'owner/repo', path: '/tmp/legacy-wt' });

      // Switch pool-a to PR #3 — legacy-wt (non-pool) should be deleted
      const deletedPaths = await worktreeRepo.switchPR('pool-a', 3, 'feature-branch');

      expect(deletedPaths).toEqual(['/tmp/legacy-wt']);
      // legacy worktree record should be gone
      const legacy = await worktreeRepo.findById('legacy-wt');
      expect(legacy).toBeNull();
    });

    it('preserves pool worktree records during switchPR conflict resolution', async () => {
      // Pool worktree A on PR #1, pool worktree B on PR #2
      seedWorktree('pool-a', { prNumber: 1, repository: 'owner/repo', path: '/tmp/pool-a' });
      await repo.create({ id: 'pool-a', repository: 'owner/repo', path: '/tmp/pool-a' });

      seedWorktree('pool-b', { prNumber: 2, repository: 'owner/repo', path: '/tmp/pool-b' });
      await repo.create({ id: 'pool-b', repository: 'owner/repo', path: '/tmp/pool-b' });

      // Switching pool-a to PR #2 would conflict with pool-b in the worktrees table.
      // Since pool-b is a pool worktree, it should NOT be deleted (the DELETE only
      // targets non-pool records). The UNIQUE violation is expected — this scenario
      // should not arise in practice because pool worktrees are switched via the pool
      // manager which coordinates. But we verify the DELETE does not touch pool records.
      await expect(worktreeRepo.switchPR('pool-a', 2, 'feature')).rejects.toThrow(/UNIQUE constraint/);

      // pool-b should still exist
      const poolB = await worktreeRepo.findById('pool-b');
      expect(poolB).toBeTruthy();
    });
  });

  // ── resetStaleAndPreserve ──────────────────────────────────────────────
  describe('resetStaleAndPreserve', () => {
    /** Helper: insert a review row and return its ID. */
    function seedReview(id) {
      db.prepare(
        "INSERT INTO reviews (id, pr_number, repository, status, review_type) VALUES (?, 1, 'owner/repo', 'draft', 'pr')"
      ).run(id);
      return id;
    }

    it('resets entries with no review owner', async () => {
      await repo.create({ id: 'pool-a', repository: 'owner/repo', path: '/tmp/a' });
      await repo.markInUse('pool-a', 1);
      // current_review_id is NULL — should be reset

      const preserved = await repo.resetStaleAndPreserve();

      expect(preserved).toHaveLength(0);
      const row = getPoolRow('pool-a');
      expect(row.status).toBe('available');
      expect(row.current_review_id).toBeNull();
    });

    it('resets entries in switching status even with valid review', async () => {
      const reviewId = seedReview(100);
      await repo.create({ id: 'pool-a', repository: 'owner/repo', path: '/tmp/a' });
      await repo.markSwitching('pool-a');
      await repo.setCurrentReviewId('pool-a', reviewId);

      const preserved = await repo.resetStaleAndPreserve();

      expect(preserved).toHaveLength(0);
      const row = getPoolRow('pool-a');
      expect(row.status).toBe('available');
      expect(row.current_review_id).toBeNull();
    });

    it('resets entries whose review has been deleted', async () => {
      await repo.create({ id: 'pool-a', repository: 'owner/repo', path: '/tmp/a' });
      await repo.markInUse('pool-a', 1);
      // Set review ID 999 which does not exist in reviews table
      await repo.setCurrentReviewId('pool-a', 999);

      const preserved = await repo.resetStaleAndPreserve();

      expect(preserved).toHaveLength(0);
      const row = getPoolRow('pool-a');
      expect(row.status).toBe('available');
      expect(row.current_review_id).toBeNull();
    });

    it('preserves in_use entries with valid review ownership', async () => {
      const reviewId = seedReview(100);
      await repo.create({ id: 'pool-a', repository: 'owner/repo', path: '/tmp/a' });
      await repo.markInUse('pool-a', 1);
      await repo.setCurrentReviewId('pool-a', reviewId);

      const preserved = await repo.resetStaleAndPreserve();

      expect(preserved).toHaveLength(1);
      expect(preserved[0].id).toBe('pool-a');
      expect(preserved[0].current_review_id).toBe(reviewId);
      // Entry should still be in_use
      const row = getPoolRow('pool-a');
      expect(row.status).toBe('in_use');
    });

    it('deletes creating placeholders instead of resetting them to available', async () => {
      await repo.reserveSlot('pool-creating', 'owner/repo', 5);

      const preserved = await repo.resetStaleAndPreserve();

      expect(preserved).toHaveLength(0);
      // Should be deleted entirely, not set to available
      const row = getPoolRow('pool-creating');
      expect(row).toBeUndefined();
    });

    it('handles mixed stale and valid entries', async () => {
      const reviewId = seedReview(100);
      // Valid: in_use with existing review
      await repo.create({ id: 'pool-a', repository: 'owner/repo', path: '/tmp/a' });
      await repo.markInUse('pool-a', 1);
      await repo.setCurrentReviewId('pool-a', reviewId);

      // Stale: in_use with no review
      await repo.create({ id: 'pool-b', repository: 'owner/repo', path: '/tmp/b' });
      await repo.markInUse('pool-b', 2);

      // Stale: switching
      await repo.create({ id: 'pool-c', repository: 'owner/repo', path: '/tmp/c' });
      await repo.markSwitching('pool-c');

      // Already available — should remain untouched
      await repo.create({ id: 'pool-d', repository: 'owner/repo', path: '/tmp/d' });

      const preserved = await repo.resetStaleAndPreserve();

      expect(preserved).toHaveLength(1);
      expect(preserved[0].id).toBe('pool-a');

      expect(getPoolRow('pool-a').status).toBe('in_use');
      expect(getPoolRow('pool-b').status).toBe('available');
      expect(getPoolRow('pool-c').status).toBe('available');
      expect(getPoolRow('pool-d').status).toBe('available');
    });
  });
});
