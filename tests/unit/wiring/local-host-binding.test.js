// Copyright 2026 Tim Perkins (tjwp) | SPDX-License-Identifier: Apache-2.0
/**
 * Local-mode host-binding wiring tests (Phase 7: per-PR host resolution).
 *
 * Local mode has no PR identity, so it always calls the two-argument form of
 * resolveHostBinding(repository, config) for best-effort branch enrichment.
 * The two-arg form applies the "ambiguity rule":
 *   - DUAL repo (api_host + exclusive:false)  → github binding (host === null,
 *     top-level github.com token). The repo's alt-host token/features do NOT
 *     apply to this binding.
 *   - EXCLUSIVE alt-host repo (api_host, no exclusive key) → alt binding
 *     (host === api_host, repo-scoped token) — unchanged from today.
 *
 * These tests assert the binding actually fed into branch enrichment at both
 * local-mode entry points (CLAUDE.md "CLI vs Web UI entry points"):
 *   1. setupLocalReviewSession()      — the CLI seam (local-review.js:802)
 *   2. POST /api/local/start          — the web UI seam (routes/local.js:501)
 * and that the ambiguity rule never throws on a local path (local mode passes
 * no host override, so the new host-mismatch throws in resolveHostBinding
 * cannot fire here).
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import express from 'express';
import request from 'supertest';
import os from 'os';
import path from 'path';
import fs from 'fs/promises';
import { createTestDatabase, closeTestDatabase } from '../../utils/schema';
import { listenOnLoopback, closeServer } from '../../utils/loopback-server';

const localReviewModule = require('../../../src/local-review');
const configModule = require('../../../src/config');
const baseBranchModule = require('../../../src/git/base-branch');
const summaryGenerator = require('../../../src/ai/summary-generator');
const tourGenerator = require('../../../src/ai/tour-generator');
const stackWalkerModule = require('../../../src/github/stack-walker');
const { localReviewDiffs } = require('../../../src/routes/shared');

const ALT_HOST = 'https://alt.example.com/api/v3';

// A DUAL repo: alt host present but not exclusive. The repo-scoped token is an
// alt-host credential; the top-level github_token is the github.com credential.
function dualRepoConfig() {
  return {
    port: 7247,
    github_token: 'GH_TOKEN',
    repos: {
      'owner/repo': {
        path: '/mock/repo',
        api_host: ALT_HOST,
        exclusive: false,
        token: 'ALT_TOKEN'
      }
    }
  };
}

// An EXCLUSIVE alt-host repo: api_host with no `exclusive` key (defaults to
// exclusive). Today's behaviour — every PR (and enrichment) uses the alt host.
function exclusiveRepoConfig() {
  return {
    port: 7247,
    github_token: 'GH_TOKEN',
    repos: {
      'owner/repo': {
        path: '/mock/repo',
        api_host: ALT_HOST,
        token: 'ALT_TOKEN'
      }
    }
  };
}

describe('local-mode host binding (ambiguity rule)', () => {
  let db;
  let savedGithubTokenEnv;

  beforeEach(() => {
    db = createTestDatabase();

    // GITHUB_TOKEN would short-circuit the github binding's token resolution
    // ahead of config.github_token; unset it so the assertions are stable.
    savedGithubTokenEnv = process.env.GITHUB_TOKEN;
    delete process.env.GITHUB_TOKEN;

    // Stub git-touching helpers so no real repo is required. All of these are
    // invoked via module.exports (or an inline require) by both entry points,
    // so vi.spyOn on the module is observable at call time.
    vi.spyOn(localReviewModule, 'findGitRoot').mockResolvedValue('/mock/repo');
    vi.spyOn(localReviewModule, 'getHeadSha').mockResolvedValue('abc123def456');
    vi.spyOn(localReviewModule, 'getRepositoryName').mockResolvedValue('owner/repo');
    vi.spyOn(localReviewModule, 'getCurrentBranch').mockResolvedValue('feature-branch');
    vi.spyOn(localReviewModule, 'findMainGitRoot').mockResolvedValue('/mock/repo');
    vi.spyOn(localReviewModule, 'generateScopedDiff').mockResolvedValue({
      diff: '',
      stats: { trackedChanges: 0, untrackedFiles: 0, stagedChanges: 0, unstagedChanges: 0 },
      mergeBaseSha: null
    });
    vi.spyOn(localReviewModule, 'computeScopedDigest').mockResolvedValue('digest123');

    // Cut off the deepest git/network step. detectAndBuildBranchInfo inline
    // requires detectBaseBranch per call, so this spy is reliably wired even
    // when the route runs the real detectAndBuildBranchInfo — keeping the
    // route tests off the network (no real PR probe).
    vi.spyOn(baseBranchModule, 'detectBaseBranch').mockResolvedValue(null);

    // Background provider jobs are irrelevant here; keep them inert.
    vi.spyOn(summaryGenerator, 'kickOffSummaryJob').mockReturnValue(null);
    vi.spyOn(tourGenerator, 'kickOffTourJob').mockReturnValue(null);
    vi.spyOn(stackWalkerModule, 'walkPRStack').mockResolvedValue(null);
  });

  afterEach(() => {
    localReviewDiffs.clear();
    vi.restoreAllMocks();
    if (savedGithubTokenEnv === undefined) {
      delete process.env.GITHUB_TOKEN;
    } else {
      process.env.GITHUB_TOKEN = savedGithubTokenEnv;
    }
    closeTestDatabase(db);
  });

  /**
   * Captures the `hostBinding` (and `githubToken`) that a local entry point
   * feeds into branch enrichment by spying detectAndBuildBranchInfo — both
   * entry points call it with { repository, hostBinding, githubToken, ... }.
   */
  function captureEnrichmentBinding() {
    const captured = {};
    vi.spyOn(localReviewModule, 'detectAndBuildBranchInfo').mockImplementation(async (repoPath, branch, options = {}) => {
      captured.repoPath = repoPath;
      captured.branch = branch;
      captured.hostBinding = options.hostBinding;
      captured.githubToken = options.githubToken;
      return null;
    });
    return captured;
  }

  describe('CLI seam: setupLocalReviewSession()', () => {
    it('DUAL repo → github binding (host null, top-level github token)', async () => {
      const captured = captureEnrichmentBinding();

      const result = await localReviewModule.setupLocalReviewSession({
        db,
        config: dualRepoConfig(),
        repoPath: '/mock/repo',
        flags: {},
        startBackgroundJobs: false
      });

      expect(result.sessionId).toBeDefined();
      expect(captured.hostBinding).toBeTruthy();
      // github flavor: no alt api host, host echo null.
      expect(captured.hostBinding.apiHost).toBeNull();
      expect(captured.hostBinding.host).toBeNull();
      // Top-level github.com credential, not the repo-scoped alt token.
      expect(captured.hostBinding.token).toBe('GH_TOKEN');
      expect(captured.hostBinding.source).toBe('config:github_token');
      // The fallback token passed alongside must agree with the binding.
      expect(captured.githubToken).toBe('GH_TOKEN');
    });

    it('EXCLUSIVE alt-host repo → alt binding (host api_host, repo token) — unchanged', async () => {
      const captured = captureEnrichmentBinding();

      const result = await localReviewModule.setupLocalReviewSession({
        db,
        config: exclusiveRepoConfig(),
        repoPath: '/mock/repo',
        flags: {},
        startBackgroundJobs: false
      });

      expect(result.sessionId).toBeDefined();
      expect(captured.hostBinding).toBeTruthy();
      expect(captured.hostBinding.apiHost).toBe(ALT_HOST);
      expect(captured.hostBinding.host).toBe(ALT_HOST);
      expect(captured.hostBinding.token).toBe('ALT_TOKEN');
      expect(captured.hostBinding.source).toBe('repo:token');
    });

    it('does not throw for a dual repo on the local path (no host override is passed)', async () => {
      captureEnrichmentBinding();
      await expect(localReviewModule.setupLocalReviewSession({
        db,
        config: dualRepoConfig(),
        repoPath: '/mock/repo',
        flags: {},
        startBackgroundJobs: false
      })).resolves.toBeTruthy();
    });
  });

  describe('web UI seam: POST /api/local/start', () => {
    let app;
    let server;
    let tmpDir;

    // The start handler destructures detectAndBuildBranchInfo at module load
    // (routes/local.js), so a module-export spy on it is only reliably wired on
    // the first require. It resolves the binding through an inline
    // require('../config') per request, so wrapping resolveHostBinding is the
    // stable capture point across multiple route tests.
    function captureViaResolveHostBinding() {
      const captured = {};
      const real = configModule.resolveHostBinding;
      vi.spyOn(configModule, 'resolveHostBinding').mockImplementation((repository, config, options) => {
        const binding = real(repository, config, options);
        captured.repository = repository;
        captured.options = options;
        captured.hostBinding = binding;
        return binding;
      });
      return captured;
    }

    async function mountRouter(config) {
      app = express();
      app.use(express.json());
      app.set('db', db);
      app.set('config', config);
      const localRouter = require('../../../src/routes/local');
      app.use(localRouter);
      server = await listenOnLoopback(app);
    }

    beforeEach(async () => {
      // POST /api/local/start fs.stat()s the request path before spied helpers
      // run, so it must be a real, existing directory (per-file mkdtemp).
      tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'pr-local-host-'));
    });

    afterEach(async () => {
      if (server) await closeServer(server);
      server = undefined;
      if (tmpDir) await fs.rm(tmpDir, { recursive: true, force: true });
    });

    it('DUAL repo → github binding (host null, top-level token), request succeeds', async () => {
      const captured = captureViaResolveHostBinding();
      await mountRouter(dualRepoConfig());

      const res = await request(server)
        .post('/api/local/start')
        .send({ path: tmpDir });

      expect(res.status).toBe(200);
      expect(captured.repository).toBe('owner/repo');
      // Best-effort enrichment passes no host override → ambiguity rule applies.
      expect(captured.options).toBeUndefined();
      expect(captured.hostBinding).toBeTruthy();
      expect(captured.hostBinding.apiHost).toBeNull();
      expect(captured.hostBinding.host).toBeNull();
      expect(captured.hostBinding.token).toBe('GH_TOKEN');
      expect(captured.hostBinding.source).toBe('config:github_token');
    });

    it('EXCLUSIVE alt-host repo → alt binding (host api_host, repo token) — unchanged', async () => {
      const captured = captureViaResolveHostBinding();
      await mountRouter(exclusiveRepoConfig());

      const res = await request(server)
        .post('/api/local/start')
        .send({ path: tmpDir });

      expect(res.status).toBe(200);
      expect(captured.hostBinding).toBeTruthy();
      expect(captured.hostBinding.apiHost).toBe(ALT_HOST);
      expect(captured.hostBinding.host).toBe(ALT_HOST);
      expect(captured.hostBinding.token).toBe('ALT_TOKEN');
      expect(captured.hostBinding.source).toBe('repo:token');
    });
  });
});
