// Copyright 2026 Tim Perkins (tjwp) | SPDX-License-Identifier: Apache-2.0
/**
 * FINDING A — cross-host collision guard in storePRData.
 *
 * pr_metadata/reviews/worktrees are keyed UNIQUE(pr_number, repository) with no
 * host column (the plan's confirmed no-collision assumption). storePRData's
 * UPDATE arm must therefore detect the pathological case — two DIFFERENT PRs
 * sharing a number on two hosts — and REJECT it rather than overwrite the wrong
 * PR. Same-id host relabel is the intended self-heal and proceeds.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

const { createTestDatabase, closeTestDatabase } = require('../utils/schema');
const { run, queryOne } = require('../../src/database');
const { storePRData } = require('../../src/setup/pr-setup');
const logger = require('../../src/utils/logger');

const REPO = 'acme/widgets';
const ALT = 'https://alt.example/api/v3';

function prData({ node_id, title = 'PR', headBranch = 'feature' }) {
  return {
    node_id,
    title,
    body: 'body',
    author: 'alice',
    base_branch: 'main',
    head_branch: headBranch,
    head_sha: 'sha-head',
    base_sha: 'sha-base',
  };
}

async function seedRow(db, { host, node_id }) {
  await run(db,
    `INSERT INTO pr_metadata (pr_number, repository, title, pr_data, host) VALUES (?, ?, ?, ?, ?)`,
    [42, REPO, 'Seeded', JSON.stringify({ node_id, head_sha: 'sha-head' }), host]
  );
}

describe('storePRData — cross-host collision guard', () => {
  let db;
  beforeEach(() => { db = createTestDatabase(); });
  afterEach(() => { if (db) closeTestDatabase(db); });

  it('same API id + different host → proceeds and restamps the host (self-heal)', async () => {
    await seedRow(db, { host: ALT, node_id: 'NODE_SAME' });

    await storePRData(
      db, { owner: 'acme', repo: 'widgets', number: 42 },
      prData({ node_id: 'NODE_SAME', title: 'Updated' }),
      'diff', [], '/tmp/wt', { host: null } // relabel alt -> github
    );

    const row = await queryOne(db, 'SELECT host, title FROM pr_metadata WHERE pr_number = 42 AND repository = ?', [REPO]);
    expect(row.host).toBe(null);       // restamped to github
    expect(row.title).toBe('Updated'); // row updated
  });

  it('different API id + different host → throws and leaves the row unmodified', async () => {
    await seedRow(db, { host: null, node_id: 'NODE_GITHUB' });

    await expect(storePRData(
      db, { owner: 'acme', repo: 'widgets', number: 42 },
      prData({ node_id: 'NODE_ALT', title: 'Should not land' }),
      'diff', [], '/tmp/wt', { host: ALT }
    )).rejects.toThrow(/Cross-host PR conflict for acme\/widgets #42/);

    // No partial write: host, title, pr_data all unchanged; no worktree row.
    const row = await queryOne(db, 'SELECT host, title, pr_data FROM pr_metadata WHERE pr_number = 42 AND repository = ?', [REPO]);
    expect(row.host).toBe(null);
    expect(row.title).toBe('Seeded');
    expect(JSON.parse(row.pr_data).node_id).toBe('NODE_GITHUB');
    const wt = await queryOne(db, 'SELECT id FROM worktrees WHERE pr_number = 42 AND repository = ?', [REPO]);
    expect(wt).toBeFalsy();
  });

  it('stored row with no parseable id + different host → warns and proceeds', async () => {
    const warnSpy = vi.spyOn(logger, 'warn').mockImplementation(() => {});
    // Seed a row whose pr_data has no id/node_id.
    await run(db,
      `INSERT INTO pr_metadata (pr_number, repository, title, pr_data, host) VALUES (?, ?, ?, ?, ?)`,
      [42, REPO, 'Seeded', JSON.stringify({ head_sha: 'sha' }), null]
    );

    await storePRData(
      db, { owner: 'acme', repo: 'widgets', number: 42 },
      prData({ node_id: 'NODE_ALT' }),
      'diff', [], '/tmp/wt', { host: ALT }
    );

    const row = await queryOne(db, 'SELECT host FROM pr_metadata WHERE pr_number = 42 AND repository = ?', [REPO]);
    expect(row.host).toBe(ALT); // proceeded with the relabel
    expect(warnSpy).toHaveBeenCalledWith(expect.stringMatching(/no parseable API id/));
    warnSpy.mockRestore();
  });

  it('same host (no relabel) → no guard, normal update', async () => {
    await seedRow(db, { host: null, node_id: 'NODE_GITHUB' });

    // Different id but SAME host (null) — guard does not fire (host unchanged).
    await storePRData(
      db, { owner: 'acme', repo: 'widgets', number: 42 },
      prData({ node_id: 'NODE_DIFFERENT', title: 'Same-host update' }),
      'diff', [], '/tmp/wt', { host: null }
    );

    const row = await queryOne(db, 'SELECT host, title FROM pr_metadata WHERE pr_number = 42 AND repository = ?', [REPO]);
    expect(row.host).toBe(null);
    expect(row.title).toBe('Same-host update');
  });

  it('incoming host undefined (host unknown) → no guard even if stored host is set', async () => {
    await seedRow(db, { host: ALT, node_id: 'NODE_ALT' });

    // No host option → writeHost false → guard skipped; host column untouched.
    await storePRData(
      db, { owner: 'acme', repo: 'widgets', number: 42 },
      prData({ node_id: 'NODE_OTHER', title: 'Host-unknown update' }),
      'diff', [], '/tmp/wt', {}
    );

    const row = await queryOne(db, 'SELECT host, title FROM pr_metadata WHERE pr_number = 42 AND repository = ?', [REPO]);
    expect(row.host).toBe(ALT);   // untouched
    expect(row.title).toBe('Host-unknown update');
  });
});
