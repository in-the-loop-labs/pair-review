// Copyright 2026 Tim Perkins (tjwp) | SPDX-License-Identifier: Apache-2.0
/**
 * Tests for the /pr fast-path `?host` correction helper (src/server.js).
 *
 * The /pr/:owner/:repo/:number route serves pr.html directly when a PR already
 * has metadata + a worktree, so `applyHostQueryCorrection` is the only place
 * that consumes an explicit `?host` hint on that fast path. It maps the sentinel
 * ('github' → null, other string → alt api_host, absent → no-op), validates
 * against config, and persists a corrected host via PRMetadataRepository.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { createTestDatabase, closeTestDatabase } from '../utils/schema';

const { applyHostQueryCorrection } = require('../../src/server');
const { run, PRMetadataRepository } = require('../../src/database');
const logger = require('../../src/utils/logger');

const API_HOST = 'https://althost.example/api/v3';
const REPOSITORY = 'altorg/altrepo';
const PR_NUMBER = 42;

/** Config with a dual (non-exclusive) alt-host repo. */
function dualConfig() {
  return { repos: { [REPOSITORY]: { api_host: API_HOST, token: 'alt-token', exclusive: false } } };
}

/** Config with an exclusive alt-host repo (no github.com presence). */
function exclusiveConfig() {
  return { repos: { [REPOSITORY]: { api_host: API_HOST, token: 'alt-token' } } };
}

async function seedPR(db, host) {
  await run(db,
    'INSERT INTO pr_metadata (pr_number, repository, host) VALUES (?, ?, ?)',
    [PR_NUMBER, REPOSITORY, host]
  );
}

async function storedHost(db) {
  return new PRMetadataRepository(db).getPRHost(REPOSITORY, PR_NUMBER);
}

describe('applyHostQueryCorrection (/pr fast path ?host)', () => {
  let db;

  beforeEach(() => {
    db = createTestDatabase();
  });

  afterEach(() => {
    if (db) closeTestDatabase(db);
    vi.restoreAllMocks();
  });

  it('stamps a matching alt host onto a legacy NULL row', async () => {
    await seedPR(db, null);

    await applyHostQueryCorrection(db, dualConfig(), 'altorg', 'altrepo', REPOSITORY, PR_NUMBER, API_HOST);

    expect(await storedHost(db)).toBe(API_HOST);
  });

  it('nulls the host for the github sentinel on a dual repo', async () => {
    await seedPR(db, API_HOST);

    await applyHostQueryCorrection(db, dualConfig(), 'altorg', 'altrepo', REPOSITORY, PR_NUMBER, 'github');

    expect(await storedHost(db)).toBeNull();
  });

  it('warns and ignores a host that does not match the configured api_host', async () => {
    await seedPR(db, null);
    const warnSpy = vi.spyOn(logger, 'warn');

    await applyHostQueryCorrection(db, dualConfig(), 'altorg', 'altrepo', REPOSITORY, PR_NUMBER, 'https://evil.example/api');

    expect(warnSpy).toHaveBeenCalled();
    expect(await storedHost(db)).toBeNull(); // untouched
  });

  it('warns and ignores the github sentinel for an exclusive alt-host repo', async () => {
    await seedPR(db, API_HOST);
    const warnSpy = vi.spyOn(logger, 'warn');

    await applyHostQueryCorrection(db, exclusiveConfig(), 'altorg', 'altrepo', REPOSITORY, PR_NUMBER, 'github');

    expect(warnSpy).toHaveBeenCalled();
    expect(await storedHost(db)).toBe(API_HOST); // untouched
  });

  it('does nothing when no host query param is present', async () => {
    await seedPR(db, null);
    const warnSpy = vi.spyOn(logger, 'warn');

    await applyHostQueryCorrection(db, dualConfig(), 'altorg', 'altrepo', REPOSITORY, PR_NUMBER, undefined);

    expect(warnSpy).not.toHaveBeenCalled();
    expect(await storedHost(db)).toBeNull();
  });

  it('skips the write when the stored host already matches', async () => {
    await seedPR(db, API_HOST);
    const updateSpy = vi.spyOn(PRMetadataRepository.prototype, 'updatePRHost');

    await applyHostQueryCorrection(db, dualConfig(), 'altorg', 'altrepo', REPOSITORY, PR_NUMBER, API_HOST);

    expect(updateSpy).not.toHaveBeenCalled();
    expect(await storedHost(db)).toBe(API_HOST);
  });
});
