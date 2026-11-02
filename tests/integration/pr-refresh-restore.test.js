// Copyright 2026 Tim Perkins (tjwp) | SPDX-License-Identifier: Apache-2.0
import { describe, it, expect, beforeEach, afterEach, afterAll, vi } from 'vitest';
import express from 'express';
import request from 'supertest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { createTestDatabase, closeTestDatabase } from '../utils/schema';
import { listenOnLoopback, closeServer } from '../utils/loopback-server';

const testDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pair-review-restore-'));
const repositoryPath = path.join(testDir, 'repos', 'owner', 'repo');
const configModule = require('../../src/config');
// Install before loading routes: CommonJS consumers destructure these exports.
vi.spyOn(configModule, 'getConfigDir').mockReturnValue(testDir);
vi.spyOn(configModule, 'getGitHubToken').mockReturnValue('test-token');
const shared = require('../../src/routes/shared');
const progressSpy = vi.spyOn(shared, 'broadcastSetupProgress').mockImplementation(() => {});
const { GitHubClient } = require('../../src/github/client');
const { GitWorktreeManager } = require('../../src/git/worktree');
const { WorktreePoolLifecycle } = require('../../src/git/worktree-pool-lifecycle');
const summaryGenerator = require('../../src/ai/summary-generator');
const tourGenerator = require('../../src/ai/tour-generator');
const stackWalker = require('../../src/github/stack-walker');
const stackSpy = vi.spyOn(stackWalker, 'walkPRStack').mockResolvedValue(null);
const prRoutes = require('../../src/routes/pr');
const setupRoutes = require('../../src/routes/setup');

const freshPR = {
  title: 'Refreshed PR', body: 'Refreshed description', author: 'newauthor',
  base_branch: 'main', head_branch: 'feature', state: 'open',
  // Stored flat metadata wins over a conflicting nested ref in every path.
  head: { ref: 'outdated-nested-feature' },
  base_sha: 'base-sha', head_sha: 'head-sha', node_id: 'PR_node',
  repository: { default_branch: 'main', clone_url: 'https://github.com/owner/repo.git' }
};

function createMockGit() {
  return {
    fetch: vi.fn().mockResolvedValue(undefined),
    raw: vi.fn(async (args) => args[0] === 'cat-file' ? 'commit\n' : ''),
    checkout: vi.fn().mockResolvedValue(undefined),
    revparse: vi.fn().mockResolvedValue('head-sha\n'),
    branch: vi.fn().mockResolvedValue(undefined)
  };
}

describe.each([0, 1])('refresh → missing worktree → restore (pool_size=%i)', (poolSize) => {
  let db;
  let server;
  let git;
  let scriptSpy;
  let fetchSpy;

  beforeEach(async () => {
    db = createTestDatabase();
    progressSpy.mockClear();
    git = createMockGit();
    // Keep real route, setup, pool lifecycle, and worktree persistence code.
    // Only GitHub and OS/git boundaries are replaced; nothing touches real worktrees.
    fetchSpy = vi.spyOn(GitHubClient.prototype, 'fetchPullRequest').mockResolvedValue(freshPR);
    vi.spyOn(summaryGenerator, 'kickOffSummaryJob').mockResolvedValue(null);
    vi.spyOn(tourGenerator, 'kickOffTourJob').mockResolvedValue(null);
    vi.spyOn(GitWorktreeManager.prototype, 'getWorktreePath').mockResolvedValue(null);
    vi.spyOn(GitWorktreeManager.prototype, 'updateWorktree').mockResolvedValue(path.join(testDir, 'old-worktree'));
    vi.spyOn(GitWorktreeManager.prototype, 'generateUnifiedDiff').mockResolvedValue('refreshed diff');
    vi.spyOn(GitWorktreeManager.prototype, 'getChangedFiles').mockResolvedValue([{ file: 'file.js' }]);
    vi.spyOn(GitWorktreeManager.prototype, 'pathExists').mockImplementation(async (p) => p === repositoryPath);
    vi.spyOn(GitWorktreeManager.prototype, 'ensureWorktreeBaseDir').mockResolvedValue(undefined);
    vi.spyOn(GitWorktreeManager.prototype, 'cleanupWorktree').mockResolvedValue(undefined);
    vi.spyOn(GitWorktreeManager.prototype, '_gitFor').mockReturnValue(git);
    vi.spyOn(GitWorktreeManager.prototype, 'resolveRemoteForPR').mockResolvedValue('origin');
    vi.spyOn(GitWorktreeManager.prototype, 'fetchPRHead').mockResolvedValue({ checkoutTarget: 'pr-1' });
    scriptSpy = vi.spyOn(GitWorktreeManager.prototype, 'executeCheckoutScript').mockResolvedValue({});

    const config = {
      github_token: 'test-token',
      repos: { 'owner/repo': {
        pool_size: poolSize,
        checkout_script: path.join(testDir, 'checkout.sh'),
        worktree_directory: path.join(testDir, 'worktrees')
      } }
    };
    const app = express();
    app.use(express.json());
    app.set('db', db);
    app.set('config', config);
    app.set('poolLifecycle', new WorktreePoolLifecycle(db, config));
    app.use(prRoutes);
    app.use(setupRoutes);
    server = await listenOnLoopback(app);

    db.prepare(`INSERT INTO pr_metadata
      (pr_number, repository, title, description, author, base_branch, head_branch, pr_data)
      VALUES (1, 'owner/repo', 'Old title', 'Old body', 'oldauthor', 'main', 'feature', ?)`)
      .run(JSON.stringify({
        title: 'Old title', head_sha: 'old-head', base_sha: 'old-base',
        viewedFiles: ['file.js'], repository: { default_branch: 'main' },
        customCachedField: 'preserved'
      }));
    db.prepare(`INSERT INTO worktrees (id, pr_number, repository, branch, path, created_at, last_accessed_at)
      VALUES ('old-worktree', 1, 'owner/repo', 'feature', ?, datetime('now'), datetime('now'))`)
      .run(path.join(testDir, 'old-worktree'));
  });

  afterEach(async () => {
    // Await the actual background setup even when an assertion fails.
    await Promise.all([...shared.activeSetups.values()].map(({ promise }) => promise));
    await closeServer(server);
    shared.activeSetups.clear();
    closeTestDatabase(db);
    // Preserve the three module-load spies captured by destructured imports.
    for (const target of [GitHubClient.prototype, GitWorktreeManager.prototype]) {
      for (const value of Object.getOwnPropertyNames(target).map((key) => target[key])) {
        if (vi.isMockFunction(value)) value.mockRestore();
      }
    }
    summaryGenerator.kickOffSummaryJob.mockRestore();
    tourGenerator.kickOffTourJob.mockRestore();
  });

  async function restoreAndAssert() {
    // Simulate cleanup removing the worktree while keeping PR metadata.
    db.prepare('DELETE FROM worktrees').run();
    fetchSpy.mockClear();
    const res = await request(server).post('/api/setup/pr/owner/repo/1').send({});
    expect(res.status).toBe(200);
    expect(res.body.setupId).toBeTruthy();
    await vi.waitFor(() => {
      expect(progressSpy).toHaveBeenCalledWith(res.body.setupId, expect.objectContaining({ type: 'complete' }));
    });
    expect(progressSpy).toHaveBeenCalledWith(res.body.setupId, {
      type: 'complete', reviewUrl: '/pr/owner/repo/1', title: freshPR.title
    });
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(db.prepare('SELECT branch FROM worktrees WHERE pr_number = 1').get().branch).toBe('feature');
    expect(scriptSpy).toHaveBeenCalledWith(
      path.join(testDir, 'checkout.sh'), expect.any(String),
      expect.objectContaining({ HEAD_BRANCH: 'feature', BASE_BRANCH: 'main' }), expect.any(Number)
    );
    expect(git.raw).toHaveBeenCalledWith([
      'worktree', 'add', '--no-checkout', expect.any(String), 'origin/main'
    ]);
    expect(git.fetch).toHaveBeenCalledWith([
      '--no-tags', 'origin', '+refs/heads/main:refs/remotes/origin/main'
    ]);
    const pool = db.prepare('SELECT status, current_review_id FROM worktree_pool').get();
    if (poolSize) {
      expect(pool.status).toBe('in_use');
      expect(pool.current_review_id).toBeTruthy();
    } else {
      expect(pool).toBeUndefined();
    }
  }

  it('preserves metadata and review state through refresh and restores without fetching GitHub', async () => {
    const refreshed = await request(server).post('/api/pr/owner/repo/1/refresh').send({});
    expect(refreshed.status).toBe(200);
    const row = db.prepare('SELECT author, pr_data FROM pr_metadata').get();
    expect(row.author).toBe('newauthor');
    expect(JSON.parse(row.pr_data)).toMatchObject({
      ...freshPR, diff: 'refreshed diff', changed_files: [{ file: 'file.js' }],
      viewedFiles: ['file.js'], customCachedField: 'preserved'
    });
    await restoreAndAssert();
  });

  it('repairs legacy slim JSON using the metadata columns without a migration', async () => {
    // Exactly the metadata shape written by the old refresh endpoint.
    const slim = { state: 'open', diff: 'stored diff', base_sha: 'base-sha', head_sha: 'head-sha' };
    const json = JSON.stringify(slim);
    db.prepare(`UPDATE pr_metadata SET title = ?, description = ?, author = ?, pr_data = ?`)
      .run(freshPR.title, freshPR.body, freshPR.author, json);
    await restoreAndAssert();
    // Restore is read-only for the stored snapshot (including viewed-file state).
    expect(db.prepare('SELECT pr_data FROM pr_metadata').get().pr_data).toBe(json);
  });
});

afterAll(() => {
  stackSpy.mockRestore();
  progressSpy.mockRestore();
  configModule.getConfigDir.mockRestore();
  configModule.getGitHubToken.mockRestore();
  fs.rmSync(testDir, { recursive: true, force: true });
});
