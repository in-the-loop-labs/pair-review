// Copyright 2026 Tim Perkins (tjwp) | SPDX-License-Identifier: Apache-2.0
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { createTestDatabase, closeTestDatabase } from '../utils/schema';

const { resolveRepoRoot, isSafeRelativePath } = require('../../src/utils/review-paths');

describe('isSafeRelativePath', () => {
  it.each(['../escape.js', ' ../escape.js', ' ..\\escape.js', '/etc/passwd', ' C:\\escape.js', '', ' ', null, 'a\0b'])('rejects unsafe path %j', file => {
    expect(isSafeRelativePath(file)).toBe(false);
  });

  it('accepts a trimmed relative path', () => {
    expect(isSafeRelativePath(' src/helper.js ')).toBe(true);
  });
});

describe('resolveRepoRoot', () => {
  let db, root, checkout;
  const review = { pr_number: 123, repository: 'owner/repo' };
  beforeEach(() => {
    db = createTestDatabase();
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'review-paths-'));
    checkout = path.join(root, 'checkout');
    fs.mkdirSync(checkout);
  });
  afterEach(() => { closeTestDatabase(db); fs.rmSync(root, { recursive: true, force: true }); });
  function metadata(data) {
    db.prepare('INSERT INTO pr_metadata (pr_number, repository, pr_data) VALUES (?, ?, ?)')
      .run(123, 'Owner/Repo', data);
  }

  it('uses the PR metadata checkout path when no worktree row exists', async () => {
    metadata(JSON.stringify({ worktree_path: checkout }));
    expect(await resolveRepoRoot(db, review)).toBe(checkout);
  });

  it('rejects a metadata checkout reassigned to another PR in the worktree pool', async () => {
    metadata(JSON.stringify({ worktree_path: checkout }));
    db.prepare(`INSERT INTO worktrees (id, pr_number, repository, branch, path, created_at, last_accessed_at)
      VALUES ('pooled', 456, 'owner/repo', 'other-pr', ?, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)`).run(checkout);
    expect(await resolveRepoRoot(db, review)).toBeNull();
  });

  it('rejects a deleted metadata checkout', async () => {
    metadata(JSON.stringify({ worktree_path: checkout }));
    fs.rmdirSync(checkout);
    expect(await resolveRepoRoot(db, review)).toBeNull();
  });

  it('rejects a nonexistent metadata checkout', async () => {
    metadata(JSON.stringify({ worktree_path: path.join(root, 'missing') }));
    expect(await resolveRepoRoot(db, review)).toBeNull();
  });

  it('rejects metadata pointing to a file rather than a directory', async () => {
    const file = path.join(root, 'file');
    fs.writeFileSync(file, 'content');
    metadata(JSON.stringify({ worktree_path: file }));
    expect(await resolveRepoRoot(db, review)).toBeNull();
  });

  it('prefers the worktree row to the metadata fallback', async () => {
    metadata(JSON.stringify({ worktree_path: checkout }));
    const worktree = path.join(root, 'worktree');
    fs.mkdirSync(worktree);
    db.prepare(`INSERT INTO worktrees (id, pr_number, repository, branch, path, created_at, last_accessed_at)
      VALUES ('wt', 123, 'owner/repo', 'feature', ?, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)`).run(worktree);
    expect(await resolveRepoRoot(db, review)).toBe(worktree);
  });

  it('falls back to an owned checkout when a worktree row is stale', async () => {
    metadata(JSON.stringify({ worktree_path: checkout }));
    db.prepare(`INSERT INTO worktrees (id, pr_number, repository, branch, path, created_at, last_accessed_at)
      VALUES ('wt', 123, 'owner/repo', 'feature', ?, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)`)
      .run(path.join(root, 'deleted-worktree'));
    expect(await resolveRepoRoot(db, review)).toBe(checkout);
  });

  it('uses the local review path first', async () => {
    metadata(JSON.stringify({ worktree_path: checkout }));
    expect(await resolveRepoRoot(db, { ...review, local_path: '/local' })).toBe('/local');
  });

  it.each(['{}', 'null', 'invalid JSON'])('handles missing or invalid metadata: %s', async data => {
    metadata(data);
    expect(await resolveRepoRoot(db, review)).toBeNull();
  });

  it('handles absent metadata or review', async () => {
    expect(await resolveRepoRoot(db, review)).toBeNull();
    expect(await resolveRepoRoot(db, null)).toBeNull();
  });
});
