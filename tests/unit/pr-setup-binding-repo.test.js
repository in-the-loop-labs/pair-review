// Copyright 2026 Tim Perkins (tjwp) | SPDX-License-Identifier: Apache-2.0
/**
 * Regression tests for binding-key resolution in PR setup (alt-host /
 * url_pattern monorepo configs).
 *
 * Bug history: routes/setup.js and pr-setup.js looked up tokens and
 * worktree/pool settings using the captured `<owner>/<repo>` PR identity
 * instead of the matched `repos[...]` binding key. For monorepo configs
 * where one binding key serves many captured owner/repo pairs, this
 * silently dropped per-binding settings (path, worktree_directory,
 * pool_size, reset_script) and resolved the wrong token, causing 401s.
 *
 * These tests assert:
 *   1. routes/setup.js — token preflight calls resolveBindingRepositoryFromPR
 *      and feeds the result to getGitHubToken.
 *   2. pr-setup.js findRepositoryPath — config helpers (getRepoPath,
 *      resolveRepoOptions) receive the binding key.
 *   3. pr-setup.js setupPRReview — resolvePoolConfig and getRepoResetScript
 *      receive the binding key.
 *   4. Negative case — when no url_pattern matches, the binding key
 *      equals the PR identity and behaviour is unchanged.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

const fs = require('fs');
const path = require('path');
const configModule = require('../../src/config');

function readSource(relativePath) {
  return fs.readFileSync(path.join(__dirname, '../../', relativePath), 'utf-8');
}

// ---------------------------------------------------------------------------
// Source-level: routes/setup.js + pr-setup.js
// ---------------------------------------------------------------------------

describe('src/routes/setup.js — token preflight uses binding key', () => {
  it('imports resolveBindingRepositoryFromPR from config', () => {
    const src = readSource('src/routes/setup.js');
    expect(src).toMatch(/resolveBindingRepositoryFromPR/);
  });

  it('resolves the binding key before calling getGitHubToken', () => {
    const src = readSource('src/routes/setup.js');
    const bindingPos = src.indexOf('resolveBindingRepositoryFromPR(owner, repo, config)');
    const tokenPos = src.indexOf('getGitHubToken(config, repositoryForToken)');
    expect(bindingPos).toBeGreaterThan(-1);
    expect(tokenPos).toBeGreaterThan(-1);
    expect(bindingPos).toBeLessThan(tokenPos);
  });

  it('passes the binding key down to setupPRReview', () => {
    const src = readSource('src/routes/setup.js');
    expect(src).toMatch(/bindingRepository:\s*repositoryForToken/);
  });

  it('does not fall back to the bare `${owner}/${repo}` literal for token lookup', () => {
    const src = readSource('src/routes/setup.js');
    // The legacy preflight built `${owner}/${repo}` directly and fed
    // it to getGitHubToken. After the fix the binding helper is used.
    expect(src).not.toMatch(/repositoryForToken\s*=\s*`\$\{owner\}\/\$\{repo\}`/);
  });
});

describe('src/setup/pr-setup.js — findRepositoryPath + setupPRReview accept binding key', () => {
  it('findRepositoryPath signature includes bindingRepository', () => {
    const src = readSource('src/setup/pr-setup.js');
    expect(src).toMatch(/async function findRepositoryPath\(\{\s*db,\s*owner,\s*repo,\s*repository,\s*bindingRepository[\s,}]/);
  });

  it('findRepositoryPath uses configKey for getRepoPath and resolveRepoOptions', () => {
    const src = readSource('src/setup/pr-setup.js');
    expect(src).toMatch(/getRepoPath\(config,\s*configKey\)/);
    expect(src).toMatch(/resolveRepoOptions\(config,\s*configKey,\s*repoSettings\)/);
  });

  it('setupPRReview passes bindingRepository to findRepositoryPath', () => {
    const src = readSource('src/setup/pr-setup.js');
    // Match the destructured-args call site within setupPRReview.
    const callBlock = src.match(/await findRepositoryPath\(\{[^}]*\}\)/s);
    expect(callBlock).toBeTruthy();
    expect(callBlock[0]).toMatch(/bindingRepository/);
  });

  it('setupPRReview uses bindingRepository for resolvePoolConfig and getRepoResetScript', () => {
    const src = readSource('src/setup/pr-setup.js');
    expect(src).toMatch(/resolvePoolConfig\(config\s*\|\|\s*\{\},\s*bindingRepository,\s*repoSettings\)/);
    expect(src).toMatch(/getRepoResetScript\(config,\s*bindingRepository\)/);
  });

  it('setupPRReview keeps repoSettingsRepo.getRepoSettings keyed on PR identity (out of scope)', () => {
    const src = readSource('src/setup/pr-setup.js');
    // getRepoSettings remains keyed on `repository` per scope note.
    expect(src).toMatch(/repoSettingsRepo\.getRepoSettings\(repository\)/);
  });

  it('setupPRReview keeps acquireForPR repository field as PR identity (out of scope)', () => {
    const src = readSource('src/setup/pr-setup.js');
    expect(src).toMatch(/acquireForPR\(\s*\{\s*owner,\s*repo,\s*prNumber,\s*repository\s*\}/);
  });
});

// ---------------------------------------------------------------------------
// Runtime: resolveBindingRepositoryFromPR + getGitHubToken end-to-end
// ---------------------------------------------------------------------------

describe('binding-key token resolution — monorepo url_pattern case', () => {
  let originalEnv;

  beforeEach(() => {
    originalEnv = process.env.GITHUB_TOKEN;
    delete process.env.GITHUB_TOKEN;
    configModule._resetTokenCache();
  });

  afterEach(() => {
    if (originalEnv === undefined) {
      delete process.env.GITHUB_TOKEN;
    } else {
      process.env.GITHUB_TOKEN = originalEnv;
    }
    configModule._resetTokenCache();
  });

  it('resolves binding key from url_pattern match (captured owner/repo differs from key)', () => {
    const config = {
      repos: {
        'acme-monorepo': {
          api_host: 'https://ghe.acme.example/api/v3',
          token: 'acme-monorepo-secret',
          url_pattern: '^https://ghe\\.acme\\.example/(?<owner>[^/]+)/(?<repo>[^/]+)/pull/(?<number>\\d+)$',
          features: { stack_walker: 'rest', pending_review_check: 'rest', review_lifecycle: 'rest', pending_review_comments: 'host' }
        }
      }
    };

    // The PR identity ("acme/widget-a") does NOT directly match any
    // `repos[...]` key — it's captured by `acme-monorepo`'s url_pattern.
    const binding = configModule.resolveBindingRepositoryFromPR('acme', 'widget-a', config);
    expect(binding).toBe('acme-monorepo');

    const token = configModule.getGitHubToken(config, binding);
    expect(token).toBe('acme-monorepo-secret');
  });

  it('feeds the binding key (not the captured owner/repo) to getGitHubToken', () => {
    // This is the exact pattern routes/setup.js applies. A bug would
    // pass "acme/widget-a" instead of "acme-monorepo" and would miss
    // the per-binding token.
    const config = {
      // No top-level github_token — only the binding entry has one.
      repos: {
        'acme-monorepo': {
          api_host: 'https://ghe.acme.example/api/v3',
          token: 'acme-monorepo-secret',
          url_pattern: '^https://ghe\\.acme\\.example/(?<owner>[^/]+)/(?<repo>[^/]+)/pull/(?<number>\\d+)$',
          features: { stack_walker: 'rest', pending_review_check: 'rest', review_lifecycle: 'rest', pending_review_comments: 'host' }
        }
      }
    };

    const wrongLookup = configModule.getGitHubToken(config, 'acme/widget-a');
    expect(wrongLookup).toBe('');

    const correctLookup = configModule.getGitHubToken(
      config,
      configModule.resolveBindingRepositoryFromPR('acme', 'widget-a', config)
    );
    expect(correctLookup).toBe('acme-monorepo-secret');
  });

  it('negative case — when no url_pattern matches, binding key equals PR identity', () => {
    const config = {
      github_token: 'top-level-token',
      repos: {}
    };
    const binding = configModule.resolveBindingRepositoryFromPR('alice', 'tool', config);
    expect(binding).toBe('alice/tool');
    // And the lookup path is unchanged: top-level github_token still wins.
    const token = configModule.getGitHubToken(config, binding);
    expect(token).toBe('top-level-token');
  });
});

// ---------------------------------------------------------------------------
// Runtime: setupPRReview / findRepositoryPath route binding key through
// to config helpers via the spied configModule.
// ---------------------------------------------------------------------------

describe('findRepositoryPath — config lookups use the binding key', () => {
  // We capture calls to getRepoPath / resolveRepoOptions via vi.spyOn
  // BEFORE pr-setup.js is loaded so its destructured imports point at
  // the spies. Tests assert call signatures only; the deeper file-system
  // / DB tier checks are already covered by tests/integration/pr-setup.test.js.
  const localReviewModule = require('../../src/local-review');
  vi.spyOn(configModule, 'getRepoPath');
  vi.spyOn(configModule, 'resolveRepoOptions');
  vi.spyOn(localReviewModule, 'findMainGitRoot');
  const { findRepositoryPath } = require('../../src/setup/pr-setup');
  const { GitWorktreeManager } = require('../../src/git/worktree');
  vi.spyOn(GitWorktreeManager.prototype, 'pathExists');

  // Stub a minimal db that returns no repo_settings and no worktree row.
  const stubDb = {};

  beforeEach(() => {
    vi.clearAllMocks();
    configModule.getRepoPath.mockReturnValue(null);
    configModule.resolveRepoOptions.mockReturnValue({
      checkoutScript: null,
      checkoutTimeout: 300000,
      worktreeConfig: null,
      resetScript: null,
      poolSize: 0,
      poolFetchIntervalMinutes: null
    });
    GitWorktreeManager.prototype.pathExists.mockResolvedValue(false);
    localReviewModule.findMainGitRoot.mockResolvedValue(null);

    // Stub the RepositoryRepositories so we don't hit a real DB. We
    // monkey-patch the prototypes here just for the duration of these
    // tests — the spyOn on configModule and pathExists is the load-bearing
    // bit, since we only assert config-helper call signatures.
    const { RepoSettingsRepository, WorktreeRepository } = require('../../src/database');
    vi.spyOn(RepoSettingsRepository.prototype, 'getRepoSettings').mockResolvedValue(null);
    vi.spyOn(WorktreeRepository.prototype, 'findByPR').mockResolvedValue(null);
  });

  it('forwards bindingRepository to getRepoPath and resolveRepoOptions', async () => {
    // The fall-through will eventually try to clone — short-circuit by
    // throwing inside getRepoPath's downstream call. Instead we accept
    // that the function may attempt the Tier-3 path. To prevent that we
    // pre-stub pathExists to return true for the cached clone path so
    // the function returns early at Tier 2.
    const { getConfigDir } = configModule;
    const cachedPath = path.join(getConfigDir(), 'repos', 'acme', 'widget-a');
    GitWorktreeManager.prototype.pathExists.mockImplementation(async (p) => p === cachedPath);

    await findRepositoryPath({
      db: stubDb,
      owner: 'acme',
      repo: 'widget-a',
      repository: 'acme/widget-a',
      bindingRepository: 'acme-monorepo',
      prNumber: 7,
      config: { repos: { 'acme-monorepo': {} } }
    });

    expect(configModule.getRepoPath).toHaveBeenCalledWith(
      expect.any(Object),
      'acme-monorepo'
    );
    expect(configModule.resolveRepoOptions).toHaveBeenCalledWith(
      expect.any(Object),
      'acme-monorepo',
      null
    );
  });

  it('falls back to PR identity when bindingRepository is omitted', async () => {
    const { getConfigDir } = configModule;
    const cachedPath = path.join(getConfigDir(), 'repos', 'alice', 'tool');
    GitWorktreeManager.prototype.pathExists.mockImplementation(async (p) => p === cachedPath);

    await findRepositoryPath({
      db: stubDb,
      owner: 'alice',
      repo: 'tool',
      repository: 'alice/tool',
      prNumber: 1,
      config: { repos: {} }
    });

    expect(configModule.getRepoPath).toHaveBeenCalledWith(
      expect.any(Object),
      'alice/tool'
    );
    expect(configModule.resolveRepoOptions).toHaveBeenCalledWith(
      expect.any(Object),
      'alice/tool',
      null
    );
  });
});
