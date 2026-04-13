// Copyright 2026 Tim Perkins (tjwp) | SPDX-License-Identifier: Apache-2.0
import { describe, it, expect, beforeEach, afterEach, afterAll, vi } from 'vitest';
import { mkdirSync, rmSync } from 'fs';
import { createTestDatabase, closeTestDatabase } from '../utils/schema';

/**
 * Integration tests for GET /api/reviews/:reviewId/file-contents/:fileName(*)
 *
 * This endpoint returns { fileName, oldContents, newContents } for @pierre/diffs
 * hunk expansion. It supports both Local mode (with scope-based old-side resolution)
 * and PR mode (base_sha-based old-side resolution).
 *
 * simple-git validates that the directory exists at construction time, so we create
 * the expected directories up front. The prototype spy on SimpleGitApi.show then
 * intercepts all git-show calls.
 */

// --- Create temp directories so simpleGit(path) doesn't throw ---
const LOCAL_REPO_PATH = '/tmp/_pr-test-local-repo';
const WORKTREE_PATH = '/tmp/_pr-test-worktree';
mkdirSync(LOCAL_REPO_PATH, { recursive: true });
mkdirSync(WORKTREE_PATH, { recursive: true });

// --- Spy on SimpleGitApi.prototype.show via the prototype chain ---
const simpleGit = require('simple-git');
const simpleGitApiProto = Object.getPrototypeOf(Object.getPrototypeOf(simpleGit(LOCAL_REPO_PATH)));
const mockGitShow = vi.spyOn(simpleGitApiProto, 'show');

// Mock findMergeBase from local-review
const localReviewModule = require('../../src/local-review');
vi.spyOn(localReviewModule, 'findMergeBase').mockResolvedValue('merge-base-sha');

// Mock config to prevent reading user's real config
const configModule = require('../../src/config');
vi.spyOn(configModule, 'loadConfig').mockResolvedValue({
  config: { github_token: 'test-token', port: 7247, theme: 'light', monorepos: {} },
  isFirstRun: false
});
vi.spyOn(configModule, 'getConfigDir').mockReturnValue('/tmp/.pair-review-test');

// Mock analyzer (required by analyses routes loaded transitively)
vi.mock('../../src/ai/analyzer', () => ({
  default: vi.fn().mockImplementation(() => ({}))
}));

// Mock gitattributes
vi.mock('../../src/git/gitattributes', () => ({
  getGeneratedFilePatterns: vi.fn().mockResolvedValue({
    isGenerated: vi.fn().mockReturnValue(false),
    getPatterns: vi.fn().mockReturnValue([])
  })
}));

// Mock stack-walker
vi.mock('../../src/github/stack-walker', () => ({
  walkPRStack: vi.fn().mockResolvedValue(null)
}));

// Spy on GitWorktreeManager before loading routes
const { GitWorktreeManager } = require('../../src/git/worktree');
vi.spyOn(GitWorktreeManager.prototype, 'worktreeExists').mockResolvedValue(true);
vi.spyOn(GitWorktreeManager.prototype, 'getWorktreePath').mockResolvedValue(WORKTREE_PATH);

// Spy on fs.promises for readFromFs
const fs = require('fs').promises;
let fsRealpathSpy;
let fsReadFileSpy;

// Import database utilities
const { run, queryOne } = require('../../src/database');

// Load route modules (after mocks)
const express = require('express');
const request = require('supertest');
const reviewsRoutes = require('../../src/routes/reviews');

// --- Cleanup temp directories after all tests ---
afterAll(() => {
  rmSync(LOCAL_REPO_PATH, { recursive: true, force: true });
  rmSync(WORKTREE_PATH, { recursive: true, force: true });
});

function createApp(db) {
  const app = express();
  app.use(express.json());
  app.set('db', db);
  app.set('config', { github_token: 'test-token', port: 7247, theme: 'light' });
  app.use('/', reviewsRoutes);
  return app;
}

async function insertLocalReview(db, overrides = {}) {
  const defaults = {
    repository: 'test-repo',
    status: 'draft',
    review_type: 'local',
    local_path: LOCAL_REPO_PATH,
    local_head_sha: 'head123',
    local_scope_start: 'unstaged',
    local_scope_end: 'untracked',
    local_base_branch: null
  };
  const opts = { ...defaults, ...overrides };
  const result = await run(db, `
    INSERT INTO reviews (pr_number, repository, status, review_type, local_path,
      local_head_sha, local_scope_start, local_scope_end, local_base_branch)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `, [null, opts.repository, opts.status, opts.review_type, opts.local_path,
      opts.local_head_sha, opts.local_scope_start, opts.local_scope_end, opts.local_base_branch]);
  return result.lastID;
}

async function insertPRReview(db, prNumber = 1, repository = 'owner/repo') {
  const result = await run(db, `
    INSERT INTO reviews (pr_number, repository, status, review_type)
    VALUES (?, ?, 'draft', 'pr')
  `, [prNumber, repository]);
  return result.lastID;
}

async function insertPRMetadata(db, prNumber = 1, repository = 'owner/repo', prDataOverrides = {}) {
  const prData = JSON.stringify({
    state: 'open',
    diff: 'diff content',
    changed_files: [{ file: 'file.js', additions: 1, deletions: 0 }],
    base_sha: 'abc123',
    head_sha: 'def456',
    ...prDataOverrides
  });
  await run(db, `
    INSERT INTO pr_metadata (pr_number, repository, title, description, author, base_branch, head_branch, pr_data)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `, [prNumber, repository, 'Test PR', 'Desc', 'user', 'main', 'feature', prData]);
}

async function insertWorktree(db, prNumber = 1, repository = 'owner/repo') {
  const now = new Date().toISOString();
  await run(db, `
    INSERT INTO worktrees (id, pr_number, repository, branch, path, created_at, last_accessed_at)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `, ['wt-test', prNumber, repository, 'feature', WORKTREE_PATH, now, now]);
}

// ============================================================================
// Local Mode Tests
// ============================================================================

describe('GET /api/reviews/:reviewId/file-contents/:fileName — Local Mode', () => {
  let db, app;

  beforeEach(async () => {
    db = await createTestDatabase();
    app = createApp(db);
    vi.clearAllMocks();
    fsRealpathSpy = vi.spyOn(fs, 'realpath');
    fsReadFileSpy = vi.spyOn(fs, 'readFile');
  });

  afterEach(async () => {
    if (db) await closeTestDatabase(db);
    fsRealpathSpy?.mockRestore();
    fsReadFileSpy?.mockRestore();
  });

  it('should return oldContents and newContents for unstaged scope', async () => {
    // Default scope: unstaged->untracked. Old = index version (git show :path)
    const reviewId = await insertLocalReview(db);

    mockGitShow.mockResolvedValue('old index content');
    fsRealpathSpy.mockImplementation(async (p) => p);
    fsReadFileSpy.mockResolvedValue('new filesystem content');

    const res = await request(app)
      .get(`/api/reviews/${reviewId}/file-contents/src/app.js`);

    expect(res.status).toBe(200);
    expect(res.body.fileName).toBe('src/app.js');
    expect(res.body.oldContents).toBe('old index content');
    expect(res.body.newContents).toBe('new filesystem content');

    // Verify git show was called with :<path> (index ref)
    expect(mockGitShow).toHaveBeenCalledWith([':src/app.js']);
  });

  it('should use HEAD ref for old side when scope includes staged', async () => {
    // Scope: staged->unstaged. Old = HEAD version
    const reviewId = await insertLocalReview(db, {
      local_scope_start: 'staged',
      local_scope_end: 'unstaged'
    });

    mockGitShow.mockResolvedValue('HEAD content');
    fsRealpathSpy.mockImplementation(async (p) => p);
    fsReadFileSpy.mockResolvedValue('working tree content');

    const res = await request(app)
      .get(`/api/reviews/${reviewId}/file-contents/src/app.js`);

    expect(res.status).toBe(200);
    expect(res.body.oldContents).toBe('HEAD content');
    expect(res.body.newContents).toBe('working tree content');
    expect(mockGitShow).toHaveBeenCalledWith(['HEAD:src/app.js']);
  });

  it('should use merge-base ref for old side when scope includes branch', async () => {
    const reviewId = await insertLocalReview(db, {
      local_scope_start: 'branch',
      local_scope_end: 'unstaged',
      local_base_branch: 'main'
    });

    localReviewModule.findMergeBase.mockResolvedValue('deadbeef');
    mockGitShow.mockResolvedValue('merge-base content');
    fsRealpathSpy.mockImplementation(async (p) => p);
    fsReadFileSpy.mockResolvedValue('working content');

    const res = await request(app)
      .get(`/api/reviews/${reviewId}/file-contents/src/app.js`);

    expect(res.status).toBe(200);
    expect(res.body.oldContents).toBe('merge-base content');
    expect(res.body.newContents).toBe('working content');

    expect(localReviewModule.findMergeBase).toHaveBeenCalledWith(LOCAL_REPO_PATH, 'main');
    expect(mockGitShow).toHaveBeenCalledWith(['deadbeef:src/app.js']);
  });

  it('should set oldContents=null when branch scope but no local_base_branch configured', async () => {
    const reviewId = await insertLocalReview(db, {
      local_scope_start: 'branch',
      local_scope_end: 'unstaged',
      local_base_branch: null
    });

    fsRealpathSpy.mockImplementation(async (p) => p);
    fsReadFileSpy.mockResolvedValue('new content');

    const res = await request(app)
      .get(`/api/reviews/${reviewId}/file-contents/src/app.js`);

    expect(res.status).toBe(200);
    expect(res.body.oldContents).toBeNull();
    expect(res.body.newContents).toBe('new content');
    // findMergeBase should NOT be called when local_base_branch is null
    expect(localReviewModule.findMergeBase).not.toHaveBeenCalled();
  });

  it('should set oldContents=null when merge-base lookup fails', async () => {
    const reviewId = await insertLocalReview(db, {
      local_scope_start: 'branch',
      local_scope_end: 'unstaged',
      local_base_branch: 'main'
    });

    localReviewModule.findMergeBase.mockRejectedValue(new Error('no merge base'));
    fsRealpathSpy.mockImplementation(async (p) => p);
    fsReadFileSpy.mockResolvedValue('new content');

    const res = await request(app)
      .get(`/api/reviews/${reviewId}/file-contents/src/app.js`);

    expect(res.status).toBe(200);
    expect(res.body.oldContents).toBeNull();
    expect(res.body.newContents).toBe('new content');
  });

  it('should skip old file fetch when status=added', async () => {
    const reviewId = await insertLocalReview(db);

    fsRealpathSpy.mockImplementation(async (p) => p);
    fsReadFileSpy.mockResolvedValue('brand new file');

    const res = await request(app)
      .get(`/api/reviews/${reviewId}/file-contents/src/new.js`)
      .query({ status: 'added' });

    expect(res.status).toBe(200);
    expect(res.body.oldContents).toBeNull();
    expect(res.body.newContents).toBe('brand new file');
    // git show should NOT have been called for old side
    expect(mockGitShow).not.toHaveBeenCalled();
  });

  it('should skip new file fetch when status=deleted', async () => {
    const reviewId = await insertLocalReview(db);

    mockGitShow.mockResolvedValue('deleted file content');

    const res = await request(app)
      .get(`/api/reviews/${reviewId}/file-contents/src/removed.js`)
      .query({ status: 'deleted' });

    expect(res.status).toBe(200);
    expect(res.body.oldContents).toBe('deleted file content');
    expect(res.body.newContents).toBeNull();
    // readFromFs should NOT have been called
    expect(fsRealpathSpy).not.toHaveBeenCalled();
  });

  it('should use oldPath for old-side when status=renamed', async () => {
    const reviewId = await insertLocalReview(db);

    mockGitShow.mockResolvedValue('content at old path');
    fsRealpathSpy.mockImplementation(async (p) => p);
    fsReadFileSpy.mockResolvedValue('content at new path');

    const res = await request(app)
      .get(`/api/reviews/${reviewId}/file-contents/src/new-name.js`)
      .query({ status: 'renamed', oldPath: 'src/old-name.js' });

    expect(res.status).toBe(200);
    expect(res.body.fileName).toBe('src/new-name.js');
    expect(res.body.oldContents).toBe('content at old path');
    expect(res.body.newContents).toBe('content at new path');

    // Old side should use the oldPath
    expect(mockGitShow).toHaveBeenCalledWith([':src/old-name.js']);
  });

  it('should return 404 when local review is missing path', async () => {
    const reviewId = await insertLocalReview(db, { local_path: null });

    const res = await request(app)
      .get(`/api/reviews/${reviewId}/file-contents/src/app.js`);

    expect(res.status).toBe(404);
    expect(res.body.error).toContain('missing path');
  });

  it('should return null for newContents when readFromFs fails (path traversal)', async () => {
    const reviewId = await insertLocalReview(db);

    mockGitShow.mockResolvedValue('old content');
    // Simulate traversal: realpath resolves outside the base
    fsRealpathSpy.mockImplementation(async (p) => {
      if (p === LOCAL_REPO_PATH) return LOCAL_REPO_PATH;
      return '/etc/passwd';
    });

    const res = await request(app)
      .get(`/api/reviews/${reviewId}/file-contents/evil-symlink`);

    expect(res.status).toBe(200);
    // readFromFs returns null when path escapes base
    expect(res.body.newContents).toBeNull();
  });

  it('should detect binary content (null bytes) and return binary flag', async () => {
    const reviewId = await insertLocalReview(db);

    mockGitShow.mockResolvedValue('old content');
    fsRealpathSpy.mockImplementation(async (p) => p);
    fsReadFileSpy.mockResolvedValue('binary\0content');

    const res = await request(app)
      .get(`/api/reviews/${reviewId}/file-contents/image.png`);

    expect(res.status).toBe(200);
    expect(res.body.binary).toBe(true);
    expect(res.body.oldContents).toBeNull();
    expect(res.body.newContents).toBeNull();
  });

  it('should detect binary content in old side too', async () => {
    const reviewId = await insertLocalReview(db);

    mockGitShow.mockResolvedValue('old\0binary');
    fsRealpathSpy.mockImplementation(async (p) => p);
    fsReadFileSpy.mockResolvedValue('new text content');

    const res = await request(app)
      .get(`/api/reviews/${reviewId}/file-contents/data.bin`);

    expect(res.status).toBe(200);
    expect(res.body.binary).toBe(true);
  });

  it('should detect files exceeding 2MB size limit', async () => {
    const reviewId = await insertLocalReview(db);

    const largeContent = 'x'.repeat(2 * 1024 * 1024 + 1);
    mockGitShow.mockResolvedValue('small old');
    fsRealpathSpy.mockImplementation(async (p) => p);
    fsReadFileSpy.mockResolvedValue(largeContent);

    const res = await request(app)
      .get(`/api/reviews/${reviewId}/file-contents/huge.js`);

    expect(res.status).toBe(200);
    expect(res.body.tooLarge).toBe(true);
  });

  it('should reject fileName containing null bytes', async () => {
    const reviewId = await insertLocalReview(db);

    const res = await request(app)
      .get(`/api/reviews/${reviewId}/file-contents/bad%00name.js`);

    expect(res.status).toBe(400);
    expect(res.body.error).toContain('Invalid file name');
  });
});

// ============================================================================
// PR Mode Tests
// ============================================================================

describe('GET /api/reviews/:reviewId/file-contents/:fileName — PR Mode', () => {
  let db, app;

  beforeEach(async () => {
    db = await createTestDatabase();
    app = createApp(db);
    vi.clearAllMocks();
    // Restore default worktree mock behavior
    vi.spyOn(GitWorktreeManager.prototype, 'worktreeExists').mockResolvedValue(true);
    vi.spyOn(GitWorktreeManager.prototype, 'getWorktreePath').mockResolvedValue(WORKTREE_PATH);
    fsRealpathSpy = vi.spyOn(fs, 'realpath');
    fsReadFileSpy = vi.spyOn(fs, 'readFile');
  });

  afterEach(async () => {
    if (db) await closeTestDatabase(db);
    fsRealpathSpy?.mockRestore();
    fsReadFileSpy?.mockRestore();
  });

  it('should return old from base_sha and new from HEAD', async () => {
    const reviewId = await insertPRReview(db);
    await insertPRMetadata(db);
    await insertWorktree(db);

    mockGitShow.mockImplementation(async ([ref]) => {
      if (ref === 'abc123:src/app.js') return 'base version';
      if (ref === 'HEAD:src/app.js') return 'head version';
      return null;
    });

    const res = await request(app)
      .get(`/api/reviews/${reviewId}/file-contents/src/app.js`);

    expect(res.status).toBe(200);
    expect(res.body.fileName).toBe('src/app.js');
    expect(res.body.oldContents).toBe('base version');
    expect(res.body.newContents).toBe('head version');
  });

  it('should skip old fetch when status=added', async () => {
    const reviewId = await insertPRReview(db);
    await insertPRMetadata(db);
    await insertWorktree(db);

    mockGitShow.mockImplementation(async ([ref]) => {
      if (ref === 'HEAD:src/new.js') return 'new file content';
      return null;
    });

    const res = await request(app)
      .get(`/api/reviews/${reviewId}/file-contents/src/new.js`)
      .query({ status: 'added' });

    expect(res.status).toBe(200);
    expect(res.body.oldContents).toBeNull();
    expect(res.body.newContents).toBe('new file content');
  });

  it('should skip new fetch when status=deleted', async () => {
    const reviewId = await insertPRReview(db);
    await insertPRMetadata(db);
    await insertWorktree(db);

    mockGitShow.mockImplementation(async ([ref]) => {
      if (ref === 'abc123:src/removed.js') return 'deleted content';
      return null;
    });

    const res = await request(app)
      .get(`/api/reviews/${reviewId}/file-contents/src/removed.js`)
      .query({ status: 'deleted' });

    expect(res.status).toBe(200);
    expect(res.body.oldContents).toBe('deleted content');
    expect(res.body.newContents).toBeNull();
  });

  it('should use oldPath for old-side on renames', async () => {
    const reviewId = await insertPRReview(db);
    await insertPRMetadata(db);
    await insertWorktree(db);

    mockGitShow.mockImplementation(async ([ref]) => {
      if (ref === 'abc123:src/old.js') return 'old-path content';
      if (ref === 'HEAD:src/new.js') return 'new-path content';
      return null;
    });

    const res = await request(app)
      .get(`/api/reviews/${reviewId}/file-contents/src/new.js`)
      .query({ status: 'renamed', oldPath: 'src/old.js' });

    expect(res.status).toBe(200);
    expect(res.body.oldContents).toBe('old-path content');
    expect(res.body.newContents).toBe('new-path content');
  });

  it('should return 404 when worktree does not exist', async () => {
    const reviewId = await insertPRReview(db);
    await insertPRMetadata(db);
    vi.spyOn(GitWorktreeManager.prototype, 'worktreeExists').mockResolvedValueOnce(false);

    const res = await request(app)
      .get(`/api/reviews/${reviewId}/file-contents/src/app.js`);

    expect(res.status).toBe(404);
    expect(res.body.error).toContain('Worktree not found');
  });

  it('should return 400 when review has no PR metadata', async () => {
    // Insert a PR-type review with null pr_number
    const result = await run(db, `
      INSERT INTO reviews (pr_number, repository, status, review_type)
      VALUES (?, ?, 'draft', 'pr')
    `, [null, 'owner/repo']);
    const reviewId = result.lastID;

    const res = await request(app)
      .get(`/api/reviews/${reviewId}/file-contents/src/app.js`);

    expect(res.status).toBe(400);
    expect(res.body.error).toContain('missing PR metadata');
  });

  it('should handle missing base_sha gracefully (old=null)', async () => {
    const reviewId = await insertPRReview(db);
    // Insert PR metadata without base_sha
    await insertPRMetadata(db, 1, 'owner/repo', { base_sha: undefined });
    await insertWorktree(db);

    mockGitShow.mockResolvedValue('head content');

    const res = await request(app)
      .get(`/api/reviews/${reviewId}/file-contents/src/app.js`);

    expect(res.status).toBe(200);
    // No base_sha -> old side not fetched
    expect(res.body.oldContents).toBeNull();
    expect(res.body.newContents).toBe('head content');
  });

  it('should handle corrupted pr_data JSON gracefully', async () => {
    const reviewId = await insertPRReview(db);
    await run(db, `
      INSERT INTO pr_metadata (pr_number, repository, title, description, author, base_branch, head_branch, pr_data)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `, [1, 'owner/repo', 'PR', 'Desc', 'user', 'main', 'feat', 'not-json']);
    await insertWorktree(db);

    mockGitShow.mockResolvedValue('head content');

    const res = await request(app)
      .get(`/api/reviews/${reviewId}/file-contents/src/app.js`);

    expect(res.status).toBe(200);
    expect(res.body.oldContents).toBeNull();
    expect(res.body.newContents).toBe('head content');
  });

  it('should detect binary content in PR mode', async () => {
    const reviewId = await insertPRReview(db);
    await insertPRMetadata(db);
    await insertWorktree(db);

    mockGitShow.mockImplementation(async ([ref]) => {
      if (ref === 'abc123:img.png') return 'binary\0data';
      if (ref === 'HEAD:img.png') return 'binary\0data';
      return null;
    });

    const res = await request(app)
      .get(`/api/reviews/${reviewId}/file-contents/img.png`);

    expect(res.status).toBe(200);
    expect(res.body.binary).toBe(true);
  });

  it('should detect oversized files in PR mode', async () => {
    const reviewId = await insertPRReview(db);
    await insertPRMetadata(db);
    await insertWorktree(db);

    const huge = 'x'.repeat(2 * 1024 * 1024 + 1);
    mockGitShow.mockResolvedValue(huge);

    const res = await request(app)
      .get(`/api/reviews/${reviewId}/file-contents/big.js`);

    expect(res.status).toBe(200);
    expect(res.body.tooLarge).toBe(true);
  });
});

// ============================================================================
// Shared / Edge-case Tests
// ============================================================================

describe('GET /api/reviews/:reviewId/file-contents/:fileName — Shared', () => {
  let db, app;

  beforeEach(async () => {
    db = await createTestDatabase();
    app = createApp(db);
    vi.clearAllMocks();
    fsRealpathSpy = vi.spyOn(fs, 'realpath');
    fsReadFileSpy = vi.spyOn(fs, 'readFile');
  });

  afterEach(async () => {
    if (db) await closeTestDatabase(db);
    fsRealpathSpy?.mockRestore();
    fsReadFileSpy?.mockRestore();
  });

  it('should return 400 for invalid review ID', async () => {
    const res = await request(app)
      .get('/api/reviews/abc/file-contents/src/app.js');

    expect(res.status).toBe(400);
    expect(res.body.error).toContain('Invalid review ID');
  });

  it('should return 404 for non-existent review', async () => {
    const res = await request(app)
      .get('/api/reviews/9999/file-contents/src/app.js');

    expect(res.status).toBe(404);
    expect(res.body.error).toContain('not found');
  });

  it('should handle URL-encoded file names with slashes', async () => {
    const reviewId = await insertLocalReview(db);

    mockGitShow.mockResolvedValue('old');
    fsRealpathSpy.mockImplementation(async (p) => p);
    fsReadFileSpy.mockResolvedValue('new');

    const res = await request(app)
      .get(`/api/reviews/${reviewId}/file-contents/src%2Futils%2Fhelper.js`);

    expect(res.status).toBe(200);
    expect(res.body.fileName).toBe('src/utils/helper.js');
  });

  it('should return both null when git show fails and fs read fails', async () => {
    const reviewId = await insertLocalReview(db);

    mockGitShow.mockRejectedValue(new Error('git error'));
    fsRealpathSpy.mockRejectedValue(new Error('ENOENT'));

    const res = await request(app)
      .get(`/api/reviews/${reviewId}/file-contents/missing.js`);

    expect(res.status).toBe(200);
    expect(res.body.oldContents).toBeNull();
    expect(res.body.newContents).toBeNull();
  });
});
