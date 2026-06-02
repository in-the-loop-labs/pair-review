// Copyright 2026 Tim Perkins (tjwp) | SPDX-License-Identifier: Apache-2.0
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import express from 'express';
import request from 'supertest';
import { createTestDatabase, closeTestDatabase } from '../utils/schema';

/**
 * PR-mode refresh kickoff tests
 *
 * Mirror of `local-sessions.test.js > kickOff* on diff-changing endpoints`
 * but for POST /api/pr/:owner/:repo/:number/refresh. CLAUDE.md mandates
 * Local/PR parity for cross-cutting behavior; the PR path constructs a
 * non-trivial `reviewContext.changedFiles` (mapping through string /
 * filename / file / path fallbacks) that has no other test coverage.
 */

const { GitWorktreeManager } = require('../../src/git/worktree');
const { GitHubClient } = require('../../src/github/client');
const configModule = require('../../src/config');

vi.spyOn(GitWorktreeManager.prototype, 'getWorktreePath').mockResolvedValue('/tmp/worktree/test');
vi.spyOn(GitWorktreeManager.prototype, 'updateWorktree').mockResolvedValue('/tmp/worktree/test');
vi.spyOn(GitWorktreeManager.prototype, 'generateUnifiedDiff').mockResolvedValue(
  'diff --git a/file.js b/file.js\n--- a/file.js\n+++ b/file.js\n@@ -1,2 +1,3 @@\n+added\n line1\n line2'
);
vi.spyOn(GitWorktreeManager.prototype, 'getChangedFiles').mockResolvedValue([
  { file: 'file.js', additions: 1, deletions: 0 }
]);

vi.spyOn(GitHubClient.prototype, 'fetchPullRequest').mockResolvedValue({
  title: 'Refreshed PR',
  body: 'Refreshed description',
  author: 'testuser',
  base_branch: 'main',
  head_branch: 'feature',
  state: 'open',
  base_sha: 'abc123',
  head_sha: 'def456',
  node_id: 'PR_node1',
  html_url: 'https://github.com/owner/repo/pull/1',
  additions: 10,
  deletions: 5
});

vi.spyOn(configModule, 'getGitHubToken').mockReturnValue('test-token');
vi.spyOn(configModule, 'getConfigDir').mockReturnValue('/tmp/.pair-review-test');

vi.mock('../../src/github/stack-walker', () => ({
  walkPRStack: vi.fn().mockResolvedValue(null)
}));
vi.mock('../../src/events/review-events', () => ({
  broadcastReviewEvent: vi.fn()
}));

const prRoutes = require('../../src/routes/pr');
const summaryGenerator = require('../../src/ai/summary-generator');
const tourGenerator = require('../../src/ai/tour-generator');
const { run } = require('../../src/database');

function createTestApp(db, config = {}) {
  const app = express();
  app.use(express.json());
  app.set('db', db);
  app.set('githubToken', 'test-token');
  app.set('config', {
    github_token: 'test-token',
    port: 7247,
    theme: 'light',
    summaries: { enabled: true },
    tours: { enabled: true },
    ...config
  });
  app.use('/', prRoutes);
  return app;
}

async function insertTestPR(db, { prNumber = 1, repository = 'owner/repo' } = {}) {
  const prData = JSON.stringify({
    state: 'open',
    diff: 'old diff content',
    changed_files: [{ file: 'old.js', additions: 1, deletions: 0 }],
    additions: 1,
    deletions: 0,
    html_url: `https://github.com/${repository}/pull/${prNumber}`,
    base_sha: 'oldbase',
    head_sha: 'oldhead',
    node_id: 'PR_old'
  });
  await run(db, `
    INSERT INTO pr_metadata (pr_number, repository, title, description, author, base_branch, head_branch, pr_data)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `, [prNumber, repository, 'Old Title', 'Old Description', 'testuser', 'main', 'feature', prData]);

  await run(db, `
    INSERT INTO reviews (pr_number, repository, status, created_at, updated_at)
    VALUES (?, ?, 'draft', datetime('now'), datetime('now'))
  `, [prNumber, repository]);
}

describe('POST /api/pr/:owner/:repo/:number/refresh kickoffs', () => {
  let db;
  let app;
  let summarySpy;
  let tourSpy;

  beforeEach(async () => {
    db = createTestDatabase();
    app = createTestApp(db);
    await insertTestPR(db);
    summarySpy = vi.spyOn(summaryGenerator, 'kickOffSummaryJob').mockReturnValue(null);
    tourSpy = vi.spyOn(tourGenerator, 'kickOffTourJob').mockReturnValue(null);
  });

  afterEach(() => {
    if (db) closeTestDatabase(db);
    summarySpy.mockRestore();
    tourSpy.mockRestore();
  });

  it('kicks off summary and tour jobs with the freshly-refreshed diff and worktree path', async () => {
    const res = await request(app).post('/api/pr/owner/repo/1/refresh').send({});
    expect(res.status).toBe(200);

    // Kickoffs are fired-and-forgotten after res.json. Yield microtasks so
    // the IIFE has a chance to run before assertions.
    await new Promise((resolve) => setImmediate(resolve));

    expect(summarySpy).toHaveBeenCalledTimes(1);
    expect(tourSpy).toHaveBeenCalledTimes(1);

    const summaryArgs = summarySpy.mock.calls[0][0];
    expect(summaryArgs.reviewId).toBe(res.body.data.id);
    expect(summaryArgs.diffText).toContain('diff --git a/file.js b/file.js');
    expect(summaryArgs.worktreePath).toBe('/tmp/worktree/test');
    expect(summaryArgs.config).toMatchObject({
      summaries: { enabled: true },
      tours: { enabled: true }
    });
    expect(summaryArgs.reviewContext).toEqual({
      prTitle: 'Refreshed PR',
      prDescription: 'Refreshed description',
      changedFiles: ['file.js']
    });

    const tourArgs = tourSpy.mock.calls[0][0];
    expect(tourArgs.reviewId).toBe(res.body.data.id);
    expect(tourArgs.diffText).toContain('diff --git a/file.js b/file.js');
    expect(tourArgs.worktreePath).toBe('/tmp/worktree/test');
    expect(tourArgs.reviewContext).toEqual({
      prTitle: 'Refreshed PR',
      prDescription: 'Refreshed description',
      changedFiles: ['file.js']
    });
  });

  it('maps changedFiles through fallback shapes: string / filename / file / path', async () => {
    // The PR refresh route maps `changedFiles` through the chain
    //   typeof f === 'string' ? f : (f.filename || f.file || f.path)
    // then drops falsy entries. This test makes that mapping observable by
    // feeding a heterogeneous array via the GitWorktreeManager spy.
    GitWorktreeManager.prototype.getChangedFiles.mockResolvedValueOnce([
      'plain-string.js',
      { filename: 'has-filename.js', additions: 1 },
      { file: 'has-file.js', additions: 1 },
      { path: 'has-path.js', additions: 1 },
      { unknown: 'shape' } // falsy → dropped by filter(Boolean)
    ]);

    const res = await request(app).post('/api/pr/owner/repo/1/refresh').send({});
    expect(res.status).toBe(200);

    await new Promise((resolve) => setImmediate(resolve));

    expect(summarySpy).toHaveBeenCalledTimes(1);
    const summaryArgs = summarySpy.mock.calls[0][0];
    expect(summaryArgs.reviewContext.changedFiles).toEqual([
      'plain-string.js',
      'has-filename.js',
      'has-file.js',
      'has-path.js'
    ]);
  });
});
