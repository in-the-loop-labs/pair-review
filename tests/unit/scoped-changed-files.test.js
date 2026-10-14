// Copyright 2026 Tim Perkins (tjwp) | SPDX-License-Identifier: Apache-2.0
import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach, vi } from 'vitest';
import { execSync } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { createTestDatabase, closeTestDatabase } from '../utils/schema';

const { listScopedChangedFiles } = require('../../src/git/scoped-changed-files');
const { getDiffFileList, getReviewDiffFiles } = require('../../src/utils/diff-file-list');
const { diffContainsPath } = require('../../src/utils/diff-file-content');

// main: base.js. feature: one commit adding branch.js, then a staged file,
// an unstaged edit and an untracked file on top.
let repo;
const git = command => execSync(`git ${command}`, { cwd: repo, stdio: 'pipe', encoding: 'utf8' });
const write = (name, content) => fs.writeFileSync(path.join(repo, name), content);

beforeAll(() => {
  repo = fs.mkdtempSync(path.join(os.tmpdir(), 'scoped-changed-files-'));
  git('init -b main');
  git('config user.email "test@test.com"');
  git('config user.name "Test User"');
  write('base.js', 'base\n');
  git('add base.js');
  git('commit -m initial');
  git('checkout -b feature');
  write('branch.js', 'branch\n');
  git('add branch.js');
  git('commit -m branch');
  write('staged.js', 'staged\n');
  git('add staged.js');
  write('base.js', 'base edited\n');
  write('untracked.js', 'untracked\n');
});

afterAll(() => fs.rmSync(repo, { recursive: true, force: true }));

describe('listScopedChangedFiles', () => {
  const list = async scope => (await listScopedChangedFiles(repo, scope)).sort();

  it.each([
    ['branch', 'untracked', { baseBranch: 'main' }, ['base.js', 'branch.js', 'staged.js', 'untracked.js']],
    ['staged', 'untracked', {}, ['base.js', 'staged.js', 'untracked.js']],
    ['unstaged', 'untracked', {}, ['base.js', 'untracked.js']],
    ['staged', 'unstaged', {}, ['base.js', 'staged.js']],
    ['branch', 'unstaged', { baseBranch: 'main' }, ['base.js', 'branch.js', 'staged.js']],
    ['unstaged', 'unstaged', {}, ['base.js']]
  ])('lists %s..%s', async (scopeStart, scopeEnd, extra, expected) => {
    expect(await list({ scopeStart, scopeEnd, ...extra })).toEqual(expected);
  });

  it('skips the branch stop without a base branch', async () => {
    expect(await list({ scopeStart: 'branch', scopeEnd: 'unstaged' })).toEqual(['base.js', 'staged.js']);
  });

  it('lists unstaged, untracked and staged files without scope fields', async () => {
    expect(await list({})).toEqual(['base.js', 'staged.js', 'untracked.js']);
  });

  it('uses the injected merge-base resolver', async () => {
    const findMergeBase = vi.fn(async () => git('rev-parse main').trim());
    expect((await listScopedChangedFiles(repo, { scopeStart: 'branch', scopeEnd: 'unstaged', baseBranch: 'main' }, { findMergeBase })).sort())
      .toEqual(['base.js', 'branch.js', 'staged.js']);
    expect(findMergeBase).toHaveBeenCalledWith(repo, 'main');
  });

  it('throws when git fails', async () => {
    const notRepo = fs.mkdtempSync(path.join(os.tmpdir(), 'scoped-not-repo-'));
    try {
      await expect(listScopedChangedFiles(notRepo, {})).rejects.toThrow();
    } finally {
      fs.rmSync(notRepo, { recursive: true, force: true });
    }
  });
});

describe('getDiffFileList / getReviewDiffFiles for Local reviews', () => {
  let db;
  beforeEach(() => { db = createTestDatabase(); });
  afterEach(() => closeTestDatabase(db));

  function insertLocalReview(scopeStart, scopeEnd) {
    return Number(db.prepare(`INSERT INTO reviews (review_type, local_path, local_head_sha, status, repository,
      local_scope_start, local_scope_end, local_base_branch) VALUES ('local', ?, 'head', 'draft', 'r', ?, ?, 'main')`)
      .run(repo, scopeStart, scopeEnd).lastInsertRowid);
  }
  const reviewRow = id => db.prepare('SELECT * FROM reviews WHERE id = ?').get(id);

  it('follows the review scope, including staged and branch files', async () => {
    const id = insertLocalReview('branch', 'untracked');
    expect((await getDiffFileList(db, reviewRow(id))).sort())
      .toEqual(['base.js', 'branch.js', 'staged.js', 'untracked.js']);
  });

  it('leaves staged files out of the default scope', async () => {
    const id = insertLocalReview('unstaged', 'untracked');
    expect((await getDiffFileList(db, reviewRow(id))).sort()).toEqual(['base.js', 'untracked.js']);
  });

  it('prefers the persisted diff snapshot the browser displays', async () => {
    const id = insertLocalReview('branch', 'untracked');
    db.prepare('INSERT INTO local_diffs (review_id, diff_text) VALUES (?, ?)')
      .run(id, 'diff --git a/snapshot.js b/snapshot.js\n--- a/snapshot.js\n+++ b/snapshot.js\n');
    expect(await getReviewDiffFiles(db, reviewRow(id))).toEqual(['snapshot.js']);
  });

  it('falls back to the scope listing without a snapshot', async () => {
    const id = insertLocalReview('staged', 'unstaged');
    expect((await getReviewDiffFiles(db, reviewRow(id))).sort()).toEqual(['base.js', 'staged.js']);
  });

  it('returns an empty list for a missing review', async () => {
    expect(await getReviewDiffFiles(db, null)).toEqual([]);
  });
});

describe('getReviewDiffFiles for PR reviews', () => {
  let db;
  beforeEach(() => { db = createTestDatabase(); });
  afterEach(() => closeTestDatabase(db));

  it('reads the cached PR metadata', async () => {
    db.prepare('INSERT INTO pr_metadata (pr_number, repository, pr_data) VALUES (?, ?, ?)')
      .run(7, 'o/r', JSON.stringify({ changed_files: [{ file: 'a.js' }], diff: '' }));
    expect(await getReviewDiffFiles(db, { id: 1, pr_number: 7, repository: 'o/r' })).toEqual(['a.js']);
  });
});

describe('diffContainsPath', () => {
  const diff = [
    'diff --git a/old.js b/new.js',
    'similarity index 100%',
    'rename from old.js',
    'rename to new.js',
    'diff --git a/kept.js b/kept.js',
    '--- a/kept.js',
    '+++ b/kept.js',
    '@@ -1 +1 @@',
    '-diff --git a/fake.js b/fake.js',
    '+x'
  ].join('\n');

  it('matches old and new paths of each file section', () => {
    expect(diffContainsPath(diff, 'old.js')).toBe(true);
    expect(diffContainsPath(diff, 'new.js')).toBe(true);
    expect(diffContainsPath(diff, 'kept.js')).toBe(true);
    expect(diffContainsPath(diff, 'other.js')).toBe(false);
  });

  it('handles empty input', () => {
    expect(diffContainsPath('', 'a.js')).toBe(false);
    expect(diffContainsPath(diff, '')).toBe(false);
    expect(diffContainsPath(null, 'a.js')).toBe(false);
  });
});
