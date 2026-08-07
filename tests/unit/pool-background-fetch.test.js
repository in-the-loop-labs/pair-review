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

  /** Build a fake simple-git instance plus the factory that hands it out. */
  function makeGit({ fetchImpl } = {}) {
    const git = {
      getRemotes: vi.fn(async () => [{ name: 'origin' }]),
      fetch: vi.fn(fetchImpl || (async () => undefined)),
      raw: vi.fn(async () => '.git\n'),
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
    const packDir = deps.cleanupOrphanedKeepFiles.mock.calls[0][0];
    expect(packDir).toBe(path.resolve('/tmp/pool-a', '.git', 'objects', 'pack'));
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

    expect(poolRow('pool-a').fetch_failure_count).toBe(1);
  });

  it('skips a repo entirely when skip_bulk_fetch is set', async () => {
    seedRepoSettings();
    seedPoolEntry('pool-a');
    const { git, simpleGit } = makeGit();
    const config = { repos: { 'owner/repo': { skip_bulk_fetch: true } } };

    await runTicks(config, makeDeps({ simpleGit }));

    expect(git.fetch).not.toHaveBeenCalled();
    expect(simpleGit).not.toHaveBeenCalled();
    expect(poolRow('pool-a').last_fetch_attempt_at).toBeNull();
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
      raw: vi.fn(async () => '.git\n'),
    };
    const ok = {
      getRemotes: vi.fn(async () => [{ name: 'origin' }]),
      fetch: vi.fn(async () => undefined),
      raw: vi.fn(async () => '.git\n'),
    };
    const simpleGit = vi.fn((repoPath) => (repoPath === '/tmp/pool-a' ? failing : ok));

    await runTicks({ repos: {} }, makeDeps({ simpleGit }));

    expect(failing.fetch).toHaveBeenCalledTimes(1);
    expect(ok.fetch).toHaveBeenCalledTimes(1);
    expect(poolRow('pool-a').fetch_failure_count).toBe(1);
    expect(poolRow('pool-b').last_fetched_at).toBeTruthy();
  });

  it('excludes entries in a transient status', async () => {
    seedRepoSettings();
    seedPoolEntry('pool-a', { status: 'switching' });
    const { git, simpleGit } = makeGit();

    await runTicks({ repos: {} }, makeDeps({ simpleGit }));

    expect(git.fetch).not.toHaveBeenCalled();
  });
});
