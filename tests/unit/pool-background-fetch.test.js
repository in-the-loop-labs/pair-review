// Copyright 2026 Tim Perkins (tjwp) | SPDX-License-Identifier: Apache-2.0
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { WorktreePoolRepository } = require('../../src/database');
const { startPoolBackgroundFetches } = require('../../src/main');
const logger = require('../../src/utils/logger');
const { createTestDatabase, closeTestDatabase } = require('../utils/schema');

const REPOSITORY = 'owner/repo';
const POOL_ID = 'pool-background-fetch';

describe('startPoolBackgroundFetches', () => {
  let db;
  let tempDir;
  let getRemotes;
  let fetch;
  let createGit;
  let schedule;
  let runScheduledTick;
  let errorSpy;

  beforeEach(async () => {
    db = createTestDatabase();
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pair-review-pool-fetch-'));
    await new WorktreePoolRepository(db).create({
      id: POOL_ID,
      repository: REPOSITORY,
      path: tempDir,
    });
    getRemotes = vi.fn().mockResolvedValue([{ name: 'origin' }]);
    fetch = vi.fn().mockResolvedValue(undefined);
    createGit = vi.fn(() => ({ getRemotes, fetch }));
    schedule = vi.fn((callback) => {
      runScheduledTick = callback;
      return { unref: vi.fn() };
    });
    errorSpy = vi.spyOn(logger, 'error').mockImplementation(() => {});
  });

  afterEach(() => {
    try {
      errorSpy?.mockRestore();
    } finally {
      try {
        if (db?.open) closeTestDatabase(db);
      } finally {
        if (tempDir) fs.rmSync(tempDir, { recursive: true, force: true });
      }
    }
  });

  function configWithSkipBulkFetch(skipBulkFetch) {
    return {
      repos: {
        [REPOSITORY]: {
          pool_size: 1,
          pool_fetch_interval_minutes: 60,
          skip_bulk_fetch: skipBulkFetch,
        },
      },
    };
  }

  function getPoolRow() {
    return db.prepare('SELECT last_fetched_at FROM worktree_pool WHERE id = ?').get(POOL_ID);
  }

  function getRepoSettingsRow() {
    return db.prepare(
      'SELECT pool_fetch_started_at, pool_fetch_finished_at FROM repo_settings WHERE repository = ?'
    ).get(REPOSITORY);
  }

  it('skips due pool fetches when skip_bulk_fetch is enabled', async () => {
    startPoolBackgroundFetches(
      db,
      configWithSkipBulkFetch(true),
      { createGit, schedule }
    );
    await runScheduledTick();

    expect(errorSpy).not.toHaveBeenCalled();
    expect(createGit).not.toHaveBeenCalled();
    expect(getRemotes).not.toHaveBeenCalled();
    expect(fetch).not.toHaveBeenCalled();
    expect(getPoolRow().last_fetched_at).toBeNull();
    expect(getRepoSettingsRow()).toBeUndefined();
  });

  it('fetches due pool worktrees when skip_bulk_fetch is disabled', async () => {
    startPoolBackgroundFetches(
      db,
      configWithSkipBulkFetch(false),
      { createGit, schedule }
    );
    await runScheduledTick();

    expect(errorSpy).not.toHaveBeenCalled();
    expect(createGit).toHaveBeenCalledOnce();
    expect(createGit).toHaveBeenCalledWith(tempDir, {
      timeout: { block: 300000 },
    });
    expect(getRemotes).toHaveBeenCalledOnce();
    expect(fetch).toHaveBeenCalledWith(['--no-tags', '--prune', 'origin']);
    expect(getPoolRow().last_fetched_at).not.toBeNull();
    expect(getRepoSettingsRow()).toEqual({
      pool_fetch_started_at: expect.any(String),
      pool_fetch_finished_at: expect.any(String),
    });
  });
});
