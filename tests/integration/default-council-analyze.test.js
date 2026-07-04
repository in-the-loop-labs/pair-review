// Copyright 2026 Tim Perkins (tjwp) | SPDX-License-Identifier: Apache-2.0
/**
 * Integration tests for repo default-council parity in the plain "Analyze"
 * routes (POST .../analyses).
 *
 * These guard the web-route side of the headless/web parity fix: a repo's saved
 * `repo_settings.default_council_id` must be honored by the interactive
 * "Analyze" default path (no explicit provider/model in the request body), so it
 * dispatches to the same council analysis path the explicit council endpoint
 * uses. Conversely:
 *   - a repo WITHOUT a default council still runs single-provider (regression
 *     guard — behavior must be byte-identical to before the fix), and
 *   - an explicit provider/model in the request body always wins over the repo
 *     default council.
 *
 * Covers BOTH PR mode and local mode (CLAUDE.md Local/PR parity).
 */

import { describe, it, expect, beforeEach, afterEach, afterAll, vi } from 'vitest';
import express from 'express';
import request from 'supertest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { createTestDatabase, closeTestDatabase } from '../utils/schema';
import { listenOnLoopback, closeServer } from '../utils/loopback-server';

// --- Module mocks (analysis routes depend on these but we don't exercise them) ---

// NOTE: vi.mock does NOT intercept require('../ai/analyzer') from inside the
// CommonJS route modules (documented project gotcha — see routes.test.js). So we
// observe the single-provider path by spying on the REAL Analyzer prototype's
// analyzeLevel1: the spy records the provider/model captured on `this`
// (Analyzer stores them as this.provider/this.model) and resolves immediately
// so no real CLI is spawned.
const Analyzer = require('../../src/ai/analyzer');
const analyzerCalls = { single: [], reset() { this.single.length = 0; } };

vi.mock('../../src/git/gitattributes', () => ({
  getGeneratedFilePatterns: vi.fn().mockResolvedValue({
    isGenerated: vi.fn().mockReturnValue(false)
  })
}));

// Local-mode prep helpers — keep them off the real filesystem/git.
vi.mock('../../src/local-review', () => ({
  generateScopedDiff: vi.fn().mockResolvedValue({ diff: 'diff', stats: {}, mergeBaseSha: null }),
  computeScopedDigest: vi.fn().mockResolvedValue('digest123'),
  findMergeBase: vi.fn().mockResolvedValue('base123'),
  getCurrentBranch: vi.fn().mockResolvedValue('feature'),
  getRepositoryName: vi.fn().mockResolvedValue('local-repo'),
  getBranchCommitCount: vi.fn().mockResolvedValue(1),
  getFirstCommitSubject: vi.fn().mockResolvedValue('subject'),
  detectAndBuildBranchInfo: vi.fn().mockResolvedValue(null)
}));

const executableAnalysis = require('../../src/routes/executable-analysis');
vi.spyOn(executableAnalysis, 'getChangedFiles').mockResolvedValue(['mock-file.js']);

const { GitWorktreeManager } = require('../../src/git/worktree');
vi.spyOn(GitWorktreeManager.prototype, 'worktreeExists').mockResolvedValue(true);
vi.spyOn(GitWorktreeManager.prototype, 'getWorktreePath').mockResolvedValue('/tmp/worktree/test');

const configModule = require('../../src/config');
vi.spyOn(configModule, 'loadConfig').mockResolvedValue({
  github_token: 'test-token', port: 7247, theme: 'light'
});
// Unique per test file so parallel vitest forks never share a config dir
const testConfigDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pair-review-cfg-'));
vi.spyOn(configModule, 'getConfigDir').mockReturnValue(testConfigDir);

const { run } = require('../../src/database');
const analysisRoutes = require('../../src/routes/analyses');
const prRoutes = require('../../src/routes/pr');
const localRoutes = require('../../src/routes/local');

/** A valid level-centric advanced config (type: 'advanced'). */
const advancedConfig = {
  levels: {
    '1': { enabled: true, voices: [{ provider: 'claude', model: 'sonnet', tier: 'balanced' }] },
    '2': { enabled: false, voices: [] },
    '3': { enabled: false, voices: [] }
  }
};

function createTestApp(db) {
  const app = express();
  app.use(express.json());
  app.set('db', db);
  app.set('githubToken', 'test-token');
  app.set('config', {
    github_token: 'test-token', port: 7247, theme: 'light', model: 'sonnet'
  });
  app.use('/', analysisRoutes);
  app.use('/', prRoutes);
  app.use('/', localRoutes);
  return app;
}

async function seedCouncil(db, id = 'default-council-1') {
  await run(db, `INSERT INTO councils (id, name, type, config) VALUES (?, ?, ?, ?)`,
    [id, 'Repo Default Council', 'advanced', JSON.stringify(advancedConfig)]);
  return id;
}

async function setRepoDefaultCouncil(db, repository, councilId) {
  await run(db,
    `INSERT INTO repo_settings (repository, default_council_id) VALUES (?, ?)
       ON CONFLICT(repository) DO UPDATE SET default_council_id = excluded.default_council_id`,
    [repository, councilId]);
}

describe('Repo default-council parity in plain Analyze routes', () => {
  let db;
  let app;
  let server;
  let launchSpy;
  let analyzeSpy;

  beforeEach(async () => {
    db = createTestDatabase();
    app = createTestApp(db);
    server = await listenOnLoopback(app);
    analyzerCalls.reset();
    // Stub the real Analyzer.analyzeLevel1 so the single-provider path is
    // observable (records provider/model from `this`) and never spawns a CLI.
    analyzeSpy = vi.spyOn(Analyzer.prototype, 'analyzeLevel1')
      .mockImplementation(async function () {
        analyzerCalls.single.push({ provider: this.provider, model: this.model });
        return { suggestions: [], summary: null, runId: 'mock-run' };
      });
    // Spy on the shared council launcher used by BOTH the explicit endpoint and
    // the default-council dispatch. Return a fake handle without running the
    // real (heavy) orchestration.
    launchSpy = vi.spyOn(analysisRoutes, 'launchCouncilAnalysis')
      .mockResolvedValue({ analysisId: 'council-analysis-id', runId: 'council-run-id' });
  });

  afterEach(async () => {
    await closeServer(server);
    analyzeSpy.mockRestore();
    launchSpy.mockRestore();
    if (db) closeTestDatabase(db);
    vi.clearAllMocks();
  });

  afterAll(() => {
    fs.rmSync(testConfigDir, { recursive: true, force: true });
  });

  // ===================== PR MODE =====================
  describe('PR mode: POST /api/pr/:owner/:repo/:number/analyses', () => {
    const owner = 'test-owner';
    const repo = 'test-repo';
    const prNumber = 42;
    const repository = `${owner}/${repo}`;

    beforeEach(async () => {
      await run(db,
        `INSERT INTO pr_metadata (pr_number, repository, title) VALUES (?, ?, ?)`,
        [prNumber, repository, 'Test PR']);
    });

    it('(a) repo WITHOUT default_council_id → runs single-provider, no council dispatch', async () => {
      const response = await request(server)
        .post(`/api/pr/${owner}/${repo}/${prNumber}/analyses`)
        .send({});

      expect(response.status).toBe(200);
      expect(response.body.isCouncil).toBeUndefined();
      expect(response.body.runId).toBeDefined();
      // Single-provider path: Analyzer constructed and analyzeLevel1 invoked.
      expect(analyzerCalls.single.length).toBe(1);
      // Council launcher must NOT have been used.
      expect(launchSpy).not.toHaveBeenCalled();
    });

    it('(b) repo WITH default_council_id and no explicit pick → dispatches council', async () => {
      const councilId = await seedCouncil(db);
      await setRepoDefaultCouncil(db, repository, councilId);

      const response = await request(server)
        .post(`/api/pr/${owner}/${repo}/${prNumber}/analyses`)
        .send({});

      expect(response.status).toBe(200);
      expect(response.body.isCouncil).toBe(true);
      expect(response.body.runId).toBe('council-run-id');
      // Council launcher invoked with the resolved council id; single path skipped.
      expect(launchSpy).toHaveBeenCalledTimes(1);
      expect(analyzerCalls.single.length).toBe(0);
      const [, , , passedCouncilId, , passedConfigType] = launchSpy.mock.calls[0];
      expect(passedCouncilId).toBe(councilId);
      expect(passedConfigType).toBe('advanced');
    });

    it('(c) explicit provider/model overrides repo default council', async () => {
      const councilId = await seedCouncil(db);
      await setRepoDefaultCouncil(db, repository, councilId);

      const response = await request(server)
        .post(`/api/pr/${owner}/${repo}/${prNumber}/analyses`)
        .send({ provider: 'antigravity', model: 'pro' });

      expect(response.status).toBe(200);
      expect(response.body.isCouncil).toBeUndefined();
      // Explicit single-model pick wins: Analyzer used with the explicit pair.
      expect(launchSpy).not.toHaveBeenCalled();
      expect(analyzerCalls.single.length).toBe(1);
      expect(analyzerCalls.single[0].provider).toBe('antigravity');
      expect(analyzerCalls.single[0].model).toBe('pro');
    });
  });

  // ===================== LOCAL MODE =====================
  describe('Local mode: POST /api/local/:reviewId/analyses', () => {
    const repository = 'local-repo';
    let reviewId;

    beforeEach(async () => {
      await run(db,
        `INSERT INTO reviews (pr_number, repository, review_type, local_path, local_head_sha)
         VALUES (NULL, ?, 'local', '/tmp/test-project', 'abc123')`,
        [repository]);
      const row = db.prepare(
        'SELECT id FROM reviews WHERE review_type = ? ORDER BY id DESC LIMIT 1'
      ).get('local');
      reviewId = row.id;
    });

    it('(a) repo WITHOUT default_council_id → runs single-provider, no council dispatch', async () => {
      const response = await request(server)
        .post(`/api/local/${reviewId}/analyses`)
        .send({});

      expect(response.status).toBe(200);
      expect(response.body.isCouncil).toBeUndefined();
      expect(response.body.runId).toBeDefined();
      expect(analyzerCalls.single.length).toBe(1);
      expect(launchSpy).not.toHaveBeenCalled();
    });

    it('(b) repo WITH default_council_id and no explicit pick → dispatches council', async () => {
      const councilId = await seedCouncil(db, 'default-council-local');
      await setRepoDefaultCouncil(db, repository, councilId);

      const response = await request(server)
        .post(`/api/local/${reviewId}/analyses`)
        .send({});

      expect(response.status).toBe(200);
      expect(response.body.isCouncil).toBe(true);
      expect(response.body.runId).toBe('council-run-id');
      expect(launchSpy).toHaveBeenCalledTimes(1);
      expect(analyzerCalls.single.length).toBe(0);
      const [, , , passedCouncilId, , passedConfigType] = launchSpy.mock.calls[0];
      expect(passedCouncilId).toBe(councilId);
      expect(passedConfigType).toBe('advanced');
    });

    it('(c) explicit provider/model overrides repo default council', async () => {
      const councilId = await seedCouncil(db, 'default-council-local-2');
      await setRepoDefaultCouncil(db, repository, councilId);

      const response = await request(server)
        .post(`/api/local/${reviewId}/analyses`)
        .send({ provider: 'antigravity', model: 'pro' });

      expect(response.status).toBe(200);
      expect(response.body.isCouncil).toBeUndefined();
      expect(launchSpy).not.toHaveBeenCalled();
      expect(analyzerCalls.single.length).toBe(1);
      expect(analyzerCalls.single[0].provider).toBe('antigravity');
      expect(analyzerCalls.single[0].model).toBe('pro');
    });
  });
});
