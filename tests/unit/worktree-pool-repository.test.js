// Copyright 2026 Tim Perkins (tjwp) | SPDX-License-Identifier: Apache-2.0
import { describe, it, expect, beforeEach, afterEach } from 'vitest';

const { WorktreePoolRepository, WorktreeRepository } = require('../../src/database');
const { createTestDatabase, closeTestDatabase } = require('../utils/schema');

/** The process the tests claim as. */
const SELF = 1001;
/** Another live pair-review process sharing the database. */
const PEER = 2002;

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

  /**
   * Test setup only: put a row into an exact state with direct SQL, bypassing
   * the repository's conditional transitions.
   */
  function setRow(id, fields) {
    const cols = Object.keys(fields);
    db.prepare(`UPDATE worktree_pool SET ${cols.map(c => `${c} = ?`).join(', ')} WHERE id = ?`)
      .run(...cols.map(c => fields[c]), id);
  }

  /** Test setup only: mark a row in_use for a PR, held by `holder`. */
  function putInUse(id, prNumber, { holder = SELF, reviewId = null } = {}) {
    setRow(id, {
      status: 'in_use', current_pr_number: prNumber, current_review_id: reviewId,
      holder_pid: holder, holder_claimed_at: holder == null ? null : '2026-01-01T00:00:00.000Z',
      last_switched_at: '2026-01-01T00:00:00.000Z',
    });
  }

  /** Test setup only: mark a row switching, held by `holder`. */
  function putSwitching(id, { holder = SELF } = {}) {
    setRow(id, { status: 'switching', holder_pid: holder, holder_claimed_at: '2026-01-01T00:00:00.000Z' });
  }

  /** Assert `op` resolves false and leaves the row byte-identical. */
  async function expectRefusedNoWrite(id, op) {
    const before = getPoolRow(id);
    await expect(op()).resolves.toBe(false);
    expect(getPoolRow(id)).toEqual(before);
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
      await repo.create({ id: 'pool-abc', repository: 'owner/repo', path: '/tmp/pool-abc', prNumber: 42, holderPid: SELF });

      const row = getPoolRow('pool-abc');
      expect(row).toBeTruthy();
      expect(row.status).toBe('in_use');
      expect(row.current_pr_number).toBe(42);
      expect(row.last_switched_at).toBeTruthy();
      expect(row.created_at).toBeTruthy();
      expect(row.holder_pid).toBe(SELF);
      expect(row.holder_claimed_at).toBe(row.last_switched_at);
    });

    it('stamps no holder on an available insert', async () => {
      await repo.create({ id: 'pool-abc', repository: 'owner/repo', path: '/tmp/pool-abc', holderPid: SELF });

      const row = getPoolRow('pool-abc');
      expect(row.holder_pid === null).toBe(true);
      expect(row.holder_claimed_at === null).toBe(true);
    });

    it('requires a holderPid for an in_use insert', async () => {
      await expect(repo.create({ id: 'pool-abc', repository: 'owner/repo', path: '/tmp/pool-abc', prNumber: 42 }))
        .rejects.toThrow(TypeError);
      expect(getPoolRow('pool-abc')).toBeUndefined();
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
      putInUse('pool-a', 42);

      const result = await repo.findAvailable('owner/repo');
      expect(result).toBeUndefined();
    });
  });

  // ── findByPR ────────────────────────────────────────────────────────────
  describe('findByPR', () => {
    it('finds a pool entry by PR number and repository', async () => {
      await repo.create({ id: 'pool-x', repository: 'owner/repo', path: '/tmp/x' });
      putInUse('pool-x', 77);

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

  // ── holderPid validation ────────────────────────────────────────────
  describe('holderPid validation', () => {
    const invalid = [['undefined', undefined], ['null', null], ['zero', 0], ['negative', -1], ['float', 1.5], ['string', '1001']];
    const calls = {
      reserveSlot: (pid) => repo.reserveSlot('pool-new', 'owner/repo', 3, pid),
      finalizeReservation: (pid) => repo.finalizeReservation('pool-a', '/tmp/x', 1, pid),
      claimAvailable: (pid) => repo.claimAvailable('owner/repo', pid),
      claimByPR: (pid) => repo.claimByPR(1, 'owner/repo', pid),
      reclaimAvailableForPR: (pid) => repo.reclaimAvailableForPR('pool-a', 1, pid),
      markInUse: (pid) => repo.markInUse('pool-a', 1, pid, 'switching'),
      markAvailable: (pid) => repo.markAvailable('pool-a', pid),
      abandonSwitch: (pid) => repo.abandonSwitch('pool-a', pid),
      resetStaleAndPreserve: (pid) => repo.resetStaleAndPreserve(pid, () => true),
    };

    for (const [method, call] of Object.entries(calls)) {
      it.each(invalid)(`${method} throws TypeError for a %s holderPid and writes nothing`, async (_label, pid) => {
        await repo.create({ id: 'pool-a', repository: 'owner/repo', path: '/tmp/a' });
        putInUse('pool-a', 1);
        const before = db.prepare('SELECT * FROM worktree_pool ORDER BY id').all();

        await expect(call(pid)).rejects.toThrow(TypeError);

        expect(db.prepare('SELECT * FROM worktree_pool ORDER BY id').all()).toEqual(before);
      });
    }
  });

  // ── markInUse ───────────────────────────────────────────────────────────
  describe('markInUse', () => {
    describe("fromStatus 'switching'", () => {
      it('marks a switching row held by the caller in_use for the PR', async () => {
        await repo.create({ id: 'pool-a', repository: 'owner/repo', path: '/tmp/a' });
        putSwitching('pool-a');
        setRow('pool-a', { current_review_id: 9 });

        await expect(repo.markInUse('pool-a', 42, SELF, 'switching')).resolves.toBe(true);

        const row = getPoolRow('pool-a');
        expect(row.status).toBe('in_use');
        expect(row.current_pr_number).toBe(42);
        expect(row.last_switched_at > '2026-01-01T00:00:00.000Z').toBe(true);
        expect(row.current_review_id === null).toBe(true);
        expect(row.holder_pid).toBe(SELF);
      });

      it('refuses a switching row held by another process', async () => {
        await repo.create({ id: 'pool-a', repository: 'owner/repo', path: '/tmp/a' });
        putSwitching('pool-a', { holder: PEER });

        await expectRefusedNoWrite('pool-a', () => repo.markInUse('pool-a', 42, SELF, 'switching'));
      });

      it.each([
        ['available', (id) => setRow(id, { holder_pid: null })],
        ['in_use (held by caller)', (id) => putInUse(id, 42)],
        ['creating (held by caller)', (id) => setRow(id, { status: 'creating', holder_pid: SELF })],
      ])('refuses a row that is %s', async (_label, arrange) => {
        await repo.create({ id: 'pool-a', repository: 'owner/repo', path: '/tmp/a' });
        arrange('pool-a');

        await expectRefusedNoWrite('pool-a', () => repo.markInUse('pool-a', 42, SELF, 'switching'));
      });
    });

    describe("fromStatus 'in_use' (refresh)", () => {
      it('re-stamps an in_use row for the same PR held by the caller', async () => {
        await repo.create({ id: 'pool-a', repository: 'owner/repo', path: '/tmp/a' });
        putInUse('pool-a', 42, { reviewId: 7 });

        await expect(repo.markInUse('pool-a', 42, SELF, 'in_use')).resolves.toBe(true);

        const row = getPoolRow('pool-a');
        expect(row.status).toBe('in_use');
        expect(row.current_pr_number).toBe(42);
        expect(row.last_switched_at > '2026-01-01T00:00:00.000Z').toBe(true);
        expect(row.current_review_id === null).toBe(true);
        expect(row.holder_pid).toBe(SELF);
      });

      it('refuses an in_use row held by another process', async () => {
        await repo.create({ id: 'pool-a', repository: 'owner/repo', path: '/tmp/a' });
        putInUse('pool-a', 42, { holder: PEER });

        await expectRefusedNoWrite('pool-a', () => repo.markInUse('pool-a', 42, SELF, 'in_use'));
      });

      it('refuses an in_use row held by the caller for a different PR', async () => {
        await repo.create({ id: 'pool-a', repository: 'owner/repo', path: '/tmp/a' });
        putInUse('pool-a', 99);

        await expectRefusedNoWrite('pool-a', () => repo.markInUse('pool-a', 42, SELF, 'in_use'));
      });

      it('refuses a row that was freed (available) during the refresh', async () => {
        await repo.create({ id: 'pool-a', repository: 'owner/repo', path: '/tmp/a' });
        setRow('pool-a', { current_pr_number: 42 });

        await expectRefusedNoWrite('pool-a', () => repo.markInUse('pool-a', 42, SELF, 'in_use'));
      });

      it('refuses a row a peer is switching', async () => {
        await repo.create({ id: 'pool-a', repository: 'owner/repo', path: '/tmp/a' });
        setRow('pool-a', { current_pr_number: 42 });
        putSwitching('pool-a', { holder: PEER });

        await expectRefusedNoWrite('pool-a', () => repo.markInUse('pool-a', 42, SELF, 'in_use'));
      });
    });

    it('throws TypeError for an unknown fromStatus and writes nothing', async () => {
      await repo.create({ id: 'pool-a', repository: 'owner/repo', path: '/tmp/a' });
      putSwitching('pool-a');
      const before = getPoolRow('pool-a');

      await expect(repo.markInUse('pool-a', 42, SELF)).rejects.toThrow(TypeError);
      await expect(repo.markInUse('pool-a', 42, SELF, 'available')).rejects.toThrow(TypeError);

      expect(getPoolRow('pool-a')).toEqual(before);
    });
  });

  // ── reclaimAvailableForPR ───────────────────────────────────────────────
  describe('reclaimAvailableForPR', () => {
    it('takes an available row still carrying the PR into use for the caller', async () => {
      await repo.create({ id: 'pool-a', repository: 'owner/repo', path: '/tmp/a' });
      setRow('pool-a', { current_pr_number: 42 });

      await expect(repo.reclaimAvailableForPR('pool-a', 42, SELF)).resolves.toBe(true);

      const row = getPoolRow('pool-a');
      expect(row.status).toBe('in_use');
      expect(row.current_pr_number).toBe(42);
      expect(row.last_switched_at).toBeTruthy();
      expect(row.current_review_id === null).toBe(true);
      expect(row.holder_pid).toBe(SELF);
      expect(row.holder_claimed_at).toBe(row.last_switched_at);
    });

    it('refuses an available row that now carries a different PR', async () => {
      await repo.create({ id: 'pool-a', repository: 'owner/repo', path: '/tmp/a' });
      setRow('pool-a', { current_pr_number: 99 });

      await expectRefusedNoWrite('pool-a', () => repo.reclaimAvailableForPR('pool-a', 42, SELF));
    });

    it.each([
      ['in_use by a peer', (id) => putInUse(id, 42, { holder: PEER, reviewId: 5 })],
      ['switching by a peer', (id) => { setRow(id, { current_pr_number: 42 }); putSwitching(id, { holder: PEER }); }],
      ['creating', (id) => setRow(id, { status: 'creating', current_pr_number: 42, holder_pid: PEER })],
    ])('refuses a row that is %s', async (_label, arrange) => {
      await repo.create({ id: 'pool-a', repository: 'owner/repo', path: '/tmp/a' });
      arrange('pool-a');

      await expectRefusedNoWrite('pool-a', () => repo.reclaimAvailableForPR('pool-a', 42, SELF));
    });

    it('returns false for an unknown id', async () => {
      await expect(repo.reclaimAvailableForPR('nope', 42, SELF)).resolves.toBe(false);
    });
  });

  // ── markAvailable ───────────────────────────────────────────────────────
  describe('markAvailable', () => {
    it('releases an in_use row held by the caller, clearing review and holder', async () => {
      await repo.create({ id: 'pool-a', repository: 'owner/repo', path: '/tmp/a' });
      putInUse('pool-a', 42, { reviewId: 100 });

      await expect(repo.markAvailable('pool-a', SELF)).resolves.toBe(true);

      const row = getPoolRow('pool-a');
      expect(row.status).toBe('available');
      expect(row.current_review_id === null).toBe(true);
      expect(row.holder_pid === null).toBe(true);
      expect(row.holder_claimed_at === null).toBe(true);
      // The PR association survives so the reclaim fast path can find it
      expect(row.current_pr_number).toBe(42);
    });

    it('refuses an in_use row held by another process', async () => {
      await repo.create({ id: 'pool-a', repository: 'owner/repo', path: '/tmp/a' });
      putInUse('pool-a', 42, { holder: PEER, reviewId: 100 });

      await expectRefusedNoWrite('pool-a', () => repo.markAvailable('pool-a', SELF));
    });

    it('refuses an in_use row with no recorded holder', async () => {
      await repo.create({ id: 'pool-a', repository: 'owner/repo', path: '/tmp/a' });
      putInUse('pool-a', 42, { holder: null });

      await expectRefusedNoWrite('pool-a', () => repo.markAvailable('pool-a', SELF));
    });

    it.each([
      ['switching (held by caller)', (id) => putSwitching(id)],
      ['creating (held by caller)', (id) => setRow(id, { status: 'creating', holder_pid: SELF })],
      ['already available', () => {}],
    ])('refuses a row that is %s', async (_label, arrange) => {
      await repo.create({ id: 'pool-a', repository: 'owner/repo', path: '/tmp/a' });
      arrange('pool-a');

      await expectRefusedNoWrite('pool-a', () => repo.markAvailable('pool-a', SELF));
    });
  });

  // ── abandonSwitch ───────────────────────────────────────────────────────
  describe('abandonSwitch', () => {
    it('returns a switching row held by the caller to available, clearing review and holder', async () => {
      await repo.create({ id: 'pool-a', repository: 'owner/repo', path: '/tmp/a' });
      putSwitching('pool-a');
      setRow('pool-a', { current_review_id: 4 });

      await expect(repo.abandonSwitch('pool-a', SELF)).resolves.toBe(true);

      const row = getPoolRow('pool-a');
      expect(row.status).toBe('available');
      expect(row.current_review_id === null).toBe(true);
      expect(row.holder_pid === null).toBe(true);
      expect(row.holder_claimed_at === null).toBe(true);
    });

    it('refuses a switching row held by another process', async () => {
      await repo.create({ id: 'pool-a', repository: 'owner/repo', path: '/tmp/a' });
      putSwitching('pool-a', { holder: PEER });

      await expectRefusedNoWrite('pool-a', () => repo.abandonSwitch('pool-a', SELF));
    });

    it.each([
      ['in_use (held by caller)', (id) => putInUse(id, 42)],
      ['available', () => {}],
    ])('refuses a row that is %s', async (_label, arrange) => {
      await repo.create({ id: 'pool-a', repository: 'owner/repo', path: '/tmp/a' });
      arrange('pool-a');

      await expectRefusedNoWrite('pool-a', () => repo.abandonSwitch('pool-a', SELF));
    });
  });

  // ── forceMarkAvailable ──────────────────────────────────────────────────
  describe('forceMarkAvailable', () => {
    it.each([
      ['in_use by a peer', (id) => putInUse(id, 42, { holder: PEER, reviewId: 100 })],
      ['in_use by the caller', (id) => putInUse(id, 42, { reviewId: 100 })],
      ['in_use with no holder', (id) => putInUse(id, 42, { holder: null, reviewId: 100 })],
    ])('unconditionally frees a row that is %s, clearing review and holder', async (_label, arrange) => {
      await repo.create({ id: 'pool-a', repository: 'owner/repo', path: '/tmp/a' });
      arrange('pool-a');

      await repo.forceMarkAvailable('pool-a');

      const row = getPoolRow('pool-a');
      expect(row.status).toBe('available');
      expect(row.current_review_id === null).toBe(true);
      expect(row.holder_pid === null).toBe(true);
      expect(row.holder_claimed_at === null).toBe(true);
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

    it('also stamps last_fetch_attempt_at and clears the failure streak', async () => {
      await repo.create({ id: 'pool-a', repository: 'owner/repo', path: '/tmp/a' });
      await repo.recordFetchFailure('pool-a');
      await repo.recordFetchFailure('pool-a');
      expect(getPoolRow('pool-a').fetch_failure_count).toBe(2);

      await repo.updateLastFetched('pool-a');

      const after = getPoolRow('pool-a');
      expect(after.fetch_failure_count).toBe(0);
      expect(after.last_fetch_attempt_at).toBe(after.last_fetched_at);
    });

    it('only touches the requested entry', async () => {
      await repo.create({ id: 'pool-a', repository: 'owner/repo', path: '/tmp/a' });
      await repo.create({ id: 'pool-b', repository: 'owner/repo', path: '/tmp/b' });
      await repo.recordFetchFailure('pool-b');

      await repo.updateLastFetched('pool-a');

      expect(getPoolRow('pool-b').last_fetched_at).toBeNull();
      expect(getPoolRow('pool-b').fetch_failure_count).toBe(1);
    });
  });

  // ── recordFetchAttempt ──────────────────────────────────────────────────
  describe('recordFetchAttempt', () => {
    it('stamps last_fetch_attempt_at without touching last_fetched_at', async () => {
      await repo.create({ id: 'pool-a', repository: 'owner/repo', path: '/tmp/a' });

      await repo.recordFetchAttempt('pool-a');

      const row = getPoolRow('pool-a');
      expect(row.last_fetch_attempt_at).toBeTruthy();
      expect(row.last_fetched_at).toBeNull();
      expect(row.fetch_failure_count).toBe(0);
    });

    it('overwrites an earlier attempt timestamp', async () => {
      await repo.create({ id: 'pool-a', repository: 'owner/repo', path: '/tmp/a' });
      db.prepare(`UPDATE worktree_pool SET last_fetch_attempt_at = '2020-01-01T00:00:00.000Z' WHERE id = 'pool-a'`).run();

      await repo.recordFetchAttempt('pool-a');

      expect(getPoolRow('pool-a').last_fetch_attempt_at > '2020-01-01T00:00:00.000Z').toBe(true);
    });

    it('is a no-op for an unknown id', async () => {
      await expect(repo.recordFetchAttempt('nope')).resolves.not.toThrow();
    });
  });

  // ── recordFetchFailure ──────────────────────────────────────────────────
  describe('recordFetchFailure', () => {
    it('increments the consecutive failure count', async () => {
      await repo.create({ id: 'pool-a', repository: 'owner/repo', path: '/tmp/a' });
      expect(getPoolRow('pool-a').fetch_failure_count).toBe(0);

      await repo.recordFetchFailure('pool-a');
      expect(getPoolRow('pool-a').fetch_failure_count).toBe(1);

      await repo.recordFetchFailure('pool-a');
      expect(getPoolRow('pool-a').fetch_failure_count).toBe(2);
    });

    it('does not stamp last_fetched_at', async () => {
      await repo.create({ id: 'pool-a', repository: 'owner/repo', path: '/tmp/a' });
      await repo.recordFetchFailure('pool-a');
      expect(getPoolRow('pool-a').last_fetched_at).toBeNull();
    });

    it('re-stamps last_fetch_attempt_at so backoff runs from the failure', async () => {
      await repo.create({ id: 'pool-a', repository: 'owner/repo', path: '/tmp/a' });
      // A slow failure would otherwise burn its own cooldown: the attempt was
      // stamped when the fetch started, long before it gave up.
      await repo.recordFetchAttempt('pool-a');
      db.prepare(`UPDATE worktree_pool SET last_fetch_attempt_at = '2020-01-01T00:00:00.000Z' WHERE id = 'pool-a'`).run();

      await repo.recordFetchFailure('pool-a');

      const row = getPoolRow('pool-a');
      expect(row.last_fetch_attempt_at > '2020-01-01T00:00:00.000Z').toBe(true);
      expect(row.fetch_failure_count).toBe(1);
    });

    it('is a no-op for an unknown id', async () => {
      await expect(repo.recordFetchFailure('nope')).resolves.not.toThrow();
    });
  });

  // ── findIdleForRepo ─────────────────────────────────────────────────────
  describe('findIdleForRepo', () => {
    it('returns only available entries for the repository', async () => {
      await repo.create({ id: 'pool-a', repository: 'owner/repo', path: '/tmp/a' });
      await repo.create({ id: 'pool-b', repository: 'owner/repo', path: '/tmp/b' });
      putInUse('pool-b', 10);

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
      putInUse('pool-b', 10);

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
      putSwitching('pool-c');

      // Give pool-b a fetched_at so pool-a (NULL) comes first
      await repo.updateLastFetched('pool-b');

      const result = await repo.findAllForFetch('owner/repo');
      expect(result).toHaveLength(2); // pool-c excluded (switching)
      expect(result[0].id).toBe('pool-a'); // NULL last_fetched_at first
      expect(result[1].id).toBe('pool-b');
    });

    it('selects the backoff columns the fetch scheduler needs', async () => {
      await repo.create({ id: 'pool-a', repository: 'owner/repo', path: '/tmp/a' });
      await repo.recordFetchAttempt('pool-a');
      await repo.recordFetchFailure('pool-a');

      const [row] = await repo.findAllForFetch('owner/repo');
      expect(row.last_fetch_attempt_at).toBeTruthy();
      expect(row.fetch_failure_count).toBe(1);
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
      putInUse('pool-a', 42);

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
      putInUse('pool-a', 42);
      await repo.markAvailable('pool-a', SELF);

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
      putInUse('pool-a', 42);
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
      putInUse('pool-a', 42);
      await repo.setCurrentReviewId('pool-a', 100);
      await repo.markAvailable('pool-a', SELF);

      const result = await repo.findByReviewId(100);
      // markAvailable clears current_review_id, so this should be undefined
      expect(result).toBeUndefined();
    });

    it('returns undefined when worktree is switching', async () => {
      await repo.create({ id: 'pool-a', repository: 'owner/repo', path: '/tmp/a' });
      putInUse('pool-a', 42);
      await repo.setCurrentReviewId('pool-a', 100);
      putSwitching('pool-a');

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
    it('inserts a placeholder row with status creating, held by the caller, when under capacity', async () => {
      const result = await repo.reserveSlot('pool-new', 'owner/repo', 3, SELF);

      expect(result).toBe(true);
      const row = getPoolRow('pool-new');
      expect(row).toBeTruthy();
      expect(row.status).toBe('creating');
      expect(row.repository).toBe('owner/repo');
      expect(row.path).toBe('__creating__pool-new');
      expect(row.current_pr_number).toBeNull();
      expect(row.created_at).toBeTruthy();
      expect(row.holder_pid).toBe(SELF);
      expect(row.holder_claimed_at).toBe(row.created_at);
    });

    it('returns false when at capacity', async () => {
      await repo.create({ id: 'pool-a', repository: 'owner/repo', path: '/tmp/a' });
      await repo.create({ id: 'pool-b', repository: 'owner/repo', path: '/tmp/b' });
      await repo.create({ id: 'pool-c', repository: 'owner/repo', path: '/tmp/c' });

      const result = await repo.reserveSlot('pool-new', 'owner/repo', 3, SELF);

      expect(result).toBe(false);
      const row = getPoolRow('pool-new');
      expect(row).toBeUndefined();
    });

    it('counts creating entries toward capacity', async () => {
      await repo.create({ id: 'pool-a', repository: 'owner/repo', path: '/tmp/a' });
      await repo.create({ id: 'pool-b', repository: 'owner/repo', path: '/tmp/b' });
      // Reserve a third slot (creating status)
      await repo.reserveSlot('pool-c', 'owner/repo', 3, SELF);

      // Fourth slot should be rejected
      const result = await repo.reserveSlot('pool-d', 'owner/repo', 3, SELF);

      expect(result).toBe(false);
    });

    it('is case-insensitive on repository', async () => {
      await repo.create({ id: 'pool-a', repository: 'Owner/Repo', path: '/tmp/a' });

      const result = await repo.reserveSlot('pool-new', 'owner/repo', 2, SELF);

      expect(result).toBe(true);
    });

    it('does not count entries from other repositories', async () => {
      await repo.create({ id: 'pool-a', repository: 'other/repo', path: '/tmp/a' });
      await repo.create({ id: 'pool-b', repository: 'other/repo', path: '/tmp/b' });
      await repo.create({ id: 'pool-c', repository: 'other/repo', path: '/tmp/c' });

      const result = await repo.reserveSlot('pool-new', 'owner/repo', 2, SELF);

      expect(result).toBe(true);
    });
  });

  // ── finalizeReservation ─────────────────────────────────────────────────
  describe('finalizeReservation', () => {
    it('updates the caller\'s placeholder to in_use with path and PR number', async () => {
      await repo.reserveSlot('pool-new', 'owner/repo', 3, SELF);

      await expect(repo.finalizeReservation('pool-new', '/tmp/pool-new', 42, SELF)).resolves.toBe(true);

      const row = getPoolRow('pool-new');
      expect(row.status).toBe('in_use');
      expect(row.path).toBe('/tmp/pool-new');
      expect(row.current_pr_number).toBe(42);
      expect(row.last_switched_at).toBeTruthy();
      expect(row.holder_pid).toBe(SELF);
    });

    it('does not update non-creating entries', async () => {
      await repo.create({ id: 'pool-a', repository: 'owner/repo', path: '/tmp/a' });

      await expectRefusedNoWrite('pool-a', () => repo.finalizeReservation('pool-a', '/tmp/new-path', 99, SELF));
    });

    it('refuses a placeholder held by another process', async () => {
      await repo.reserveSlot('pool-new', 'owner/repo', 3, PEER);

      await expectRefusedNoWrite('pool-new', () => repo.finalizeReservation('pool-new', '/tmp/pool-new', 42, SELF));
    });

    it('returns false when the placeholder is gone', async () => {
      await expect(repo.finalizeReservation('pool-gone', '/tmp/pool-gone', 42, SELF)).resolves.toBe(false);
      expect(getPoolRow('pool-gone')).toBeUndefined();
    });
  });

  // ── deleteReservation ───────────────────────────────────────────────────
  describe('deleteReservation', () => {
    it('removes a creating placeholder', async () => {
      await repo.reserveSlot('pool-new', 'owner/repo', 3, SELF);

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
    it('atomically claims an available row for the PR, stamping the caller as holder', async () => {
      await repo.create({ id: 'pool-a', repository: 'owner/repo', path: '/tmp/a' });
      setRow('pool-a', { current_pr_number: 42, current_review_id: 3 });

      const result = await repo.claimByPR(42, 'owner/repo', SELF);

      expect(result).toBeTruthy();
      expect(result.id).toBe('pool-a');
      expect(result.previousHolderPid).toBeNull();
      expect(result).not.toHaveProperty('holder_pid');
      const row = getPoolRow('pool-a');
      expect(row.status).toBe('in_use');
      expect(row.current_pr_number).toBe(42);
      expect(row.last_switched_at).toBeTruthy();
      expect(row.current_review_id).toBeNull();
      expect(row.holder_pid).toBe(SELF);
      expect(row.holder_claimed_at).toBe(row.last_switched_at);
    });

    it('returns null when no entry matches the PR', async () => {
      await repo.create({ id: 'pool-a', repository: 'owner/repo', path: '/tmp/a' });

      const result = await repo.claimByPR(999, 'owner/repo', SELF);

      expect(result).toBeNull();
    });

    it('claims entry even if it was already in_use for same PR by the caller (no previous holder reported)', async () => {
      await repo.create({ id: 'pool-a', repository: 'owner/repo', path: '/tmp/a' });
      putInUse('pool-a', 77);

      const result = await repo.claimByPR(77, 'owner/repo', SELF);

      expect(result).toBeTruthy();
      expect(result.id).toBe('pool-a');
      expect(result.previousHolderPid).toBeNull();
      const row = getPoolRow('pool-a');
      expect(row.status).toBe('in_use');
      expect(row.holder_pid).toBe(SELF);
    });

    it('takes a same-PR row from another process and reports that pid as previousHolderPid', async () => {
      await repo.create({ id: 'pool-a', repository: 'owner/repo', path: '/tmp/a' });
      putInUse('pool-a', 77, { holder: PEER, reviewId: 8 });

      const result = await repo.claimByPR(77, 'owner/repo', SELF);

      expect(result.id).toBe('pool-a');
      expect(result.previousHolderPid).toBe(PEER);
      const row = getPoolRow('pool-a');
      expect(row.holder_pid).toBe(SELF);
      expect(row.current_review_id).toBeNull();
    });

    it('is case-insensitive on repository', async () => {
      await repo.create({ id: 'pool-a', repository: 'Owner/Repo', path: '/tmp/a' });
      putInUse('pool-a', 10);

      const result = await repo.claimByPR(10, 'owner/repo', SELF);

      expect(result).toBeTruthy();
      expect(result.id).toBe('pool-a');
    });

    it('does not claim a worktree in switching state', async () => {
      await repo.create({ id: 'pool-a', repository: 'owner/repo', path: '/tmp/a' });
      setRow('pool-a', { current_pr_number: 42 });
      putSwitching('pool-a', { holder: PEER });
      const before = getPoolRow('pool-a');

      const result = await repo.claimByPR(42, 'owner/repo', SELF);

      expect(result).toBeNull();
      expect(getPoolRow('pool-a')).toEqual(before);
    });

    it('does not claim a worktree in creating state', async () => {
      await repo.create({ id: 'pool-a', repository: 'owner/repo', path: '/tmp/a' });
      setRow('pool-a', { status: 'creating', current_pr_number: 42, holder_pid: PEER });
      const before = getPoolRow('pool-a');

      const result = await repo.claimByPR(42, 'owner/repo', SELF);

      expect(result).toBeNull();
      expect(getPoolRow('pool-a')).toEqual(before);
    });

    it('claims available worktree with matching PR over switching one', async () => {
      // Two entries for the same PR: one switching, one available
      await repo.create({ id: 'pool-a', repository: 'owner/repo', path: '/tmp/a' });
      setRow('pool-a', { current_pr_number: 55 });
      putSwitching('pool-a', { holder: PEER });

      await repo.create({ id: 'pool-b', repository: 'owner/repo', path: '/tmp/b' });
      setRow('pool-b', { current_pr_number: 55 });

      const result = await repo.claimByPR(55, 'owner/repo', SELF);

      expect(result).toBeTruthy();
      expect(result.id).toBe('pool-b');
      // pool-a should still be switching under the peer
      expect(getPoolRow('pool-a').status).toBe('switching');
      expect(getPoolRow('pool-a').holder_pid).toBe(PEER);
    });
  });

  // ── claimAvailable ──────────────────────────────────────────────────────
  describe('claimAvailable', () => {
    it('atomically finds LRU available entry and marks it switching, held by the caller', async () => {
      await repo.create({ id: 'pool-a', repository: 'owner/repo', path: '/tmp/a' });
      await repo.create({ id: 'pool-b', repository: 'owner/repo', path: '/tmp/b' });
      db.prepare("UPDATE worktree_pool SET last_switched_at = '2026-01-02T00:00:00Z' WHERE id = 'pool-a'").run();
      db.prepare("UPDATE worktree_pool SET last_switched_at = '2026-01-01T00:00:00Z' WHERE id = 'pool-b'").run();
      const beforeA = getPoolRow('pool-a');

      const result = await repo.claimAvailable('owner/repo', SELF);

      expect(result).toBeTruthy();
      // Should pick pool-b (oldest last_switched_at)
      expect(result.id).toBe('pool-b');
      // After claim, pool-b should be switching under the caller
      const row = getPoolRow('pool-b');
      expect(row.status).toBe('switching');
      expect(row.holder_pid).toBe(SELF);
      expect(row.holder_claimed_at).toBeTruthy();
      // pool-a should be untouched
      expect(getPoolRow('pool-a')).toEqual(beforeA);
    });

    it('prefers NULL last_switched_at (never used) over oldest', async () => {
      await repo.create({ id: 'pool-a', repository: 'owner/repo', path: '/tmp/a' });
      await repo.create({ id: 'pool-b', repository: 'owner/repo', path: '/tmp/b' });
      db.prepare("UPDATE worktree_pool SET last_switched_at = '2026-01-01T00:00:00Z' WHERE id = 'pool-b'").run();

      const result = await repo.claimAvailable('owner/repo', SELF);

      expect(result).toBeTruthy();
      expect(result.id).toBe('pool-a'); // NULL comes first
    });

    it('returns null when no available entries', async () => {
      await repo.create({ id: 'pool-a', repository: 'owner/repo', path: '/tmp/a' });
      putInUse('pool-a', 10, { holder: PEER });
      const before = getPoolRow('pool-a');

      const result = await repo.claimAvailable('owner/repo', SELF);

      expect(result).toBeNull();
      expect(getPoolRow('pool-a')).toEqual(before);
    });

    it('does not claim entries from other repositories', async () => {
      await repo.create({ id: 'pool-a', repository: 'other/repo', path: '/tmp/a' });

      const result = await repo.claimAvailable('owner/repo', SELF);

      expect(result).toBeNull();
      // other/repo entry should remain available
      const row = getPoolRow('pool-a');
      expect(row.status).toBe('available');
    });

    it('is case-insensitive on repository', async () => {
      await repo.create({ id: 'pool-a', repository: 'Owner/Repo', path: '/tmp/a' });

      const result = await repo.claimAvailable('owner/repo', SELF);

      expect(result).toBeTruthy();
      expect(result.id).toBe('pool-a');
    });

    it('second concurrent claim gets null when only one slot is available', async () => {
      await repo.create({ id: 'pool-a', repository: 'owner/repo', path: '/tmp/a' });

      // First claim succeeds
      const first = await repo.claimAvailable('owner/repo', SELF);
      expect(first).toBeTruthy();
      expect(first.id).toBe('pool-a');

      // Second claim (a peer) finds nothing (pool-a is now switching)
      const second = await repo.claimAvailable('owner/repo', PEER);
      expect(second).toBeNull();
      expect(getPoolRow('pool-a').holder_pid).toBe(SELF);
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

    const allDead = () => true;
    const allLive = () => false;

    it('resets dead-holder entries with no review owner', async () => {
      await repo.create({ id: 'pool-a', repository: 'owner/repo', path: '/tmp/a' });
      putInUse('pool-a', 1, { holder: PEER });

      const preserved = await repo.resetStaleAndPreserve(SELF, allDead);

      expect(preserved).toHaveLength(0);
      const row = getPoolRow('pool-a');
      expect(row.status).toBe('available');
      expect(row.current_review_id === null).toBe(true);
      expect(row.holder_pid === null).toBe(true);
      expect(row.holder_claimed_at === null).toBe(true);
    });

    it('resets dead-holder entries in switching status even with valid review', async () => {
      const reviewId = seedReview(100);
      await repo.create({ id: 'pool-a', repository: 'owner/repo', path: '/tmp/a' });
      putSwitching('pool-a', { holder: PEER });
      await repo.setCurrentReviewId('pool-a', reviewId);

      const preserved = await repo.resetStaleAndPreserve(SELF, allDead);

      expect(preserved).toHaveLength(0);
      const row = getPoolRow('pool-a');
      expect(row.status).toBe('available');
      expect(row.current_review_id === null).toBe(true);
      expect(row.holder_pid === null).toBe(true);
    });

    it('resets dead-holder entries whose review has been deleted', async () => {
      await repo.create({ id: 'pool-a', repository: 'owner/repo', path: '/tmp/a' });
      // Review ID 999 does not exist in reviews table
      putInUse('pool-a', 1, { holder: PEER, reviewId: 999 });

      const preserved = await repo.resetStaleAndPreserve(SELF, allDead);

      expect(preserved).toHaveLength(0);
      const row = getPoolRow('pool-a');
      expect(row.status).toBe('available');
      expect(row.current_review_id === null).toBe(true);
      expect(row.holder_pid === null).toBe(true);
    });

    it('preserves dead-holder in_use entries with valid review ownership and takes them over', async () => {
      const reviewId = seedReview(100);
      await repo.create({ id: 'pool-a', repository: 'owner/repo', path: '/tmp/a' });
      putInUse('pool-a', 1, { holder: PEER, reviewId });

      const preserved = await repo.resetStaleAndPreserve(SELF, allDead);

      expect(preserved).toEqual([{ id: 'pool-a', current_review_id: reviewId }]);
      const row = getPoolRow('pool-a');
      expect(row.status).toBe('in_use');
      expect(row.current_review_id).toBe(reviewId);
      expect(row.holder_pid).toBe(SELF);
      expect(row.holder_claimed_at > '2026-01-01T00:00:00.000Z').toBe(true);
    });

    it('deletes dead-holder creating placeholders instead of resetting them to available', async () => {
      await repo.reserveSlot('pool-creating', 'owner/repo', 5, PEER);

      const preserved = await repo.resetStaleAndPreserve(SELF, allDead);

      expect(preserved).toHaveLength(0);
      expect(getPoolRow('pool-creating')).toBeUndefined();
    });

    it('skips live-holder rows in every non-available state: no write, not returned', async () => {
      const reviewId = seedReview(100);
      await repo.reserveSlot('pool-creating', 'owner/repo', 10, PEER);
      await repo.create({ id: 'pool-switching', repository: 'owner/repo', path: '/tmp/s' });
      putSwitching('pool-switching', { holder: PEER });
      await repo.create({ id: 'pool-inuse-noreview', repository: 'owner/repo', path: '/tmp/n' });
      putInUse('pool-inuse-noreview', 2, { holder: PEER });
      await repo.create({ id: 'pool-inuse-review', repository: 'owner/repo', path: '/tmp/r' });
      putInUse('pool-inuse-review', 3, { holder: PEER, reviewId });
      const before = db.prepare('SELECT * FROM worktree_pool ORDER BY id').all();

      const preserved = await repo.resetStaleAndPreserve(SELF, allLive);

      expect(preserved).toEqual([]);
      expect(db.prepare('SELECT * FROM worktree_pool ORDER BY id').all()).toEqual(before);
      expect(getPoolRow('pool-inuse-review').holder_pid).toBe(PEER);
    });

    it('passes each non-available row (with holder columns) to the predicate, never available rows', async () => {
      await repo.create({ id: 'pool-avail', repository: 'owner/repo', path: '/tmp/av' });
      await repo.create({ id: 'pool-a', repository: 'owner/repo', path: '/tmp/a' });
      putInUse('pool-a', 1, { holder: PEER, reviewId: 5 });
      const seen = [];

      await repo.resetStaleAndPreserve(SELF, (row) => { seen.push(row); return false; });

      expect(seen).toEqual([{
        id: 'pool-a', status: 'in_use', current_review_id: 5,
        holder_pid: PEER, holder_claimed_at: '2026-01-01T00:00:00.000Z',
      }]);
    });

    it('takes over a legacy NULL-holder in_use row with a live review, which self can then release', async () => {
      const reviewId = seedReview(100);
      await repo.create({ id: 'pool-a', repository: 'owner/repo', path: '/tmp/a' });
      putInUse('pool-a', 1, { holder: null, reviewId });
      // Legacy rows have no holder: self cannot release them before startup
      await expectRefusedNoWrite('pool-a', () => repo.markAvailable('pool-a', SELF));

      const preserved = await repo.resetStaleAndPreserve(SELF, (row) => row.holder_pid == null);

      expect(preserved).toEqual([{ id: 'pool-a', current_review_id: reviewId }]);
      expect(getPoolRow('pool-a').holder_pid).toBe(SELF);
      await expect(repo.markAvailable('pool-a', SELF)).resolves.toBe(true);
      expect(getPoolRow('pool-a').status).toBe('available');
    });

    it('leaves a legacy row untouched when the predicate says its holder is alive', async () => {
      const reviewId = seedReview(100);
      await repo.create({ id: 'pool-a', repository: 'owner/repo', path: '/tmp/a' });
      putInUse('pool-a', 1, { holder: null, reviewId });
      const before = getPoolRow('pool-a');

      const preserved = await repo.resetStaleAndPreserve(SELF, allLive);

      expect(preserved).toEqual([]);
      expect(getPoolRow('pool-a')).toEqual(before);
      expect(getPoolRow('pool-a').holder_pid === null).toBe(true);
    });

    it('handles mixed live, dead and available entries', async () => {
      const reviewId = seedReview(100);
      // Dead holder, in_use with existing review -> taken over
      await repo.create({ id: 'pool-a', repository: 'owner/repo', path: '/tmp/a' });
      putInUse('pool-a', 1, { holder: 3003, reviewId });
      // Dead holder, in_use with no review -> reset
      await repo.create({ id: 'pool-b', repository: 'owner/repo', path: '/tmp/b' });
      putInUse('pool-b', 2, { holder: 3003 });
      // Dead holder, switching -> reset
      await repo.create({ id: 'pool-c', repository: 'owner/repo', path: '/tmp/c' });
      putSwitching('pool-c', { holder: 3003 });
      // Already available -> untouched
      await repo.create({ id: 'pool-d', repository: 'owner/repo', path: '/tmp/d' });
      const beforeD = getPoolRow('pool-d');
      // Live peer, in_use with no review -> untouched
      await repo.create({ id: 'pool-e', repository: 'owner/repo', path: '/tmp/e' });
      putInUse('pool-e', 5, { holder: PEER });
      const beforeE = getPoolRow('pool-e');

      const preserved = await repo.resetStaleAndPreserve(SELF, (row) => row.holder_pid !== PEER);

      expect(preserved).toEqual([{ id: 'pool-a', current_review_id: reviewId }]);
      expect(getPoolRow('pool-a').status).toBe('in_use');
      expect(getPoolRow('pool-a').holder_pid).toBe(SELF);
      expect(getPoolRow('pool-b').status).toBe('available');
      expect(getPoolRow('pool-c').status).toBe('available');
      expect(getPoolRow('pool-d')).toEqual(beforeD);
      expect(getPoolRow('pool-e')).toEqual(beforeE);
    });

    it('throws TypeError when the predicate is not a function', async () => {
      await expect(repo.resetStaleAndPreserve(SELF)).rejects.toThrow(TypeError);
    });
  });
});
