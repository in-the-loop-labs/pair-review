// Copyright 2026 Tim Perkins (tjwp) | SPDX-License-Identifier: Apache-2.0
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

const path = require('path');

const { createTestDatabase, closeTestDatabase } = require('../utils/schema');
const logger = require('../../src/utils/logger');
const {
  startPoolBackgroundFetches,
  isPoolEntryDueForFetch,
  POOL_FETCH_TICK_MS,
  MAX_POOL_FETCH_BACKOFF_MS,
} = require('../../src/main');

const HOUR_MS = 60 * 60 * 1000;

describe('isPoolEntryDueForFetch', () => {
  const now = Date.parse('2026-01-01T12:00:00.000Z');
  const intervalMs = HOUR_MS;

  const at = (msAgo) => new Date(now - msAgo).toISOString();

  it('is due when never fetched and never attempted', () => {
    expect(isPoolEntryDueForFetch({}, intervalMs, now)).toBe(true);
  });

  it('is not due when fetched within the interval', () => {
    const entry = { last_fetched_at: at(HOUR_MS / 2), last_fetch_attempt_at: at(HOUR_MS / 2) };
    expect(isPoolEntryDueForFetch(entry, intervalMs, now)).toBe(false);
  });

  it('is due when the last success is older than the interval and there was no attempt', () => {
    const entry = { last_fetched_at: at(2 * HOUR_MS) };
    expect(isPoolEntryDueForFetch(entry, intervalMs, now)).toBe(true);
  });

  it('is not due when a failed attempt is still inside the backoff window', () => {
    const entry = { last_fetch_attempt_at: at(HOUR_MS / 2), fetch_failure_count: 1 };
    expect(isPoolEntryDueForFetch(entry, intervalMs, now)).toBe(false);
  });

  it('is due again once one interval has passed after a single failure', () => {
    const entry = { last_fetch_attempt_at: at(HOUR_MS + 1000), fetch_failure_count: 1 };
    expect(isPoolEntryDueForFetch(entry, intervalMs, now)).toBe(true);
  });

  it('doubles the backoff with each consecutive failure', () => {
    // 3 failures => 2^2 = 4 intervals
    const inside = { last_fetch_attempt_at: at(3 * HOUR_MS), fetch_failure_count: 3 };
    const outside = { last_fetch_attempt_at: at(4 * HOUR_MS + 1000), fetch_failure_count: 3 };
    expect(isPoolEntryDueForFetch(inside, intervalMs, now)).toBe(false);
    expect(isPoolEntryDueForFetch(outside, intervalMs, now)).toBe(true);
  });

  it('caps the backoff at MAX_POOL_FETCH_BACKOFF_MS', () => {
    // 20 failures would be astronomically long without the cap
    const entry = { last_fetch_attempt_at: at(MAX_POOL_FETCH_BACKOFF_MS + 1000), fetch_failure_count: 20 };
    expect(isPoolEntryDueForFetch(entry, intervalMs, now)).toBe(true);

    const stillWaiting = { last_fetch_attempt_at: at(MAX_POOL_FETCH_BACKOFF_MS - 1000), fetch_failure_count: 20 };
    expect(isPoolEntryDueForFetch(stillWaiting, intervalMs, now)).toBe(false);
  });

  it('uses a plain interval (no backoff) when the failure count is 0', () => {
    const entry = { last_fetch_attempt_at: at(HOUR_MS + 1000), fetch_failure_count: 0 };
    expect(isPoolEntryDueForFetch(entry, intervalMs, now)).toBe(true);

    const fresh = { last_fetch_attempt_at: at(HOUR_MS / 2), fetch_failure_count: 0 };
    expect(isPoolEntryDueForFetch(fresh, intervalMs, now)).toBe(false);
  });

  it('never backs off less than the configured interval', () => {
    // An 8h interval exceeds the 6h cap; capping below the interval would make
    // a failing entry retry more often than a healthy one.
    const eightHours = 8 * HOUR_MS;
    const waiting = { last_fetch_attempt_at: at(7 * HOUR_MS), fetch_failure_count: 1 };
    expect(isPoolEntryDueForFetch(waiting, eightHours, now)).toBe(false);

    const due = { last_fetch_attempt_at: at(eightHours + 1000), fetch_failure_count: 1 };
    expect(isPoolEntryDueForFetch(due, eightHours, now)).toBe(true);
  });

  it('honours a recent success even when the failure count is high', () => {
    const entry = {
      last_fetched_at: at(1000),
      last_fetch_attempt_at: at(10 * HOUR_MS),
      fetch_failure_count: 5,
    };
    expect(isPoolEntryDueForFetch(entry, intervalMs, now)).toBe(false);
  });
});

describe('startPoolBackgroundFetches', () => {
  let db;

  // `git rev-parse --git-common-dir` returns an absolute path for a linked
  // worktree (the main clone's .git), so the sweep must resolve against that,
  // not join it onto the entry's own path.
  const COMMON_DIR = '/main-repo/.git';
  const EXPECTED_PACK_DIR = path.resolve(COMMON_DIR, 'objects', 'pack');

  /** Build a fake simple-git instance plus the factory that hands it out. */
  function makeGit({ fetchImpl } = {}) {
    const git = {
      getRemotes: vi.fn(async () => [{ name: 'origin' }]),
      fetch: vi.fn(fetchImpl || (async () => undefined)),
      raw: vi.fn(async () => `${COMMON_DIR}\n`),
    };
    const simpleGit = vi.fn(() => git);
    return { git, simpleGit };
  }

  function makeDeps(overrides = {}) {
    const { simpleGit } = makeGit();
    return {
      simpleGit,
      fs: { existsSync: () => true },
      cleanupOrphanedKeepFiles: vi.fn(async () => ({ scanned: 0, removed: 0, skipped: 0, errors: 0 })),
      ...overrides,
    };
  }

  function seedRepoSettings({ repository = 'owner/repo', poolSize = 2, intervalMinutes = 60 } = {}) {
    db.prepare(`INSERT INTO repo_settings (repository, pool_size, pool_fetch_interval_minutes) VALUES (?, ?, ?)`)
      .run(repository, poolSize, intervalMinutes);
  }

  function seedPoolEntry(id, { repository = 'owner/repo', entryPath = `/tmp/${id}`, status = 'available' } = {}) {
    db.prepare(`INSERT INTO worktree_pool (id, repository, path, status, created_at) VALUES (?, ?, ?, ?, ?)`)
      .run(id, repository, entryPath, status, new Date().toISOString());
  }

  function poolRow(id) {
    return db.prepare('SELECT * FROM worktree_pool WHERE id = ?').get(id);
  }

  /**
   * Run the ticker for `ticks` ticks under fake timers, then stop it.
   * The finally is mandatory: a failing assertion must not leak fake timers
   * into the rest of the file.
   */
  async function runTicks(config, deps, ticks = 1) {
    try {
      vi.useFakeTimers();
      const timer = startPoolBackgroundFetches(db, config, deps);
      try {
        for (let i = 0; i < ticks; i++) {
          await vi.advanceTimersByTimeAsync(POOL_FETCH_TICK_MS);
        }
      } finally {
        clearInterval(timer);
      }
    } finally {
      vi.useRealTimers();
    }
  }

  beforeEach(() => {
    db = createTestDatabase();
    // The loop is chatty; keep test output readable without touching behavior.
    vi.spyOn(logger, 'info').mockImplementation(() => {});
    vi.spyOn(logger, 'warn').mockImplementation(() => {});
    vi.spyOn(logger, 'debug').mockImplementation(() => {});
    vi.spyOn(logger, 'error').mockImplementation(() => {});
  });

  afterEach(() => {
    vi.restoreAllMocks();
    closeTestDatabase(db);
  });

  it('returns the interval timer so callers can stop it', () => {
    try {
      vi.useFakeTimers();
      const timer = startPoolBackgroundFetches(db, { repos: {} }, makeDeps());
      expect(timer).toBeTruthy();
      clearInterval(timer);
    } finally {
      vi.useRealTimers();
    }
  });

  it('fetches a due entry with --progress and records success', async () => {
    seedRepoSettings();
    seedPoolEntry('pool-a');
    const { git, simpleGit } = makeGit();
    const deps = makeDeps({ simpleGit });

    await runTicks({ repos: {} }, deps);

    expect(git.fetch).toHaveBeenCalledTimes(1);
    expect(git.fetch).toHaveBeenCalledWith(['--no-tags', '--progress', '--prune', 'origin']);

    const row = poolRow('pool-a');
    expect(row.last_fetched_at).toBeTruthy();
    expect(row.last_fetch_attempt_at).toBe(row.last_fetched_at);
    expect(row.fetch_failure_count).toBe(0);
    // The keep-file sweep runs after every attempt (success included) so
    // markers orphaned by an earlier process that died outright still get
    // reclaimed once fetching resumes.
    expect(deps.cleanupOrphanedKeepFiles).toHaveBeenCalledTimes(1);
  });

  it('resets an existing failure streak on success', async () => {
    seedRepoSettings();
    seedPoolEntry('pool-a');
    db.prepare(`UPDATE worktree_pool SET fetch_failure_count = 3, last_fetch_attempt_at = '2020-01-01T00:00:00.000Z' WHERE id = 'pool-a'`).run();
    const { simpleGit } = makeGit();

    await runTicks({ repos: {} }, makeDeps({ simpleGit }));

    expect(poolRow('pool-a').fetch_failure_count).toBe(0);
  });

  it('records an attempt, a failure, and cleans up keep files when the fetch fails', async () => {
    seedRepoSettings();
    seedPoolEntry('pool-a', { entryPath: '/tmp/pool-a' });
    const { simpleGit } = makeGit({
      fetchImpl: async () => { throw new Error('killed by signal SIGKILL'); }
    });
    const deps = makeDeps({ simpleGit });

    await runTicks({ repos: {} }, deps);

    const row = poolRow('pool-a');
    expect(row.last_fetched_at).toBeNull();
    expect(row.last_fetch_attempt_at).toBeTruthy();
    expect(row.fetch_failure_count).toBe(1);

    expect(deps.cleanupOrphanedKeepFiles).toHaveBeenCalledTimes(1);
    expect(deps.cleanupOrphanedKeepFiles).toHaveBeenCalledWith(EXPECTED_PACK_DIR);
  });

  it('does not retry a failed entry on the next tick (backoff)', async () => {
    seedRepoSettings({ intervalMinutes: 60 });
    seedPoolEntry('pool-a');
    const { git, simpleGit } = makeGit({
      fetchImpl: async () => { throw new Error('boom'); }
    });

    await runTicks({ repos: {} }, makeDeps({ simpleGit }), 3);

    expect(git.fetch).toHaveBeenCalledTimes(1);
    expect(poolRow('pool-a').fetch_failure_count).toBe(1);
  });

  it('survives a cleanup failure without losing the failure count', async () => {
    seedRepoSettings();
    seedPoolEntry('pool-a');
    const { simpleGit } = makeGit({
      fetchImpl: async () => { throw new Error('boom'); }
    });
    const deps = makeDeps({
      simpleGit,
      cleanupOrphanedKeepFiles: vi.fn(async () => { throw new Error('cleanup exploded'); }),
    });

    await runTicks({ repos: {} }, deps);

    expect(deps.cleanupOrphanedKeepFiles).toHaveBeenCalledTimes(1);
    expect(poolRow('pool-a').fetch_failure_count).toBe(1);
  });

  it('survives a cleanup failure after a successful fetch', async () => {
    seedRepoSettings();
    seedPoolEntry('pool-a');
    const { simpleGit } = makeGit();
    const deps = makeDeps({
      simpleGit,
      cleanupOrphanedKeepFiles: vi.fn(async () => { throw new Error('cleanup exploded'); }),
    });

    await runTicks({ repos: {} }, deps);

    expect(deps.cleanupOrphanedKeepFiles).toHaveBeenCalledTimes(1);
    const row = poolRow('pool-a');
    expect(row.last_fetched_at).toBeTruthy();
    expect(row.fetch_failure_count).toBe(0);
  });

  it('sweeps keep files once per repo, not once per entry', async () => {
    seedRepoSettings();
    seedPoolEntry('pool-a');
    seedPoolEntry('pool-b');
    const { simpleGit } = makeGit();
    const deps = makeDeps({ simpleGit });

    await runTicks({ repos: {} }, deps);

    // Both entries share one git object store, so one sweep covers them.
    expect(poolRow('pool-a').last_fetched_at).toBeTruthy();
    expect(poolRow('pool-b').last_fetched_at).toBeTruthy();
    expect(deps.cleanupOrphanedKeepFiles).toHaveBeenCalledTimes(1);
  });

  it('skips fetching but still sweeps keep files when skip_bulk_fetch is set', async () => {
    seedRepoSettings();
    seedPoolEntry('pool-a');
    seedPoolEntry('pool-b');
    const { git, simpleGit } = makeGit();
    const deps = makeDeps({ simpleGit });
    const config = { repos: { 'owner/repo': { skip_bulk_fetch: true } } };

    await runTicks(config, deps);

    expect(git.fetch).not.toHaveBeenCalled();
    // skip_bulk_fetch repos are the huge monorepos whose killed foreground
    // fetches strand `.keep` markers, so the sweep must still run for them.
    expect(deps.cleanupOrphanedKeepFiles).toHaveBeenCalledTimes(1);
    expect(deps.cleanupOrphanedKeepFiles).toHaveBeenCalledWith(EXPECTED_PACK_DIR);
    // Every entry is stamped so the sweep runs once per interval, not per tick.
    expect(poolRow('pool-a').last_fetch_attempt_at).toBeTruthy();
    expect(poolRow('pool-b').last_fetch_attempt_at).toBeTruthy();
    expect(poolRow('pool-a').last_fetched_at).toBeNull();
  });

  it('sweeps a skip_bulk_fetch repo once per interval, not once per tick', async () => {
    seedRepoSettings({ intervalMinutes: 60 });
    seedPoolEntry('pool-a');
    const { simpleGit } = makeGit();
    const deps = makeDeps({ simpleGit });
    const config = { repos: { 'owner/repo': { skip_bulk_fetch: true } } };

    await runTicks(config, deps, 3);

    expect(deps.cleanupOrphanedKeepFiles).toHaveBeenCalledTimes(1);
  });

  it('anchors the skip_bulk_fetch sweep on any surviving path, not only a due one', async () => {
    seedRepoSettings({ intervalMinutes: 60 });
    seedPoolEntry('pool-gone', { entryPath: '/tmp/pool-gone' });
    seedPoolEntry('pool-fresh', { entryPath: '/tmp/pool-fresh' });
    // pool-gone is the due entry but its directory has vanished; pool-fresh is
    // inside the interval yet still on disk, and reaches the same object store.
    db.prepare(`UPDATE worktree_pool SET last_fetched_at = ?, last_fetch_attempt_at = '2020-01-01T00:00:00.000Z' WHERE id = 'pool-fresh'`)
      .run(new Date().toISOString());
    const { git, simpleGit } = makeGit();
    const deps = makeDeps({
      simpleGit,
      fs: { existsSync: (entryPath) => entryPath !== '/tmp/pool-gone' },
    });
    const config = { repos: { 'owner/repo': { skip_bulk_fetch: true } } };

    await runTicks(config, deps);

    expect(git.fetch).not.toHaveBeenCalled();
    expect(deps.cleanupOrphanedKeepFiles).toHaveBeenCalledTimes(1);
    expect(deps.cleanupOrphanedKeepFiles).toHaveBeenCalledWith(EXPECTED_PACK_DIR);
    // The sweep ran from the surviving sibling, not the vanished due entry.
    expect(simpleGit).toHaveBeenCalledWith('/tmp/pool-fresh', expect.anything());
    expect(simpleGit).not.toHaveBeenCalledWith('/tmp/pool-gone', expect.anything());
    expect(poolRow('pool-gone').last_fetch_attempt_at).toBeTruthy();
    expect(poolRow('pool-fresh').last_fetch_attempt_at > '2020-01-01T00:00:00.000Z').toBe(true);
  });

  it('does not claim the fetch lease for a skip_bulk_fetch repo', async () => {
    seedRepoSettings();
    seedPoolEntry('pool-a');
    const { simpleGit } = makeGit();
    const config = { repos: { 'owner/repo': { skip_bulk_fetch: true } } };

    await runTicks(config, makeDeps({ simpleGit }));

    const row = db.prepare(`SELECT pool_fetch_started_at, pool_fetch_owner FROM repo_settings WHERE repository = 'owner/repo'`).get();
    expect(row.pool_fetch_started_at).toBeNull();
    expect(row.pool_fetch_owner).toBeNull();
  });

  it('passes the configured fetch timeout to simple-git', async () => {
    seedRepoSettings();
    seedPoolEntry('pool-a', { entryPath: '/tmp/pool-a' });
    const { simpleGit } = makeGit();
    const config = { repos: { 'owner/repo': { fetch_timeout_seconds: 1800 } } };

    await runTicks(config, makeDeps({ simpleGit }));

    expect(simpleGit).toHaveBeenCalledWith('/tmp/pool-a', { timeout: { block: 1800000 } });
  });

  it('defaults the fetch timeout to 5 minutes when unconfigured', async () => {
    seedRepoSettings();
    seedPoolEntry('pool-a', { entryPath: '/tmp/pool-a' });
    const { simpleGit } = makeGit();

    await runTicks({ repos: {} }, makeDeps({ simpleGit }));

    expect(simpleGit).toHaveBeenCalledWith('/tmp/pool-a', { timeout: { block: 300000 } });
  });

  it('skips entries whose directory no longer exists and backs the skip off', async () => {
    seedRepoSettings();
    seedPoolEntry('pool-a');
    const { git, simpleGit } = makeGit();

    await runTicks({ repos: {} }, makeDeps({ simpleGit, fs: { existsSync: () => false } }), 3);

    expect(git.fetch).not.toHaveBeenCalled();
    // The skip stamps an attempt so a vanished directory is re-evaluated once
    // per interval, not on every 60-second tick.
    expect(poolRow('pool-a').last_fetch_attempt_at).toBeTruthy();
  });

  it('refreshes the fetch lease while a long fetch is running', async () => {
    seedRepoSettings({ intervalMinutes: 60 });
    seedPoolEntry('pool-a');
    let resolveFetch;
    const { simpleGit } = makeGit({
      fetchImpl: () => new Promise((resolve) => { resolveFetch = resolve; })
    });
    const deps = makeDeps({ simpleGit });

    const leaseStartedAt = () =>
      db.prepare(`SELECT pool_fetch_started_at FROM repo_settings WHERE repository = 'owner/repo'`)
        .get().pool_fetch_started_at;

    try {
      vi.useFakeTimers();
      const timer = startPoolBackgroundFetches(db, { repos: {} }, deps);
      try {
        // First tick claims the lease and starts the (hanging) fetch.
        await vi.advanceTimersByTimeAsync(POOL_FETCH_TICK_MS);
        const claimedAt = leaseStartedAt();
        expect(claimedAt).toBeTruthy();

        // 11 minutes later the fetch is still running. Without the heartbeat
        // the lease would now be past the 10-minute stale guard and another
        // instance could claim it mid-fetch.
        await vi.advanceTimersByTimeAsync(11 * 60 * 1000);
        const refreshedAt = leaseStartedAt();
        expect(Date.parse(refreshedAt)).toBeGreaterThan(Date.parse(claimedAt));
        expect(Date.now() - Date.parse(refreshedAt)).toBeLessThan(10 * 60 * 1000);

        // Let the fetch finish and the tick body unwind (releases the lease).
        resolveFetch();
        await vi.advanceTimersByTimeAsync(0);
      } finally {
        clearInterval(timer);
      }
    } finally {
      vi.useRealTimers();
    }
  });

  it('does nothing when no repo has a fetch interval configured', async () => {
    db.prepare(`INSERT INTO repo_settings (repository, pool_size) VALUES ('owner/repo', 2)`).run();
    seedPoolEntry('pool-a');
    const { git, simpleGit } = makeGit();

    await runTicks({ repos: {} }, makeDeps({ simpleGit }));

    expect(git.fetch).not.toHaveBeenCalled();
  });

  it('leaves a freshly fetched entry alone', async () => {
    seedRepoSettings({ intervalMinutes: 60 });
    seedPoolEntry('pool-a');
    const fresh = new Date().toISOString();
    db.prepare(`UPDATE worktree_pool SET last_fetched_at = ?, last_fetch_attempt_at = ? WHERE id = 'pool-a'`).run(fresh, fresh);
    const { git, simpleGit } = makeGit();

    await runTicks({ repos: {} }, makeDeps({ simpleGit }));

    expect(git.fetch).not.toHaveBeenCalled();
  });

  it('continues to the next entry after one entry fails', async () => {
    seedRepoSettings();
    seedPoolEntry('pool-a', { entryPath: '/tmp/pool-a' });
    seedPoolEntry('pool-b', { entryPath: '/tmp/pool-b' });

    const failing = {
      getRemotes: vi.fn(async () => [{ name: 'origin' }]),
      fetch: vi.fn(async () => { throw new Error('boom'); }),
      raw: vi.fn(async () => `${COMMON_DIR}\n`),
    };
    const ok = {
      getRemotes: vi.fn(async () => [{ name: 'origin' }]),
      fetch: vi.fn(async () => undefined),
      raw: vi.fn(async () => `${COMMON_DIR}\n`),
    };
    const simpleGit = vi.fn((repoPath) => (repoPath === '/tmp/pool-a' ? failing : ok));

    await runTicks({ repos: {} }, makeDeps({ simpleGit }));

    expect(failing.fetch).toHaveBeenCalledTimes(1);
    expect(ok.fetch).toHaveBeenCalledTimes(1);
    expect(poolRow('pool-a').fetch_failure_count).toBe(1);
    expect(poolRow('pool-b').last_fetched_at).toBeTruthy();
  });

  it('stamps the attempt before the fetch starts', async () => {
    seedRepoSettings();
    seedPoolEntry('pool-a');
    let attemptWhenFetchStarted;
    const { simpleGit } = makeGit({
      fetchImpl: async () => {
        attemptWhenFetchStarted = poolRow('pool-a').last_fetch_attempt_at;
        throw new Error('killed by signal SIGKILL');
      }
    });

    await runTicks({ repos: {} }, makeDeps({ simpleGit }));

    // A fetch killed mid-pack (or a process that dies outright) must still back
    // off, which only works if the stamp landed before git started.
    expect(attemptWhenFetchStarted).toBeTruthy();
  });

  it('records a failure when the git instance cannot be constructed', async () => {
    seedRepoSettings();
    seedPoolEntry('pool-a', { entryPath: '/tmp/pool-a' });
    seedPoolEntry('pool-b', { entryPath: '/tmp/pool-b' });
    const ok = {
      getRemotes: vi.fn(async () => [{ name: 'origin' }]),
      fetch: vi.fn(async () => undefined),
      raw: vi.fn(async () => `${COMMON_DIR}\n`),
    };
    const simpleGit = vi.fn((repoPath) => {
      if (repoPath === '/tmp/pool-a') throw new Error('cannot resolve git dir');
      return ok;
    });
    const deps = makeDeps({ simpleGit });

    await runTicks({ repos: {} }, deps);

    expect(poolRow('pool-a').fetch_failure_count).toBe(1);
    expect(poolRow('pool-b').last_fetched_at).toBeTruthy();
    // The sweep still runs, using the instance that did construct.
    expect(deps.cleanupOrphanedKeepFiles).toHaveBeenCalledTimes(1);
  });

  it('skips the sweep when no git instance could be constructed', async () => {
    seedRepoSettings();
    seedPoolEntry('pool-a');
    const simpleGit = vi.fn(() => { throw new Error('cannot resolve git dir'); });
    const deps = makeDeps({ simpleGit });

    await runTicks({ repos: {} }, deps);

    expect(poolRow('pool-a').fetch_failure_count).toBe(1);
    expect(deps.cleanupOrphanedKeepFiles).not.toHaveBeenCalled();
  });

  it('does not start a second pass while a fetch is still running', async () => {
    // Two repos: repo-a's fetch hangs, repo-b is due and untouched behind it.
    // Only a second repo can discriminate the in-progress guard — a lone repo's
    // entry is stamped by the first pass and stops being due on its own.
    seedRepoSettings({ repository: 'owner/repo-a', intervalMinutes: 60 });
    seedRepoSettings({ repository: 'owner/repo-b', intervalMinutes: 60 });
    seedPoolEntry('pool-a', { repository: 'owner/repo-a', entryPath: '/tmp/pool-a' });
    seedPoolEntry('pool-b', { repository: 'owner/repo-b', entryPath: '/tmp/pool-b' });

    let resolveFetchA;
    const gitA = {
      getRemotes: vi.fn(async () => [{ name: 'origin' }]),
      fetch: vi.fn(() => new Promise((resolve) => { resolveFetchA = resolve; })),
      raw: vi.fn(async () => `${COMMON_DIR}\n`),
    };
    const gitB = {
      getRemotes: vi.fn(async () => [{ name: 'origin' }]),
      fetch: vi.fn(async () => undefined),
      raw: vi.fn(async () => `${COMMON_DIR}\n`),
    };
    const simpleGit = vi.fn((repoPath) => (repoPath === '/tmp/pool-a' ? gitA : gitB));
    const deps = makeDeps({ simpleGit });
    // A config key pins repo-a first in the iteration set (config keys are
    // added before the DB rows), so repo-a is the one that hangs the pass.
    const config = { repos: { 'owner/repo-a': {} } };

    try {
      vi.useFakeTimers();
      const timer = startPoolBackgroundFetches(db, config, deps);
      try {
        // Tick 1: repo-a claims its lease and hangs before repo-b is reached.
        await vi.advanceTimersByTimeAsync(POOL_FETCH_TICK_MS);
        expect(gitA.fetch).toHaveBeenCalledTimes(1);
        expect(gitB.fetch).not.toHaveBeenCalled();

        // Tick 2 lands while repo-a is still hanging. repo-b is due and its
        // lease is free, so without the guard this tick would fetch it
        // concurrently with the in-flight pass.
        await vi.advanceTimersByTimeAsync(POOL_FETCH_TICK_MS);
        expect(gitB.fetch).not.toHaveBeenCalled();
        expect(poolRow('pool-b').last_fetch_attempt_at).toBeNull();

        // Once repo-a's fetch settles the original pass walks on to repo-b.
        resolveFetchA();
        await vi.advanceTimersByTimeAsync(POOL_FETCH_TICK_MS);
        expect(gitA.fetch).toHaveBeenCalledTimes(1);
        expect(gitB.fetch).toHaveBeenCalledTimes(1);
        expect(poolRow('pool-a').last_fetched_at).toBeTruthy();
        expect(poolRow('pool-b').last_fetched_at).toBeTruthy();
      } finally {
        clearInterval(timer);
      }
    } finally {
      vi.useRealTimers();
    }
  });

  it('keeps fetching and sweeping later repos when one repo\'s sweep throws', async () => {
    seedRepoSettings({ repository: 'owner/repo-a' });
    seedRepoSettings({ repository: 'owner/repo-b' });
    seedPoolEntry('pool-a', { repository: 'owner/repo-a', entryPath: '/tmp/pool-a' });
    seedPoolEntry('pool-b', { repository: 'owner/repo-b', entryPath: '/tmp/pool-b' });

    const commonDirA = '/main-repo-a/.git';
    const commonDirB = '/main-repo-b/.git';
    const packDirA = path.resolve(commonDirA, 'objects', 'pack');
    const packDirB = path.resolve(commonDirB, 'objects', 'pack');
    const gitA = {
      getRemotes: vi.fn(async () => [{ name: 'origin' }]),
      fetch: vi.fn(async () => undefined),
      raw: vi.fn(async () => `${commonDirA}\n`),
    };
    const gitB = {
      getRemotes: vi.fn(async () => [{ name: 'origin' }]),
      fetch: vi.fn(async () => undefined),
      raw: vi.fn(async () => `${commonDirB}\n`),
    };
    const simpleGit = vi.fn((repoPath) => (repoPath === '/tmp/pool-a' ? gitA : gitB));
    const deps = makeDeps({
      simpleGit,
      cleanupOrphanedKeepFiles: vi.fn(async (packDir) => {
        if (packDir === packDirA) throw new Error('cleanup exploded');
        return { scanned: 0, removed: 0, skipped: 0, errors: 0 };
      }),
    });
    // Pins repo-a — the repo whose sweep throws — first in iteration order.
    const config = { repos: { 'owner/repo-a': {} } };

    await runTicks(config, deps);

    // repo-a's sweep blew up, but it must not abort the outer repo loop.
    expect(deps.cleanupOrphanedKeepFiles).toHaveBeenCalledWith(packDirA);
    expect(deps.cleanupOrphanedKeepFiles).toHaveBeenCalledWith(packDirB);
    expect(gitB.fetch).toHaveBeenCalledTimes(1);
    expect(poolRow('pool-b').last_fetched_at).toBeTruthy();
    // repo-a still fetched successfully and gave its lease back.
    expect(poolRow('pool-a').last_fetched_at).toBeTruthy();
    const leaseA = db.prepare(`SELECT pool_fetch_finished_at FROM repo_settings WHERE repository = 'owner/repo-a'`).get();
    expect(leaseA.pool_fetch_finished_at).not.toBeNull();
  });

  it('releases the lease it claimed once the pass finishes', async () => {
    seedRepoSettings();
    seedPoolEntry('pool-a');
    const { simpleGit } = makeGit();

    await runTicks({ repos: {} }, makeDeps({ simpleGit }));

    const row = db.prepare(`SELECT pool_fetch_started_at, pool_fetch_finished_at, pool_fetch_owner FROM repo_settings WHERE repository = 'owner/repo'`).get();
    expect(row.pool_fetch_owner).toBeTruthy();
    expect(row.pool_fetch_finished_at).not.toBeNull();
    expect(row.pool_fetch_finished_at >= row.pool_fetch_started_at).toBe(true);
  });

  it('excludes entries in a transient status', async () => {
    seedRepoSettings();
    seedPoolEntry('pool-a', { status: 'switching' });
    const { git, simpleGit } = makeGit();

    await runTicks({ repos: {} }, makeDeps({ simpleGit }));

    expect(git.fetch).not.toHaveBeenCalled();
  });
});
