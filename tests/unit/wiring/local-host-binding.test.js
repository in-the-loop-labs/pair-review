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

/**
 * Permanent capture wrapper around config.resolveHostBinding.
 *
 * routes/local.js destructures `resolveHostBinding` at module load (the
 * project's import convention — no inline require() for an already-imported
 * module), so it keeps whatever reference existed at its FIRST require. A
 * per-test `vi.spyOn(configModule, 'resolveHostBinding')` is therefore
 * observable only for whichever test happens to load the router, and
 * `vi.restoreAllMocks()` detaches it for every test after that — the same
 * captured-reference trap as the spawn spies elsewhere in the suite.
 *
 * Installing one plain wrapper here, before the router is ever required,
 * survives restoreAllMocks and stays wired for the whole file.
 */
const resolveHostBindingCalls = [];
const _realResolveHostBinding = configModule.resolveHostBinding;
configModule.resolveHostBinding = function (repository, config, options) {
  const binding = _realResolveHostBinding(repository, config, options);
  resolveHostBindingCalls.push({ repository, options, hostBinding: binding });
  return binding;
};

const { GitHubClient } = require('../../../src/github/client');

/**
 * Load the router LAZILY, never at file scope.
 *
 * routes/local.js destructures its local-review helpers at module load, so the
 * references it keeps are whichever functions existed at its FIRST require. A
 * file-scope require would capture the real (git-touching) implementations
 * instead of the beforeEach spies and send POST /api/local/start to a real
 * working tree.
 */
function getLocalRouter() {
  return require('../../../src/routes/local');
}

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
    // (routes/local.js), so a module-export spy on it is not observable from
    // the route. Read instead from the permanent resolveHostBinding wrapper
    // installed at the top of this file — reset per test, and it records the
    // binding the route actually fed into branch enrichment.
    function captureViaResolveHostBinding() {
      resolveHostBindingCalls.length = 0;
      return {
        get calls() { return resolveHostBindingCalls; },
        get repository() { return resolveHostBindingCalls.at(-1)?.repository; },
        get options() { return resolveHostBindingCalls.at(-1)?.options; },
        get hostBinding() { return resolveHostBindingCalls.at(-1)?.hostBinding; },
      };
    }

    async function mountRouter(config) {
      app = express();
      app.use(express.json());
      app.set('db', db);
      app.set('config', config);
      const localRouter = require('../../../src/routes/local');
      app.use(getLocalRouter());
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

  /**
   * Associated-PR credential resolution, for both endpoints that fetch PR
   * metadata for a local review's association.
   *
   * The association carries a PR IDENTITY (`owner/repo` as GitHub reports it),
   * which is not necessarily a `config.repos[...]` KEY: a monorepo-style entry
   * is found by probing its `url_pattern` against a URL synthesized from its
   * `api_host`, and only `resolveBindingRepositoryFromPR` does that probe.
   * Resolving the raw identity misses the entry entirely, so the binding
   * degrades to github.com with the global token — the failure the binding
   * exists to prevent. Asserted end-to-end on the credential the GitHub client
   * is actually constructed with, not just on the lookup key.
   */
  describe('associated-PR metadata credentials', () => {
    let app;
    let server;
    let ghCalls;

    // The `repos[...]` key is deliberately NOT the PR's owner/repo.
    const PATTERN_REPO_KEY = 'alt-owner/monorepo';
    const PR_REPOSITORY = 'owner/repo';

    function urlPatternRepoConfig() {
      return {
        port: 7247,
        github_token: 'GH_TOKEN',
        repos: {
          [PATTERN_REPO_KEY]: {
            path: '/mock/repo',
            api_host: ALT_HOST,
            token: 'ALT_TOKEN',
            url_pattern: '^https://alt\\.example\\.com/(?<owner>[^/]+)/(?<repo>[^/]+)/pull/(?<number>\\d+)$'
          }
        }
      };
    }

    async function mountRouter(config) {
      app = express();
      app.use(express.json());
      app.set('db', db);
      app.set('config', config);
      // Mirrors src/server.js: the GLOBAL token, which knows nothing about
      // repo-scoped credentials or alt hosts.
      app.set('githubToken', 'GH_TOKEN');
      app.use(getLocalRouter());
      server = await listenOnLoopback(app);
    }

    /**
     * Seed a local review carrying a PR association. `local_path` is NULL so
     * the metadata GET touches no git working tree.
     */
    function seedAssociatedReview(prNumber) {
      const info = db.prepare(`
        INSERT INTO reviews (repository, status, review_type, local_path,
                             associated_pr_number, associated_pr_repository)
        VALUES (?, 'draft', 'local', NULL, ?, ?)
      `).run(PR_REPOSITORY, prNumber, PR_REPOSITORY);
      return Number(info.lastInsertRowid);
    }

    // An alt-host repo with NO repo-scoped credential, alongside a perfectly
    // good github.com token. resolveHostBinding refuses to lend the top-level
    // token to an alt host, so the binding comes back `{ host: ALT_HOST,
    // token: '' }` — "no usable credential for this host".
    function altHostNoCredentialConfig() {
      return {
        port: 7247,
        github_token: 'GH_TOKEN',
        repos: {
          [PR_REPOSITORY]: {
            path: '/mock/repo',
            api_host: ALT_HOST
          }
        }
      };
    }

    // A plain github.com repo with no repo-scoped credential. The binding is
    // token-less too, but it names no alt host — the global token legitimately
    // covers it.
    function plainGithubNoRepoTokenConfig() {
      return { port: 7247, repos: {} };
    }

    beforeEach(() => {
      // Module-level state shared with the branch-detection cache — a stale
      // entry from another test would silently suppress the fetch under test.
      getLocalRouter()._prDetectionCache.clear();
      // Ditto the association host-binding negative memo: it holds token-less
      // bindings for up to 30s, and several cases here mount different configs.
      getLocalRouter()._hostBindingCache.clear();

      // Capture the credential each GitHub call is made with. Spying the
      // PROTOTYPE (not the module export) is what makes this observable:
      // providers/pr-context.js captures `GitHubClient` in its `defaults` at
      // module load. Resolving null means "PR not found" — no network.
      ghCalls = [];
      vi.spyOn(GitHubClient.prototype, 'fetchPullRequest').mockImplementation(async function (owner, repo, number) {
        ghCalls.push({ owner, repo, number, apiHost: this.apiHost, token: this.token });
        return null;
      });
    });

    afterEach(async () => {
      if (server) await closeServer(server);
      server = undefined;
      getLocalRouter()._prDetectionCache.clear();
      getLocalRouter()._hostBindingCache.clear();
    });

    it('GET /api/local/:reviewId resolves the association through the url_pattern repo entry', async () => {
      await mountRouter(urlPatternRepoConfig());
      const reviewId = seedAssociatedReview(101);

      const res = await request(server).get(`/api/local/${reviewId}`);

      expect(res.status).toBe(200);
      expect(res.body.associatedPR).toMatchObject({ prNumber: 101, repository: PR_REPOSITORY });
      // The background write-through is what carries the credential here.
      await vi.waitFor(() => expect(ghCalls).toHaveLength(1));
      expect(ghCalls[0]).toMatchObject({
        owner: 'owner', repo: 'repo', number: 101,
        apiHost: ALT_HOST, token: 'ALT_TOKEN'
      });
      // …and the lookup key handed to resolveHostBinding was the config key,
      // not the PR identity.
      expect(resolveHostBindingCalls.some(c => c.repository === PATTERN_REPO_KEY)).toBe(true);
    });

    it('GET /api/local/:reviewId/pr-metadata resolves the association through the url_pattern repo entry', async () => {
      await mountRouter(urlPatternRepoConfig());
      const reviewId = seedAssociatedReview(102);

      const res = await request(server).get(`/api/local/${reviewId}/pr-metadata`);

      expect(res.status).toBe(200);
      expect(ghCalls).toHaveLength(1);
      expect(ghCalls[0]).toMatchObject({
        owner: 'owner', repo: 'repo', number: 102,
        apiHost: ALT_HOST, token: 'ALT_TOKEN'
      });
      expect(resolveHostBindingCalls.some(c => c.repository === PATTERN_REPO_KEY)).toBe(true);
    });

    it('blocking /pr-metadata honours the negative cache instead of re-hitting GitHub', async () => {
      // Regression: the blocking endpoint bypassed the five-minute backoff its
      // background sibling applies. `fetchPRMetadata` only short-circuits after
      // a SUCCESSFUL upsert, so a failing PR was re-fetched on every call — and
      // this endpoint is directly callable in a loop.
      await mountRouter(urlPatternRepoConfig());
      const reviewId = seedAssociatedReview(103);

      const first = await request(server).get(`/api/local/${reviewId}/pr-metadata`);
      expect(first.status).toBe(200);
      expect(ghCalls).toHaveLength(1);

      const second = await request(server).get(`/api/local/${reviewId}/pr-metadata`);

      expect(second.status).toBe(200);
      expect(ghCalls).toHaveLength(1);
      // Still a well-formed payload — the contract is "the pill stays hidden",
      // never a 500.
      expect(second.body.capabilities).toMatchObject({
        hasAssociatedPR: true,
        hasGitHubToken: true,
        canShowPRMetadata: false
      });
      expect(second.body.associatedPR).toMatchObject({ prNumber: 103, repository: PR_REPOSITORY });
    });

    /**
     * `hasGitHubToken` is documented as "is GitHub reachable for THIS review?"
     * and Phases 2-5 (`canViewPRComments`, `canSubmitToGitHub`) are specified to
     * gate on it. Both endpoints used to compute it as
     * `binding?.token || globalToken`, which reports TRUE for exactly the case
     * `fetchPRMetadata` fails CLOSED on — an alt-host binding with an empty
     * token — so the flag promised reachability the provider always refuses.
     * Both now go through the provider's own `resolveFetchCredential`.
     */
    describe('hasGitHubToken mirrors the provider fail-closed rule', () => {
      it('GET /api/local/:reviewId reports false for an alt-host binding with no credential', async () => {
        await mountRouter(altHostNoCredentialConfig());
        const reviewId = seedAssociatedReview(201);

        const res = await request(server).get(`/api/local/${reviewId}`);

        expect(res.status).toBe(200);
        expect(res.body.capabilities.hasAssociatedPR).toBe(true);
        expect(res.body.capabilities.hasGitHubToken).toBe(false);
        // And no fetch is attempted with the borrowed github.com token.
        expect(ghCalls).toHaveLength(0);
      });

      it('GET /api/local/:reviewId/pr-metadata reports false for an alt-host binding with no credential', async () => {
        await mountRouter(altHostNoCredentialConfig());
        const reviewId = seedAssociatedReview(202);

        const res = await request(server).get(`/api/local/${reviewId}/pr-metadata`);

        expect(res.status).toBe(200);
        expect(res.body.capabilities.hasAssociatedPR).toBe(true);
        expect(res.body.capabilities.hasGitHubToken).toBe(false);
        expect(res.body.capabilities.canShowPRMetadata).toBe(false);
        expect(ghCalls).toHaveLength(0);
      });

      it('GET /api/local/:reviewId still reports true for a github.com binding covered by the global token', async () => {
        // Same token-less binding shape, but no alt host — the global
        // github.com token genuinely covers this repo, so failing closed here
        // would hide the pill for the ordinary case.
        await mountRouter(plainGithubNoRepoTokenConfig());
        const reviewId = seedAssociatedReview(203);

        const res = await request(server).get(`/api/local/${reviewId}`);

        expect(res.status).toBe(200);
        expect(res.body.capabilities.hasGitHubToken).toBe(true);
        await vi.waitFor(() => expect(ghCalls).toHaveLength(1));
        expect(ghCalls[0]).toMatchObject({ apiHost: null, token: 'GH_TOKEN' });
      });

      it('GET /api/local/:reviewId/pr-metadata still reports true for a github.com binding covered by the global token', async () => {
        await mountRouter(plainGithubNoRepoTokenConfig());
        const reviewId = seedAssociatedReview(204);

        const res = await request(server).get(`/api/local/${reviewId}/pr-metadata`);

        expect(res.status).toBe(200);
        expect(res.body.capabilities.hasGitHubToken).toBe(true);
        expect(ghCalls).toHaveLength(1);
        expect(ghCalls[0]).toMatchObject({ apiHost: null, token: 'GH_TOKEN' });
      });
    });

    /**
     * The association binding is resolved BEFORE `res.json` (hasGitHubToken
     * ships in that payload), and `resolveHostBinding` may shell out to a
     * `token_command`. config.js caches only SUCCESSFUL command output, so a
     * broken command re-ran `execSync` (5s timeout) on every single GET and
     * blocked the response each time.
     */
    describe('token-less binding resolution is memoized off the hot path', () => {
      // A repo-scoped token_command that always fails: config.js logs and
      // returns '' WITHOUT caching, so nothing upstream bounds re-execution.
      function brokenTokenCommandConfig() {
        return {
          port: 7247,
          repos: {
            [PR_REPOSITORY]: {
              path: '/mock/repo',
              api_host: ALT_HOST,
              token_command: 'exit 1'
            }
          }
        };
      }

      it('re-runs a failing token_command once per TTL, not once per request', () => {
        const router = getLocalRouter();
        const config = brokenTokenCommandConfig();
        const association = { prNumber: 301, repository: PR_REPOSITORY };
        const before = resolveHostBindingCalls.length;

        const first = router._hostBindingCache.resolveAssociationBinding(association, config, 1_000);
        const second = router._hostBindingCache.resolveAssociationBinding(association, config, 5_000);

        expect(first).toMatchObject({ host: ALT_HOST, token: '' });
        // Second call served from the memo — no second resolution, so no
        // second execSync.
        expect(second).toBe(first);
        expect(resolveHostBindingCalls.length - before).toBe(1);
      });

      it('retries once the TTL expires so a repaired credential is picked up', () => {
        const router = getLocalRouter();
        const config = brokenTokenCommandConfig();
        const association = { prNumber: 302, repository: PR_REPOSITORY };
        const before = resolveHostBindingCalls.length;
        const ttl = router._hostBindingCache.ttlMs;

        router._hostBindingCache.resolveAssociationBinding(association, config, 1_000);
        router._hostBindingCache.resolveAssociationBinding(association, config, 1_000 + ttl + 1);

        expect(resolveHostBindingCalls.length - before).toBe(2);
      });

      it('never memoizes a successful resolution (config.js owns that cache, and refresh() must stay live)', () => {
        const router = getLocalRouter();
        const config = urlPatternRepoConfig();  // repo-scoped literal ALT_TOKEN
        const association = { prNumber: 303, repository: PR_REPOSITORY };
        const before = resolveHostBindingCalls.length;

        const first = router._hostBindingCache.resolveAssociationBinding(association, config, 1_000);
        const second = router._hostBindingCache.resolveAssociationBinding(association, config, 1_100);

        expect(first).toMatchObject({ token: 'ALT_TOKEN' });
        expect(second).not.toBe(first);
        expect(resolveHostBindingCalls.length - before).toBe(2);
      });

      it('keys the memo per config object so one config cannot answer for another', () => {
        const router = getLocalRouter();
        const association = { prNumber: 304, repository: PR_REPOSITORY };
        // Same binding KEY in both configs — only the config object differs.
        const fixedConfig = {
          port: 7247,
          repos: { [PR_REPOSITORY]: { path: '/mock/repo', api_host: ALT_HOST, token: 'ALT_TOKEN' } }
        };

        const broken = router._hostBindingCache.resolveAssociationBinding(association, brokenTokenCommandConfig(), 1_000);
        expect(broken).toMatchObject({ token: '' });

        const fixed = router._hostBindingCache.resolveAssociationBinding(association, fixedConfig, 1_000);
        expect(fixed).toMatchObject({ token: 'ALT_TOKEN' });
      });
    });

    it('serves cached metadata while the negative cache is hot', async () => {
      // A negative entry must not blind the endpoint to a row some other path
      // cached in the meantime (e.g. a PR-mode session for the same PR).
      await mountRouter(urlPatternRepoConfig());
      const reviewId = seedAssociatedReview(104);

      await request(server).get(`/api/local/${reviewId}/pr-metadata`);
      expect(ghCalls).toHaveLength(1);

      db.prepare(`
        INSERT INTO pr_metadata (pr_number, repository, title, author, pr_data)
        VALUES (?, ?, 'Cached title', 'octocat', ?)
      `).run(104, PR_REPOSITORY, JSON.stringify({
        html_url: 'https://alt.example.com/owner/repo/pull/104',
        state: 'open',
        head_sha: 'sha1'
      }));

      const res = await request(server).get(`/api/local/${reviewId}/pr-metadata`);

      expect(res.status).toBe(200);
      expect(ghCalls).toHaveLength(1);
      expect(res.body.capabilities.canShowPRMetadata).toBe(true);
      expect(res.body.associatedPR).toMatchObject({ prNumber: 104, title: 'Cached title', author: 'octocat' });
    });
  });

  /**
   * Branch → PR DETECTION binding (the second host-binding resolution on
   * GET /api/local/:reviewId).
   *
   * Detection is the path that calls `associatePR`, so a wrong-host branch
   * lookup writes a wrong PR number PERMANENTLY onto the review row — branch
   * names are mirrored across hosts, so a github.com lookup can find a
   * DIFFERENT PR. It therefore has to follow the SAME identity → binding-key →
   * binding order as the association sibling (`resolveRepositoryBinding`):
   * handing the raw repository identity to `resolveHostBinding` misses a
   * `url_pattern`-keyed monorepo entry and degrades to github.com + the global
   * token.
   *
   * Asserted on what `detectPRForBranch` actually feeds downstream: it forwards
   * `hostBinding`/`githubToken` into `detectBaseBranch` as
   * `_deps.getHostBinding()` / `_deps.getGitHubToken()`.
   */
  describe('branch → PR detection binding', () => {
    let app;
    let server;

    const PATTERN_REPO_KEY = 'alt-owner/monorepo';
    const REVIEW_REPOSITORY = 'owner/repo';

    function urlPatternRepoConfig() {
      return {
        port: 7247,
        github_token: 'GH_TOKEN',
        repos: {
          [PATTERN_REPO_KEY]: {
            path: '/mock/repo',
            api_host: ALT_HOST,
            token: 'ALT_TOKEN',
            url_pattern: '^https://alt\\.example\\.com/(?<owner>[^/]+)/(?<repo>[^/]+)/pull/(?<number>\\d+)$'
          }
        }
      };
    }

    // A plain github.com repo whose ONLY credential is repo-scoped. The global
    // app token slot is empty, so detection can only fire if the gate reads the
    // BINDING's token rather than the global one.
    function repoScopedTokenOnlyConfig() {
      return {
        port: 7247,
        repos: { [REVIEW_REPOSITORY]: { path: '/mock/repo', token: 'REPO_TOKEN' } }
      };
    }

    async function mountRouter(config, globalToken = 'GH_TOKEN') {
      app = express();
      app.use(express.json());
      app.set('db', db);
      app.set('config', config);
      app.set('githubToken', globalToken);
      app.use(getLocalRouter());
      server = await listenOnLoopback(app);
    }

    /**
     * A local review detection can actually run for: a working-tree path, a
     * branch (getCurrentBranch is stubbed in the outer beforeEach) and NO
     * association yet. `local_base_branch` is pre-set so the unrelated
     * background base-branch block — which resolves its own binding — stays
     * out of the way of these assertions.
     */
    function seedDetectableReview(repository = REVIEW_REPOSITORY) {
      const info = db.prepare(`
        INSERT INTO reviews (repository, status, review_type, local_path, local_base_branch)
        VALUES (?, 'draft', 'local', '/mock/repo', 'main')
      `).run(repository);
      return Number(info.lastInsertRowid);
    }

    function seedAlreadyAssociatedReview(repository, { prNumber, prRepository }) {
      const info = db.prepare(`
        INSERT INTO reviews (repository, status, review_type, local_path, local_base_branch,
                             associated_pr_number, associated_pr_repository)
        VALUES (?, 'draft', 'local', '/mock/repo', 'main', ?, ?)
      `).run(repository, prNumber, prRepository);
      return Number(info.lastInsertRowid);
    }

    /**
     * Capture the binding + token detection is built with. detectPRForBranch
     * forwards them into detectBaseBranch's `_deps`, and detectBaseBranch is
     * reached through the module object, so a module spy is observable even
     * though routes/local.js destructured detectPRForBranch at load time.
     */
    function captureDetection() {
      const captured = [];
      vi.spyOn(baseBranchModule, 'detectBaseBranch').mockImplementation(async (repoPath, branch, options = {}) => {
        captured.push({
          repoPath,
          branch,
          repository: options.repository,
          hostBinding: options._deps && options._deps.getHostBinding(),
          token: options._deps && options._deps.getGitHubToken()
        });
        return null;
      });
      return captured;
    }

    beforeEach(() => {
      getLocalRouter()._prDetectionCache.clear();
      getLocalRouter()._hostBindingCache.clear();
      resolveHostBindingCalls.length = 0;
      // No network, ever: detection's Graphite enrichment would otherwise
      // construct a real client.
      vi.spyOn(GitHubClient.prototype, 'fetchPullRequest').mockResolvedValue(null);
    });

    afterEach(async () => {
      if (server) await closeServer(server);
      server = undefined;
      getLocalRouter()._prDetectionCache.clear();
      getLocalRouter()._hostBindingCache.clear();
    });

    it('feeds the ALT-HOST binding to detection for an alt-host repo', async () => {
      const captured = captureDetection();
      await mountRouter(exclusiveRepoConfig());
      const reviewId = seedDetectableReview();

      const res = await request(server).get(`/api/local/${reviewId}`);

      expect(res.status).toBe(200);
      await vi.waitFor(() => expect(captured).toHaveLength(1));
      expect(captured[0].branch).toBe('feature-branch');
      expect(captured[0].hostBinding).toMatchObject({
        apiHost: ALT_HOST, host: ALT_HOST, token: 'ALT_TOKEN', source: 'repo:token'
      });
      // The fallback token handed alongside must agree with the binding, never
      // the global github.com one.
      expect(captured[0].token).toBe('ALT_TOKEN');
    });

    it('resolves a url_pattern-keyed monorepo entry instead of degrading to github.com', async () => {
      // REGRESSION: detection resolved the RAW repository identity, which only
      // `resolveBindingRepositoryFromPR` can translate into this config key —
      // so it silently fell back to a github.com binding with GH_TOKEN and
      // could associate a same-named branch's github.com PR.
      const captured = captureDetection();
      await mountRouter(urlPatternRepoConfig());
      const reviewId = seedDetectableReview();

      const res = await request(server).get(`/api/local/${reviewId}`);

      expect(res.status).toBe(200);
      await vi.waitFor(() => expect(captured).toHaveLength(1));
      expect(captured[0].hostBinding).toMatchObject({
        apiHost: ALT_HOST, host: ALT_HOST, token: 'ALT_TOKEN'
      });
      expect(captured[0].token).toBe('ALT_TOKEN');
      // The lookup key handed to resolveHostBinding was the CONFIG key.
      expect(resolveHostBindingCalls.some(c => c.repository === PATTERN_REPO_KEY)).toBe(true);
      expect(resolveHostBindingCalls.some(c => c.repository === REVIEW_REPOSITORY)).toBe(false);
    });

    it('fires on a repo-scoped credential alone, with no global token configured', async () => {
      // The gate reads the BINDING's token (falling back to the global one), so
      // a repo carrying only `repos[...].token` still gets its association —
      // this is the trigger condition the global-token-only gate missed.
      const captured = captureDetection();
      await mountRouter(repoScopedTokenOnlyConfig(), '');
      const reviewId = seedDetectableReview();

      const res = await request(server).get(`/api/local/${reviewId}`);

      expect(res.status).toBe(200);
      await vi.waitFor(() => expect(captured).toHaveLength(1));
      expect(captured[0].token).toBe('REPO_TOKEN');
      expect(captured[0].hostBinding).toMatchObject({ apiHost: null, token: 'REPO_TOKEN', source: 'repo:token' });
    });

    it('does not resolve a detection binding at all for an already-associated review', async () => {
      // REGRESSION: the detection binding was computed ABOVE its own guard, so
      // every metadata GET paid for it — including reviews that can never enter
      // the block. `resolveHostBinding` may shell out to a `token_command`
      // (execSync, 5s timeout) and config.js caches only SUCCESSFUL output, so
      // a logged-out `gh auth token` blocked the event loop on every request.
      //
      // The review's OWN repository is deliberately different from its
      // association's, so the two resolutions are distinguishable by key.
      const captured = captureDetection();
      await mountRouter(urlPatternRepoConfig());
      const reviewId = seedAlreadyAssociatedReview('local-owner/local-repo', {
        prNumber: 501, prRepository: REVIEW_REPOSITORY
      });

      const res = await request(server).get(`/api/local/${reviewId}`);

      expect(res.status).toBe(200);
      // The association binding still resolves (it ships in the payload)…
      expect(resolveHostBindingCalls.some(c => c.repository === PATTERN_REPO_KEY)).toBe(true);
      // …but nothing resolves the review's own repository. The post-res.json
      // code runs synchronously in the same tick, so this needs no waiting.
      expect(resolveHostBindingCalls.some(c => c.repository === 'local-owner/local-repo')).toBe(false);
      expect(captured).toHaveLength(0);
    });
  });

  /**
   * FINDING: local mode must not PERSIST a host it only guessed at.
   *
   * `resolveRepositoryBinding` uses the two-argument ambiguity rule, which
   * hands back the github.com flavour for a DUAL repo (api_host +
   * exclusive:false) regardless of where the PR actually lives. The background
   * cache warm then wrote that guess into pr_metadata.host — and PR-mode setup
   * reads it back as authoritative: `storedHostToOption` maps NULL on a dual
   * repo to `{ host: null }`, so `hostKnown` is true and the alt-host-first
   * probe (the thing that would have answered the question) never runs.
   *
   * There is no honest "unknown" to insert — omitted, `undefined` and `null`
   * all store SQL NULL — so the only honest option is to not create the row.
   */
  describe('dual-host repo: a guessed host is never persisted', () => {
    let app;
    let server;
    let ghCalls;

    const PR_REPOSITORY = 'owner/repo';

    function dualRepoAssociationConfig() {
      return {
        port: 7247,
        github_token: 'GH_TOKEN',
        repos: {
          [PR_REPOSITORY]: {
            path: '/mock/repo',
            api_host: ALT_HOST,
            exclusive: false,
            token: 'ALT_TOKEN'
          }
        }
      };
    }

    async function mountRouter(config) {
      app = express();
      app.use(express.json());
      app.set('db', db);
      app.set('config', config);
      app.set('githubToken', 'GH_TOKEN');
      app.use(getLocalRouter());
      server = await listenOnLoopback(app);
    }

    function seedAssociatedReview(prNumber) {
      const info = db.prepare(`
        INSERT INTO reviews (repository, status, review_type, local_path,
                             associated_pr_number, associated_pr_repository)
        VALUES (?, 'draft', 'local', NULL, ?, ?)
      `).run(PR_REPOSITORY, prNumber, PR_REPOSITORY);
      return Number(info.lastInsertRowid);
    }

    beforeEach(() => {
      getLocalRouter()._prDetectionCache.clear();
      getLocalRouter()._hostBindingCache.clear();
      resolveHostBindingCalls.length = 0;
      ghCalls = [];
      vi.spyOn(GitHubClient.prototype, 'fetchPullRequest').mockImplementation(async function (owner, repo, number) {
        ghCalls.push({ owner, repo, number, apiHost: this.apiHost, token: this.token });
        return {
          title: 'Guessed', body: '', author: 'octocat', state: 'open', merged: false,
          base_branch: 'main', head_branch: 'feature', base_sha: 'a', head_sha: 'b',
          html_url: 'https://github.com/owner/repo/pull/1', node_id: 'PR_guess'
        };
      });
    });

    afterEach(async () => {
      if (server) await closeServer(server);
      server = undefined;
      getLocalRouter()._prDetectionCache.clear();
      getLocalRouter()._hostBindingCache.clear();
    });

    it('marks a DUAL repo binding as an ambiguous guess', () => {
      const router = getLocalRouter();
      const binding = router._hostBindingCache.resolveRepositoryBinding(PR_REPOSITORY, dualRepoAssociationConfig());

      // Still the github.com flavour the ambiguity rule picks…
      expect(binding).toMatchObject({ apiHost: null, host: null, token: 'GH_TOKEN' });
      // …but flagged as a guess, so consumers can refuse to persist it.
      expect(binding.hostAmbiguous).toBe(true);
    });

    it('does not mark an exclusive alt-host or a plain github repo', () => {
      const router = getLocalRouter();
      const exclusive = router._hostBindingCache.resolveRepositoryBinding(PR_REPOSITORY, exclusiveRepoConfig());
      const plain = router._hostBindingCache.resolveRepositoryBinding(PR_REPOSITORY, { port: 7247, github_token: 'GH_TOKEN', repos: {} });

      expect(exclusive).toMatchObject({ apiHost: ALT_HOST });
      expect(exclusive.hostAmbiguous).toBeUndefined();
      expect(plain).toMatchObject({ apiHost: null, token: 'GH_TOKEN' });
      expect(plain.hostAmbiguous).toBeUndefined();
    });

    it('GET /api/local/:reviewId/pr-metadata writes no pr_metadata row for a dual repo', async () => {
      await mountRouter(dualRepoAssociationConfig());
      const reviewId = seedAssociatedReview(401);

      const res = await request(server).get(`/api/local/${reviewId}/pr-metadata`);

      expect(res.status).toBe(200);
      // No GitHub call against the guessed host…
      expect(ghCalls).toHaveLength(0);
      // …and, decisively, no row: `getPRHost` still answers "unknown", so
      // PR-mode setup keeps probing instead of pinning github.com.
      const rows = db.prepare('SELECT id, host FROM pr_metadata WHERE pr_number = ?').all(401);
      expect(rows).toHaveLength(0);
      // The pill simply stays hidden — never a 500, never a wrong title.
      expect(res.body.capabilities).toMatchObject({
        hasAssociatedPR: true,
        canShowPRMetadata: false
      });
    });

    it('GET /api/local/:reviewId background warm-up writes no pr_metadata row for a dual repo', async () => {
      await mountRouter(dualRepoAssociationConfig());
      const reviewId = seedAssociatedReview(402);

      const res = await request(server).get(`/api/local/${reviewId}`);

      expect(res.status).toBe(200);
      expect(res.body.capabilities.canShowPRMetadata).toBe(false);
      // The write-through is fire-and-forget, so wait for its own completion
      // signal rather than a duration: a null result records the shared
      // negative memo, which is the last thing that block does.
      await vi.waitFor(() => expect(
        getLocalRouter()._prDetectionCache.isPRDetectionRecentlyNegative(PR_REPOSITORY, 'pr#402')
      ).toBe(true));
      expect(ghCalls).toHaveLength(0);
      expect(db.prepare('SELECT id FROM pr_metadata WHERE pr_number = ?').all(402)).toHaveLength(0);
    });

    it('still serves a row some other path already stamped (cache hit is unaffected)', async () => {
      await mountRouter(dualRepoAssociationConfig());
      const reviewId = seedAssociatedReview(403);
      // A PR-mode session resolved the host properly and cached it.
      db.prepare(`
        INSERT INTO pr_metadata (pr_number, repository, title, author, pr_data, host)
        VALUES (?, ?, 'Real title', 'octocat', ?, ?)
      `).run(403, PR_REPOSITORY, JSON.stringify({
        html_url: 'https://alt.example.com/owner/repo/pull/403', state: 'open', head_sha: 'sha1'
      }), ALT_HOST);

      const res = await request(server).get(`/api/local/${reviewId}/pr-metadata`);

      expect(res.status).toBe(200);
      expect(ghCalls).toHaveLength(0);
      expect(res.body.capabilities.canShowPRMetadata).toBe(true);
      expect(res.body.associatedPR).toMatchObject({ prNumber: 403, title: 'Real title' });
    });
  });
});
